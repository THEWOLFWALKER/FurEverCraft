import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { createBoundedObserver, type ObserverEvent } from '../../src/bridge/observer/bounded.js';
import { createRawTcpRelay } from '../../src/bridge/relay/raw.js';
import { BridgeService, type HelperMonitor, type ObserverMonitor, type RelayMonitor } from '../../src/bridge/service/orchestrator.js';
import { createRuntime } from '../../src/execution/factory.js';
import { InputArbiter } from '../../src/execution/runtime.js';
import { SessionRuntime } from '../../src/execution/session.js';
import { SQLiteStore } from '../../src/persistence/store.js';
import { ManualClock } from '../../src/contracts/index.js';

const placeCall = (proposalId: string, x: number, y: number) => ({
  id: proposalId,
  name: 'start_skill',
  arguments: JSON.stringify({ skill: 'place_one', x, y, proposalId }),
});

const frame = (payload: number[]) => Buffer.from([payload.length, ...payload]);
const listen = (server: net.Server) => new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
const closeServer = (server: net.Server) => new Promise<void>(resolve => server.close(() => resolve()));
const peer = (port: number) => new Promise<net.Socket>(resolve => {
  const socket = net.createConnection(port, '127.0.0.1', () => resolve(socket));
});

describe('P23 slow observer', () => {
  it('bounds a slow listener queue without blocking raw relay forwarding', async () => {
    // A slow but healthy consumer: dispatch concurrency stays bounded and every frame is delivered
    // once. The relay tap below never waits for it.
    const observer = createBoundedObserver({ maxQueuedFrames: 64, maxQueuedBytes: 8_192, maxConcurrency: 2, taskTimeoutMs: 250 });
    let concurrent = 0;
    let maxConcurrent = 0;
    let delivered = 0;
    observer.subscribe(async () => {
      delivered += 1;
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(resolve => setTimeout(resolve, 3));
      concurrent -= 1;
    });
    observer.attach('client-to-server', Buffer.concat(Array.from({ length: 40 }, (_, index) => frame([index]))));
    for (let attempt = 0; attempt < 200 && delivered < 40; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
    expect(delivered).toBe(40);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(observer.queued().frames).toBe(0);

    // A queue that cannot keep up is explicit global unknown, not a silent skip. Once unknown the
    // observer stops interpreting; relay forwarding is tested separately below.
    const overflow = createBoundedObserver({ maxQueuedFrames: 2, maxQueuedBytes: 1_024, maxConcurrency: 1, taskTimeoutMs: 500 });
    const gaps: ObserverEvent[] = [];
    overflow.subscribe(event => { if (event.kind === 'observer_gap') gaps.push(event); });
    overflow.subscribe(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    overflow.attach('client-to-server', Buffer.concat(Array.from({ length: 10 }, (_, index) => frame([index]))));
    expect(overflow.health).toBe('unknown');
    expect(gaps.some(event => event.kind === 'observer_gap' && event.gap.scope === 'global' && event.gap.reason === 'queue-overflow')).toBe(true);
    await overflow.stop();
    await observer.stop();

    const upstream = net.createServer(socket => socket.on('data', chunk => socket.write(chunk)));
    await listen(upstream);
    const slowTap = createBoundedObserver({ maxQueuedFrames: 4, maxQueuedBytes: 4_096, maxConcurrency: 1, taskTimeoutMs: 250 });
    slowTap.subscribe(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    const relay = createRawTcpRelay({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: (upstream.address() as net.AddressInfo).port,
      allowMinecraftUpstream: true,
      onChunk: (direction, chunk) => slowTap.attach(direction, chunk),
    });
    let client: net.Socket | undefined;
    try {
      await relay.start();
      client = await peer(relay.address.port);
      const payload = Buffer.concat(Array.from({ length: 20 }, (_, index) => frame([index % 251])));
      const reply = new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        client!.on('data', chunk => {
          chunks.push(Buffer.from(chunk));
          if (Buffer.concat(chunks).length >= payload.length) resolve(Buffer.concat(chunks));
        });
        client!.once('error', reject);
      });
      client.write(payload);
      expect(await reply).toEqual(payload);
    } finally {
      client?.destroy();
      await relay.stop();
      await closeServer(upstream);
      await slowTap.stop();
    }
  }, 15_000);

  it('refuses to upgrade an ambiguous effect when the recovery observation has a gap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-p23-gap-'));
    const db = join(dir, 'gap.sqlite');
    const bridge = new FakeClientBridge(12, { faults: { place: { fault: 'drop', count: 1 } } });
    try {
      const first = createRuntime({ db, bridge, clock: new ManualClock() });
      try {
        first.session.start();
        const result = await first.router.invoke(placeCall('gap-ambiguous', 1, 0));
        expect(result.ok).toBe(false);
        expect(first.store.listEffects()).toEqual([expect.objectContaining({ status: 'ambiguous' })]);
        expect(first.store.getExecution('gap-ambiguous')).toMatchObject({ status: 'suspended', outcome: 'ambiguous' });
      } finally {
        first.close();
      }

      // Same world, but the observer now reports a global gap: a gap is not fresh evidence.
      class GapBridge extends FakeClientBridge {
        override snapshot(gap = false) { void gap; return super.snapshot(true); }
      }
      const reopened = createRuntime({ db, bridge: new GapBridge(12), clock: new ManualClock() });
      try {
        const recovery = reopened.session.start();
        expect(recovery.recovered).toBe(true);
        const effect = reopened.store.listEffects()[0]!;
        expect(effect.status).toBe('ambiguous');
        expect(effect.status).not.toBe('confirmed');
        expect(effect.evidence).toMatchObject({ source: 'recovery-observation', error: 'snapshot-gap' });
        expect(reopened.store.getExecution('gap-ambiguous')).not.toMatchObject({ status: 'succeeded' });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('P23 SQLite write failure', () => {
  it('fails closed when effect persistence fails and succeeds again after the fault is removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-p23-sqlite-'));
    const db = join(dir, 'write.sqlite');
    const bridge = new FakeClientBridge();
    const runtime = createRuntime({ db, bridge, clock: new ManualClock() });
    try {
      // A real SQLite write failure at the prepared-effect boundary: nothing may reach the body.
      runtime.store.db.exec("CREATE TRIGGER p23_effect_insert BEFORE INSERT ON effects BEGIN SELECT RAISE(ABORT, 'sqlite-disk-io'); END;");
      const failed = await runtime.router.invoke(placeCall('db-fail-prepare', 1, 0));
      expect(failed.ok).toBe(false);
      expect(String(failed.error)).toContain('sqlite-disk-io');
      expect(bridge.inventory).toBe(8);
      expect(bridge.cell(1, 0)).toBe('free');
      expect(runtime.store.listEffects()).toHaveLength(0);
      expect(runtime.store.getExecution('db-fail-prepare')).toMatchObject({ status: 'failed' });

      runtime.store.db.exec('DROP TRIGGER p23_effect_insert');
      const repaired = await runtime.router.invoke(placeCall('db-repaired', 1, 0));
      expect(repaired.ok).toBe(true);
      expect(bridge.inventory).toBe(7);
      expect(bridge.cell(1, 0)).toBe('blocked');
      expect(runtime.store.getExecution('db-repaired')).toMatchObject({ status: 'succeeded', outcome: 'confirmed' });

      // A failure at the durable may-have-dispatched barrier must abort before input, leaving the
      // effect explicitly prepared-but-not-dispatched rather than ambiguous or confirmed.
      runtime.store.db.exec("CREATE TRIGGER p23_barrier BEFORE UPDATE OF status ON effects WHEN NEW.status = 'may-have-dispatched' BEGIN SELECT RAISE(ABORT, 'sqlite-barrier-io'); END;");
      const barrier = await runtime.router.invoke(placeCall('db-fail-barrier', 0, 1));
      expect(barrier.ok).toBe(false);
      expect(String(barrier.error)).toContain('sqlite-barrier-io');
      expect(bridge.inventory).toBe(7);
      expect(bridge.cell(0, 1)).toBe('free');
      const barrierEffect = runtime.store.listEffects().find(effect => (effect.intent as { x?: number; y?: number }).y === 1)!;
      expect(barrierEffect.status).toBe('prepared');
      expect(barrierEffect.evidence).toMatchObject({ dispatched: false });
      expect(runtime.store.getExecution('db-fail-barrier')).toMatchObject({ status: 'failed' });

      // The store remains usable for an unrelated durable write and closes cleanly after failures.
      runtime.store.saveGoal({ goalId: 'after-failures', revision: 1, status: 'active', text: 'still alive' });
      expect(runtime.store.getGoal('after-failures')).toMatchObject({ revision: 1, status: 'active' });
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('leaves an unknown effect unknown when recovery cannot persist its re-observation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-p23-recovery-'));
    const db = join(dir, 'recovery.sqlite');
    const bridge = new FakeClientBridge();
    const store = new SQLiteStore(db);
    try {
      store.saveExecution({
        executionId: 'exec-recovery-fail', proposalId: 'proposal-recovery-fail', proposalHash: 'hash',
        goalId: 'g-recovery', skillId: 'place_one', skillVersion: '1.0.0', status: 'suspended',
      });
      store.addEffect({
        effectId: 'effect-recovery-fail', executionId: 'exec-recovery-fail', context: bridge.context,
        status: 'may-have-dispatched', intent: { kind: 'place', x: 1, y: 0 },
      });
      store.db.exec("CREATE TRIGGER p23_recovery BEFORE UPDATE ON effects BEGIN SELECT RAISE(ABORT, 'sqlite-recovery-io'); END;");
      const session = new SessionRuntime(bridge, store, { maxRecoveryAttempts: 2 });
      expect(() => session.start()).toThrow('sqlite-recovery-io');
      expect(session.state).toBe('recoverable-failure');
      // The failed write leaves the durable record unknown; it is never silently turned into success.
      expect(store.getEffect('effect-recovery-fail')).toMatchObject({ status: 'may-have-dispatched' });

      store.db.exec('DROP TRIGGER p23_recovery');
      const recovered = session.recover();
      expect(recovered.recovered).toBe(true);
      const reconciled = store.getEffect('effect-recovery-fail')!;
      expect(reconciled.status).toBe('ambiguous');
      expect(reconciled.evidence).toMatchObject({ source: 'recovery-observation' });
      expect(store.getExecution('exec-recovery-fail')).not.toMatchObject({ status: 'succeeded' });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P23 goal race and lease revival', () => {
  it('rejects a write when the goal revision changes during execution and never revives an expired lease', async () => {
    let store: SQLiteStore | undefined;
    let raced = false;
    class RacingBridge extends FakeClientBridge {
      override cell(x: number, y: number) {
        if (store && !raced) {
          raced = true;
          // Simulate another controller revising the goal after admission but before dispatch.
          store.reviseGoal('goal-race', 1, 'target changed during execution');
        }
        return super.cell(x, y);
      }
    }
    const bridge = new RacingBridge();
    const runtime = createRuntime({ bridge, clock: new ManualClock() });
    store = runtime.store;
    try {
      runtime.store.saveGoal({ goalId: 'goal-race', revision: 1, status: 'active', text: 'original target' });
      const racedResult = await runtime.router.invoke(placeCall('goal-race-1', 1, 0), { goalId: 'goal-race', goalRevision: 1 });
      expect(racedResult.ok).toBe(false);
      expect(String(racedResult.error)).toContain('goal-revision-conflict');
      expect(bridge.inventory).toBe(8);
      expect(bridge.cell(1, 0)).toBe('free');
      const effect = runtime.store.listEffects()[0]!;
      expect(effect.status).toBe('prepared');
      expect(effect.evidence).toMatchObject({ dispatched: false });
      expect(runtime.store.getExecution('goal-race-1')).toMatchObject({ status: 'failed' });
      expect(runtime.store.getExecution('goal-race-1')?.reason).toContain('goal-revision-conflict');
      expect(runtime.store.getGoal('goal-race')?.revision).toBe(2);

      const stale = await runtime.router.invoke(placeCall('goal-race-2', 1, 0), { goalId: 'goal-race', goalRevision: 1 });
      expect(stale.ok).toBe(false);
      expect(String(stale.error)).toContain('goal-revision-conflict');
      // The stale request is rejected before an execution/effect row or body input exists.
      expect(runtime.store.listExecutions()).toHaveLength(1);
      expect(runtime.store.listEffects()).toHaveLength(1);

      // Lease generations: an expired old lease cannot be validated after a new owner acquires the
      // same resource, and a late finalizer cannot release the new owner's lease.
      const clock = new ManualClock();
      const arbiter = new InputArbiter(() => clock.now(), () => 'ctx:1');
      const oldLease = arbiter.acquire('old-owner', ['movement'], 5);
      clock.advance(6);
      const newLease = arbiter.acquire('new-owner', ['movement'], 5);
      expect(() => arbiter.validate(oldLease.leaseId, 'old-owner')).toThrow('lease-invalid');
      arbiter.release(oldLease.leaseId, 'old-owner');
      expect(arbiter.validate(newLease.leaseId, 'new-owner').owner).toBe('new-owner');
    } finally {
      runtime.close();
    }
  });

  it('unions relay crash, observer failure and IPC saturation into one bounded, revoked state', async () => {
    class FakeRelay implements RelayMonitor {
      state = 'stopped';
      pid = 100;
      starts = 0;
      private readonly exits = new Set<(reason: string) => void>();
      async start(): Promise<void> { this.starts += 1; this.state = 'running'; }
      async stop(): Promise<void> { this.state = 'stopped'; }
      onExit(listener: (reason: string) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
      emitExit(reason: string): void { for (const listener of this.exits) listener(reason); }
    }
    class FakeObserver implements ObserverMonitor {
      started = 0;
      stopped = 0;
      private readonly failures = new Set<(reason: string) => void>();
      start(): void { this.started += 1; }
      async stop(): Promise<void> { this.stopped += 1; }
      state(): unknown { return { running: this.started > this.stopped }; }
      onFailure(listener: (reason: string) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }
      fail(reason: string): void { for (const listener of this.failures) listener(reason); }
    }
    class FakeHelper implements HelperMonitor {
      releases = 0;
      shutdowns = 0;
      async shutdown(): Promise<void> { this.shutdowns += 1; }
      async releaseOwnedInputs(): Promise<unknown> { this.releases += 1; return { released: true }; }
    }

    const relay = new FakeRelay();
    const observer = new FakeObserver();
    const helper = new FakeHelper();
    const fatals: string[] = [];
    const events: string[] = [];
    let accept = false;
    const service = new BridgeService({
      relay, observer, helper,
      ipc: { send: () => accept },
      maxIpcMessages: 2,
      maxRestarts: 1,
      restartWindowMs: 60_000,
      backoffBaseMs: 1,
      sleep: async () => undefined,
      shutdownGraceMs: 50,
      onFatal: reason => fatals.push(reason),
      onEvent: event => events.push(event.type),
    });
    try {
      await service.start();
      service.armControl('fresh-observation');
      expect(service.status()).toMatchObject({ admissionOpen: true, controlRevoked: false });

      // Saturate the parent queue while the observer is slow/failing and the relay dies.
      for (let index = 0; index < 40; index += 1) service.publishObserver({ kind: 'observation', frameSequence: String(index) });
      observer.fail('observer-slow-consumer');
      relay.emitExit('unexpected-exit');
      for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve));

      const afterCrash = service.status();
      expect(relay.starts).toBe(2);
      expect(afterCrash).toMatchObject({ admissionOpen: false, controlRevoked: true, restarts: { attempts: 1, max: 1 } });
      expect(helper.releases).toBeGreaterThanOrEqual(1);
      expect(afterCrash.ipc.messages).toBeLessThanOrEqual(2);
      expect(afterCrash.ipc.globalUnknown).toBe(true);
      expect(events).toContain('observer-failure');
      expect(events).toContain('control-revoked');

      // A restart is not fresh observation evidence: admission stays closed until an operator arm.
      expect(afterCrash.admissionOpen).toBe(false);
      observer.fail('observer-still-broken');
      relay.emitExit('unexpected-exit');
      for (let index = 0; index < 20; index += 1) await new Promise(resolve => setImmediate(resolve));
      expect(fatals).toEqual(['restart-budget-exhausted']);
      expect(service.state).toBe('failed');
      expect(service.controlRevoked).toBe(true);

      accept = true;
      service.flush();
      expect(service.status().ipc).toMatchObject({ messages: 0, bytes: 0 });
      await service.stop('fault-shutdown');
      expect(service.state).toBe('stopped');
      expect(observer.stopped).toBe(1);
      expect(helper.shutdowns).toBe(1);
    } finally {
      await service.stop('test-cleanup').catch(() => undefined);
    }
  });
});
