import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { BridgeService, type HelperMonitor, type ObserverMonitor, type RelayMonitor } from '../../src/bridge/service/orchestrator.js';
import { createRuntime } from '../../src/execution/factory.js';
import { InputArbiter, Executor, leaseContextEpoch } from '../../src/execution/runtime.js';
import { SessionRuntime } from '../../src/execution/session.js';
import { SQLiteStore } from '../../src/persistence/store.js';
import { SkillLifecycle } from '../../src/skills/lifecycle.js';
import { ManualClock, type BodyContext } from '../../src/contracts/index.js';
import { waitForCondition } from '../../src/skills/skills.js';
import { memoryScopeOf } from '../../src/agent/router.js';
import { createSimulatedBodyAdapter } from '../../src/fixtures/body-adapter.js';
import { canonicalPayloadHash } from '../../src/control/service.js';

const placeCall = (proposalId: string, x: number, y: number) => ({
  id: proposalId,
  name: 'start_skill',
  arguments: JSON.stringify({ skill: 'place_one', x, y, proposalId }),
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

class FakeRelay implements RelayMonitor {
  state = 'stopped';
  pid = 111;
  starts = 0;
  stops = 0;
  forceStops = 0;
  stopHangs = false;
  private readonly exits = new Set<(reason: string) => void>();
  async start(): Promise<void> { this.starts += 1; this.state = 'running'; }
  async stop(): Promise<void> { this.stops += 1; if (this.stopHangs) await new Promise<void>(() => undefined); this.state = 'stopped'; }
  forceStop(): void { this.forceStops += 1; this.state = 'stopped'; }
  onExit(listener: (reason: string) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
  emitExit(reason: string): void { for (const listener of this.exits) listener(reason); }
}

class FakeObserver implements ObserverMonitor {
  started = 0;
  stopped = 0;
  start(): void { this.started += 1; }
  async stop(): Promise<void> { this.stopped += 1; }
  state(): unknown { return { running: this.started > this.stopped }; }
}

class FakeHelper implements HelperMonitor {
  releases = 0;
  shutdowns = 0;
  forceStops = 0;
  private readonly exits = new Set<(reason: string) => void>();
  async shutdown(): Promise<void> { this.shutdowns += 1; }
  async releaseOwnedInputs(): Promise<unknown> { this.releases += 1; return { released: true }; }
  forceStop(): void { this.forceStops += 1; }
  onExit(listener: (reason: string) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
  emitExit(reason: string): void { for (const listener of this.exits) listener(reason); }
}

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'furevercraft-round2-'));
  return { dir, db: join(dir, 'state.sqlite') };
};

describe('Round 2 — stop is terminal and cannot be undone by pause', () => {
  it('keeps stopping set when a pause arrives after stop, so resume stays rejected', async () => {
    const runtime = createRuntime({ clock: new ManualClock() });
    try {
      const stopped = await runtime.control.command({ requestId: 'stop-1', command: 'stop', payload: {} });
      expect(stopped.state).toBe('accepted');
      expect(runtime.control.status()).toMatchObject({ stopping: true, paused: true });

      const paused = await runtime.control.command({ requestId: 'pause-after-stop', command: 'pause', payload: {} });
      expect(paused.state).toBe('terminal');
      // A stop that already landed wins: pause must not reopen the lifecycle.
      expect(runtime.control.status()).toMatchObject({ stopping: true, paused: true });

      const resume = await runtime.control.command({ requestId: 'resume-after-stop', command: 'resume', payload: {} });
      expect(resume).toMatchObject({ state: 'rejected', code: 'stopping' });
      const message = await runtime.control.command({ requestId: 'message-after-stop', command: 'message', payload: { text: 'should not run' } });
      expect(message.state).toBe('rejected');
      expect(runtime.control.status()).toMatchObject({ stopping: true, paused: true });
    } finally { runtime.close(); }
  }, 15_000);
});

describe('Round 2 — bridge control loss reaches admission and active work', () => {
  it('closes admission before arming, cancels in-flight work on helper exit, and blocks new writes', async () => {
    const relay = new FakeRelay();
    const observer = new FakeObserver();
    const helper = new FakeHelper();
    const service = new BridgeService({
      relay, observer, helper,
      maxRestarts: 1, backoffBaseMs: 1, sleep: async () => undefined,
      shutdownGraceMs: 200,
    });
    const bridge = new FakeClientBridge();
    const runtime = createRuntime({ bridge, bridgeService: { service }, clock: new ManualClock() });
    try {
      await runtime.startBridgeService!();
      expect(service.state).toBe('running');

      // The service starts with control revoked; that must be enforced, not just reported.
      const beforeArm = await runtime.router.invoke(placeCall('before-arm', 1, 0));
      expect(beforeArm).toMatchObject({ ok: false, error: 'control-revoked' });
      expect(bridge.inventory).toBe(8);
      expect(bridge.cell(1, 0)).toBe('free');

      service.armControl('fresh-observation');
      const armed = await runtime.router.invoke(placeCall('after-arm', 1, 0));
      expect(armed.ok).toBe(true);

      // A long wait stands in for any in-flight body work; helper death must cancel it promptly
      // and leave the runtime unable to start another body write until explicit re-arm.
      const pending = runtime.router.invoke({
        id: 'wait-crash', name: 'start_skill',
        arguments: JSON.stringify({ skill: 'wait_for_condition', ms: 3_600_000, proposalId: 'wait-crash' }),
      });
      for (let attempt = 0; attempt < 100 && runtime.store.getExecution('wait-crash') === undefined; attempt += 1) await tick();
      expect(runtime.store.getExecution('wait-crash')?.status).toBe('running');

      helper.emitExit('helper-crash');
      const waitResult = await Promise.race([
        pending,
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 2_000)),
      ]);
      expect(waitResult).not.toBe('timeout');
      expect((waitResult as { ok: boolean }).ok).toBe(false);
      expect(runtime.store.getExecution('wait-crash')?.status).not.toBe('running');
      expect(runtime.store.getExecution('wait-crash')?.status).not.toBe('verifying');
      await tick();

      const afterCrash = await runtime.router.invoke(placeCall('after-crash', 0, 1));
      expect(afterCrash).toMatchObject({ ok: false, error: 'control-revoked' });
      expect(bridge.cell(0, 1)).toBe('free');
      expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true });
    } finally {
      runtime.close();
    }
  }, 20_000);
});

describe('Round 2 — crash-restart execution settlement', () => {
  it('suspends in-flight executions left by a previous process instead of leaving them running', () => {
    const { dir, db } = tempDb();
    try {
      const seed = new SQLiteStore(db);
      seed.saveExecution({ executionId: 'exec-crash', proposalId: 'prop-crash', proposalHash: 'h', goalId: 'g', skillId: 'place_one', skillVersion: '1.0.0', status: 'running' });
      seed.addEffect({ effectId: 'effect-crash', executionId: 'exec-crash', context: new FakeClientBridge().context, status: 'may-have-dispatched', intent: { kind: 'place', x: 1, y: 0 } });
      seed.close();

      const runtime = createRuntime({ db, clock: new ManualClock() });
      try {
        const recovery = runtime.session.start();
        expect(recovery.reconciled).toEqual([{ effectId: 'effect-crash', status: 'ambiguous' }]);
        expect(recovery.suspendedExecutions).toContain('exec-crash');
        expect(runtime.store.getExecution('exec-crash')).toMatchObject({
          status: 'suspended', outcome: 'ambiguous', reason: 'recovered-after-restart',
        });
        // The effect stayed ambiguous; settlement of the execution is not a success claim.
        expect(runtime.store.getEffect('effect-crash')?.status).toBe('ambiguous');
      } finally { runtime.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never suspends an execution this process is actively driving', () => {
    const store = new SQLiteStore(':memory:');
    try {
      store.saveExecution({ executionId: 'exec-active', proposalId: 'prop-active', proposalHash: 'h1', goalId: 'g', skillId: 'wait_for_condition', skillVersion: '1.0.0', status: 'running' });
      store.saveExecution({ executionId: 'exec-stale', proposalId: 'prop-stale', proposalHash: 'h2', goalId: 'g', skillId: 'wait_for_condition', skillVersion: '1.0.0', status: 'verifying' });
      new SessionRuntime(new FakeClientBridge(), store, { isExecutionActive: id => id === 'exec-active' }).start();
      expect(store.getExecution('exec-active')?.status).toBe('running');
      expect(store.getExecution('exec-stale')).toMatchObject({ status: 'suspended', outcome: 'ambiguous' });
    } finally { store.close(); }
  });

  it('settles receipts left pending by a dead process as unknown instead of replaying accepted', async () => {
    const { dir, db } = tempDb();
    try {
      const first = createRuntime({ db, clock: new ManualClock() });
      const payloadHash = canonicalPayloadHash({ command: 'goal.set', payload: { goalId: 'goal-receipt', text: 'crash window' } });
      first.store.addActionReceipt({
        receiptId: 'receipt-crash', scope: 'control:simulated', commandId: 'receipt-crash', status: 'pending', payloadHash,
      });
      first.close();

      const reopened = createRuntime({ db, clock: new ManualClock() });
      try {
        expect(reopened.store.getActionReceipt('control:simulated', 'receipt-crash')).toMatchObject({ status: 'unknown' });
        const replay = await reopened.control.command({ requestId: 'receipt-crash', command: 'goal.set', payload: { goalId: 'goal-receipt', text: 'crash window' } });
        expect(replay.state).toBe('unknown');
        // The command is not re-executed and no new work is claimed.
        expect(reopened.store.listGoals()).toHaveLength(0);
      } finally { reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Round 2 — account isolation', () => {
  it('does not reconcile another account\'s pending effect in the same world and dimension', () => {
    const { dir, db } = tempDb();
    const base: BodyContext = { serverProfileId: 'simulated', accountId: 'account-a', worldGenerationId: 'world-1', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };
    try {
      const seed = new SQLiteStore(db);
      seed.saveExecution({ executionId: 'exec-a', proposalId: 'prop-a', proposalHash: 'h', goalId: 'g', skillId: 'place_one', skillVersion: '1.0.0', status: 'running' });
      seed.addEffect({ effectId: 'effect-a', executionId: 'exec-a', context: base, status: 'may-have-dispatched', intent: { kind: 'place', x: 1, y: 0 } });
      seed.close();

      const otherAccount = new FakeClientBridge(12, { context: { ...base, accountId: 'account-b' } });
      otherAccount.block(1, 0);
      const runtime = createRuntime({ db, bridge: otherAccount, clock: new ManualClock() });
      try {
        const recovery = runtime.session.start();
        expect(recovery.reconciled).toEqual([]);
        expect(runtime.store.getEffect('effect-a')).toMatchObject({ status: 'may-have-dispatched' });
        expect(runtime.store.getEffect('effect-a')?.evidence).toBeUndefined();
        // A foreign account's execution is not ours to suspend either.
        expect(runtime.store.getExecution('exec-a')?.status).toBe('running');
      } finally { runtime.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('includes account, dimension and epochs in the lease fencing key', () => {
    const base: BodyContext = { serverProfileId: 's', accountId: 'a', worldGenerationId: 'w', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };
    const initial = leaseContextEpoch(base);
    expect(leaseContextEpoch({ ...base, dimension: 'the_nether' })).not.toBe(initial);
    expect(leaseContextEpoch({ ...base, accountId: 'b' })).not.toBe(initial);
    expect(leaseContextEpoch({ ...base, serverProfileId: 'other' })).not.toBe(initial);

    const clock = new ManualClock();
    let context = { ...base };
    const arbiter = new InputArbiter(() => clock.now(), () => leaseContextEpoch(context));
    const lease = arbiter.acquire('owner', ['movement'], 100);
    context = { ...context, dimension: 'the_nether' };
    expect(() => arbiter.validate(lease.leaseId, 'owner')).toThrow('lease-invalid');
  });

  it('carries accountId into the durable memory scope and rejects a mismatched body adapter', () => {
    const base: BodyContext = { serverProfileId: 'simulated', accountId: 'account-a', worldGenerationId: 'world-1', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };
    expect(memoryScopeOf(base)).toEqual({
      serverProfileId: 'simulated', accountId: 'account-a', worldGenerationId: 'world-1', dimensionId: 'overworld',
    });
    const clock = new ManualClock();
    const adapter = createSimulatedBodyAdapter({ ...base, accountId: 'account-a' }, clock);
    const bridge = new FakeClientBridge(12, { context: { ...base, accountId: 'account-b' } });
    expect(() => createRuntime({ profile: 'simulated', bridge, bodyAdapter: adapter, clock })).toThrow('body-adapter-context-mismatch:accountId');
  });
});

describe('Round 2 — cancellation clears waiting timers', () => {
  it('resolves a scheduled wait as canceled on abort and never fires its deadline later', async () => {
    const clock = new ManualClock();
    const controller = new AbortController();
    const stages: string[] = [];
    const result = Promise.resolve(waitForCondition({
      bridge: new FakeClientBridge(),
      lease: { leaseId: 'l', owner: 'e', resources: [], until: 1, generation: 1, contextEpoch: '' },
      report: progress => { stages.push(progress.stage); },
      clock,
      signal: controller.signal,
    }, 3_600_000));
    controller.abort();
    await expect(result).resolves.toMatchObject({ ok: false, outcome: 'canceled' });
    clock.advance(3_600_000);
    // The canceled wait must not report verify/confirmed after the fact.
    expect(stages).toEqual(['dispatch']);
  });

  it('pause cancels a long wait_for_condition instead of waiting for its deadline', async () => {
    const runtime = createRuntime({ clock: new ManualClock() });
    try {
      const pending = runtime.router.invoke({
        id: 'long-wait', name: 'start_skill',
        arguments: JSON.stringify({ skill: 'wait_for_condition', ms: 3_600_000, proposalId: 'long-wait' }),
      });
      for (let attempt = 0; attempt < 100 && runtime.store.getExecution('long-wait') === undefined; attempt += 1) await tick();
      expect(runtime.store.getExecution('long-wait')?.status).toBe('running');
      const started = Date.now();
      const pause = await runtime.control.command({ requestId: 'pause-long-wait', command: 'pause', payload: {} });
      expect(pause.state).toBe('terminal');
      const result = await Promise.race([
        pending,
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 2_000)),
      ]);
      expect(result).not.toBe('timeout');
      expect((result as { ok: boolean }).ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(['canceled', 'failed']).toContain(runtime.store.getExecution('long-wait')?.status);
    } finally { runtime.close(); }
  }, 15_000);
});

describe('Round 2 — forced shutdown deadline', () => {
  it('escalates to the monitor force stop when graceful shutdown exceeds the deadline', async () => {
    const relay = new FakeRelay();
    relay.stopHangs = true;
    const helper = new FakeHelper();
    const service = new BridgeService({ relay, helper, shutdownGraceMs: 25 });
    await service.start();
    const started = Date.now();
    await service.stop('deadline');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(service.status().shutdown.forced).toBe(true);
    expect(relay.forceStops).toBe(1);
    expect(service.state).toBe('stopped');
  });
});

describe('Round 2 — lifecycle state retention stays bounded', () => {
  it('bounds retained finished skill runs and per-execution progress', async () => {
    const lifecycle = new SkillLifecycle();
    for (let index = 0; index < 300; index += 1) {
      await lifecycle.run('observe_ui', () => ({ ok: true, outcome: 'confirmed' as const }));
    }
    expect(lifecycle.list().length).toBeLessThanOrEqual(256);

    const store = new SQLiteStore(':memory:');
    try {
      const clock = new ManualClock();
      const executor = new Executor(new FakeClientBridge(), store, undefined, { clock });
      for (let index = 0; index < 520; index += 1) {
        await executor.start('g', 'observe_ui', { proposalId: `progress-${index}` }, () => ({ outcome: 'confirmed' as const }));
      }
      const retained = (executor as unknown as { progressByExecution: Map<string, unknown> }).progressByExecution.size;
      expect(retained).toBeLessThanOrEqual(512);
    } finally { store.close(); }
  }, 20_000);
});
