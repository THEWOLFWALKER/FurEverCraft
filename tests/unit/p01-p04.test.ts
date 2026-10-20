import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ManualClock, type BodyContext } from '../../src/contracts/index.js';
import { createRuntime } from '../../src/execution/factory.js';
import { ExecutionAdmission } from '../../src/execution/admission.js';
import { Executor } from '../../src/execution/runtime.js';
import { SessionRuntime } from '../../src/execution/session.js';
import { RuntimeOwnershipLock } from '../../src/execution/ownership.js';
import { SQLiteStore } from '../../src/persistence/store.js';

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'furevercraft-p01-p04-'));
  return { dir, db: join(dir, 'state.sqlite') };
};

const cleanupDirs: string[] = [];
const allocation = () => {
  const created = tempDb();
  cleanupDirs.push(created.dir);
  return created;
};
afterEach(() => { for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const placeCall = (proposalId: string) => ({
  id: proposalId,
  name: 'start_skill',
  arguments: JSON.stringify({ skill: 'place_one', x: 1, y: 0, proposalId }),
});

describe('P04 RuntimeOwnershipLock', () => {
  it('creates the lock atomically and refuses a second owner without deleting it', () => {
    const { db } = allocation();
    const first = new RuntimeOwnershipLock(db);
    const record = first.acquire();
    expect(record).toMatchObject({ pid: process.pid, hostname: hostname(), runtimeId: first.runtimeId });
    expect(JSON.parse(readFileSync(first.lockPath, 'utf8'))).toMatchObject({ runtimeId: first.runtimeId });

    const second = new RuntimeOwnershipLock(db);
    expect(() => second.acquire()).toThrow('runtime-control-owned');
    expect(second.release()).toBe(false);
    expect(existsSync(first.lockPath)).toBe(true);
    expect(first.release()).toBe(true);
    expect(existsSync(first.lockPath)).toBe(false);
  });

  it('only releases the record it wrote, never a replacement owner', () => {
    const { db } = allocation();
    const first = new RuntimeOwnershipLock(db);
    first.acquire();
    writeFileSync(first.lockPath, JSON.stringify({
      pid: process.pid, hostname: hostname(), createdAt: Date.now(), epoch: 'replacement:1', runtimeId: 'replacement',
    }));
    expect(first.release()).toBe(false);
    expect(JSON.parse(readFileSync(first.lockPath, 'utf8')).runtimeId).toBe('replacement');
  });

  it('refuses an unreadable or unknown lock instead of deleting it', () => {
    const { db } = allocation();
    const lock = new RuntimeOwnershipLock(db);
    writeFileSync(lock.lockPath, '{not-json');
    expect(() => lock.acquire()).toThrow('runtime-control-owned');
    expect(readFileSync(lock.lockPath, 'utf8')).toBe('{not-json');
    writeFileSync(lock.lockPath, JSON.stringify({ pid: 1, hostname: hostname(), createdAt: 0, epoch: 'unknown', runtimeId: 'unknown' }));
    expect(() => lock.acquire()).toThrow('runtime-control-owned');
    expect(existsSync(lock.lockPath)).toBe(true);
  });

  it('reclaims a lock whose recorded process is demonstrably dead', () => {
    const { db } = allocation();
    const exited = spawnSync(process.execPath, ['-e', '']);
    expect(exited.pid).toBeGreaterThan(0);
    const lock = new RuntimeOwnershipLock(db);
    writeFileSync(lock.lockPath, JSON.stringify({
      pid: exited.pid, hostname: hostname(), createdAt: Date.now(), epoch: 'dead:1', runtimeId: 'dead-owner',
    }));
    expect(lock.acquire().pid).toBe(process.pid);
    expect(lock.release()).toBe(true);
  });

  it('contends with a real second process and recovers after it is killed', async () => {
    const { dir, db } = allocation();
    // Compile the real lock implementation to a standalone ESM module so the competing owner is
    // an actual separate OS process, not a second object in the test process.
    const source = readFileSync(new URL('../../src/execution/ownership.ts', import.meta.url), 'utf8');
    const compiled = transpileModule(source, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
      fileName: 'ownership.ts',
    }).outputText;
    writeFileSync(join(dir, 'ownership.mjs'), compiled);
    writeFileSync(join(dir, 'holder.mjs'), [
      "import { RuntimeOwnershipLock } from './ownership.mjs';",
      'const lock = new RuntimeOwnershipLock(process.argv[2]);',
      'lock.acquire();',
      "process.stdout.write('ACQUIRED\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n'));

    const child = spawn(process.execPath, [join(dir, 'holder.mjs'), db], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`child did not acquire the lock: ${output}`)), 10_000);
        child.stdout.on('data', chunk => {
          output += String(chunk);
          if (output.includes('ACQUIRED')) { clearTimeout(timer); resolve(); }
        });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        void exited.then(() => { clearTimeout(timer); reject(new Error(`child exited before acquiring: ${output}`)); });
      });

      const contender = new RuntimeOwnershipLock(db);
      expect(() => contender.acquire()).toThrow('runtime-control-owned');

      // A crash leaves a stale record. The next owner may only reclaim it after the OS reports
      // the recorded PID dead, and the replacement must be the one that now holds the lock.
      child.kill('SIGKILL');
      await exited;
      const replacement = new RuntimeOwnershipLock(db);
      expect(replacement.acquire()).toMatchObject({ pid: process.pid, runtimeId: replacement.runtimeId });
      expect(replacement.release()).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }, 20_000);
});

describe('P02 runtime assembly', () => {
  it('fails closed when client-offline has no real body', () => {
    expect(() => createRuntime({ profile: 'client-offline' })).toThrow('client-offline-body-unavailable');
  });

  it('never substitutes a fake body for the client-offline profile', () => {
    expect(() => createRuntime({ profile: 'client-offline', body: new FakeClientBridge() })).toThrow('client-offline-requires-real-body');
  });

  it('exposes the explicit dependency container and one runtime owner', () => {
    const runtime = createRuntime({ clock: new ManualClock() });
    try {
      expect(runtime.dependencies.body).toBe(runtime.bridge);
      expect(runtime.dependencies.store).toBe(runtime.store);
      expect(runtime.dependencies.clock).toBe(runtime.clock);
      expect(runtime.dependencies.events).toBe(runtime.session.events);
      expect(runtime.dependencies.provider).toBe(runtime.provider);
      expect(typeof runtime.dependencies.nav.navigate).toBe('function');
      expect(runtime.ownerId).toBe(runtime.session.ownerId);
      expect(runtime.inputsEnabled).toBe(true);
    } finally { runtime.close(); }
  });

  it('performs no body input when inputs are disabled', async () => {
    const bridge = new FakeClientBridge();
    const runtime = createRuntime({ bridge, inputsEnabled: false, clock: new ManualClock() });
    try {
      const result = await runtime.router.invoke(placeCall('input-off'));
      expect(result).toMatchObject({ ok: false, error: 'input-disabled' });
      expect(bridge.inventory).toBe(8);
      expect(bridge.cell(1, 0)).toBe('free');
      expect(runtime.store.listEffects()).toHaveLength(0);
      expect(runtime.store.listExecutions()).toHaveLength(0);
    } finally { runtime.close(); }
  });

  it('rejects input-disabled execution before lease, effect or sink use', async () => {
    const store = new SQLiteStore(':memory:');
    const bridge = new FakeClientBridge();
    let invoked = 0;
    try {
      const executor = new Executor(bridge, store, undefined, { inputsEnabled: () => false });
      const execution = await executor.start('g', 'place_one', { proposalId: 'disabled-exec' }, () => {
        invoked += 1;
        return { outcome: 'confirmed' as const };
      });
      expect(invoked).toBe(0);
      expect(execution).toMatchObject({ status: 'failed', reason: 'input-disabled' });
      expect(store.listEffects()).toHaveLength(0);
      expect(bridge.inventory).toBe(8);
    } finally { store.close(); }
  });

  it('keeps one owner per persistent storage path', () => {
    const { db } = allocation();
    const first = createRuntime({ db, clock: new ManualClock() });
    try {
      expect(first.ownership?.held).toBe(true);
      expect(() => createRuntime({ db })).toThrow('runtime-control-owned');
    } finally { first.close(); }
    const reopened = createRuntime({ db, clock: new ManualClock() });
    try {
      expect(reopened.ownership?.held).toBe(true);
      expect(reopened.store.listGoals()).toEqual([]);
    } finally { reopened.close(); }
  });

  it('defaults client-offline real bodies to disabled input', async () => {
    const context: BodyContext = {
      serverProfileId: 'client-offline-env', worldGenerationId: 'world-live', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld',
    };
    class LiveBody {
      readonly context = context;
      readonly size = 12;
      position = { x: 0, y: 0 };
      inventory = 8;
      snapshot() { return { context, revision: '0', position: { ...this.position }, cells: {}, inventory: this.inventory, ui: 'gameplay' as const, source: 'observed-server' as const, freshness: 'current' as const, gap: false, fields: {} }; }
      cell() { return 'free' as const; }
      walk() { /* injection seam */ }
      place() { this.inventory -= 1; return { accepted: true, commandId: 'live-place', seq: 0 }; }
      setUi() { /* injection seam */ }
    }
    const body = new LiveBody();
    const runtime = createRuntime({ profile: 'client-offline', body, clock: new ManualClock() });
    try {
      expect(runtime.inputsEnabled).toBe(false);
      const result = await runtime.router.invoke(placeCall('client-offline-input'));
      expect(result).toMatchObject({ ok: false, error: 'input-disabled' });
      expect(body.inventory).toBe(8);
    } finally { runtime.close(); }
  });
});

describe('P03 execution and effect boundary', () => {
  it('rejects a stale goal revision before any effect or body action', async () => {
    const bridge = new FakeClientBridge();
    const runtime = createRuntime({ bridge, clock: new ManualClock() });
    try {
      runtime.store.saveGoal({ goalId: 'goal-p03', revision: 1, status: 'active', text: 'place' });
      const result = await runtime.router.invoke(placeCall('stale-goal'), { goalId: 'goal-p03', goalRevision: 0 });
      expect(result).toMatchObject({ ok: false, error: 'goal-revision-conflict' });
      expect(bridge.inventory).toBe(8);
      expect(runtime.store.listEffects()).toHaveLength(0);
      expect(runtime.store.listExecutions()).toHaveLength(0);
    } finally { runtime.close(); }
  });

  it('rejects a stale owner at admission', async () => {
    const bridge = new FakeClientBridge();
    const runtime = createRuntime({ bridge, clock: new ManualClock() });
    try {
      const result = await runtime.router.invoke(placeCall('stale-owner'), { owner: 'previous-boot-epoch' });
      expect(result).toMatchObject({ ok: false, error: 'owner-mismatch' });
      expect(bridge.inventory).toBe(8);
      expect(runtime.store.listEffects()).toHaveLength(0);
    } finally { runtime.close(); }
  });

  it('fences an epoch change even when the body mutates its context in place', () => {
    const store = new SQLiteStore(':memory:');
    const bridge = new FakeClientBridge();
    const admission = new ExecutionAdmission(store, bridge, 'owner-1', () => true);
    try {
      const captured = { ...bridge.context };
      bridge.context.connectionEpoch = '2';
      expect(admission.check({ skillId: 'place_one', context: captured })).toMatchObject({ ok: false, code: 'epoch-changed' });
    } finally { store.close(); }
  });

  it('persists prepared before dispatch and keeps the barrier evidence on confirmation', async () => {
    const bridge = new FakeClientBridge();
    const runtime = createRuntime({ bridge, clock: new ManualClock() });
    try {
      runtime.store.saveGoal({ goalId: 'goal-p03', revision: 1, status: 'active', text: 'place' });
      const result = await runtime.router.invoke(placeCall('barrier-hit'), { goalId: 'goal-p03', goalRevision: 1 });
      expect(result.ok).toBe(true);
      expect(bridge.cell(1, 0)).toBe('blocked');
      expect(bridge.inventory).toBe(7);
      const effects = runtime.store.listEffects();
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({
        status: 'confirmed',
        intent: { kind: 'place', x: 1, y: 0 },
        evidence: { barrier: 'pre-dispatch', goalId: 'goal-p03', goalRevision: 1 },
      });
      const execution = runtime.store.getExecution('barrier-hit');
      expect(execution).toMatchObject({ status: 'succeeded', outcome: 'confirmed', goalId: 'goal-p03' });
    } finally { runtime.close(); }
  });

  it('does not dispatch when prepared persistence fails', async () => {
    const bridge = new FakeClientBridge();
    const runtime = createRuntime({ bridge, clock: new ManualClock() });
    const store = runtime.store as unknown as { addEffect: (...args: unknown[]) => unknown };
    store.addEffect = () => { throw new Error('disk-full'); };
    try {
      const result = await runtime.router.invoke(placeCall('prepare-fail'));
      expect(result).toMatchObject({ ok: false });
      expect(bridge.inventory).toBe(8);
      expect(bridge.cell(1, 0)).toBe('free');
      expect(runtime.store.listEffects()).toHaveLength(0);
      const execution = runtime.store.getExecution('prepare-fail');
      expect(execution).toMatchObject({ status: 'failed', reason: 'disk-full' });
    } finally { runtime.close(); }
  });

  it('does not dispatch when the may-have-dispatched barrier cannot be persisted', async () => {
    const bridge = new FakeClientBridge();
    const runtime = createRuntime({ bridge, clock: new ManualClock() });
    const store = runtime.store;
    const original = store.updateEffect.bind(store);
    let failBarrier = true;
    store.updateEffect = (effectId, status, evidence) => {
      if (status === 'may-have-dispatched' && failBarrier) { failBarrier = false; throw new Error('barrier-write-failed'); }
      return original(effectId, status, evidence);
    };
    try {
      const result = await runtime.router.invoke(placeCall('barrier-fail'));
      expect(result).toMatchObject({ ok: false, error: 'barrier-write-failed' });
      expect(bridge.inventory).toBe(8);
      expect(bridge.cell(1, 0)).toBe('free');
      expect(runtime.store.listEffects()).toEqual([expect.objectContaining({ status: 'prepared' })]);
      expect(runtime.store.getExecution('barrier-fail')).toMatchObject({ status: 'failed' });
    } finally { runtime.close(); }
  });

  it('does not let cancel or watchdog overwrite a terminal success', async () => {
    const store = new SQLiteStore(':memory:');
    const clock = new ManualClock();
    try {
      const executor = new Executor(new FakeClientBridge(), store, undefined, { clock, watchdogTtl: 5 });
      const execution = await executor.start('g', 'observe_ui', { proposalId: 'terminal-success' }, () => ({ outcome: 'confirmed' as const }));
      expect(store.getExecution(execution.executionId)).toMatchObject({ status: 'succeeded', outcome: 'confirmed' });
      executor.cancel(execution.executionId);
      executor.watchdog(execution.executionId);
      expect(store.getExecution(execution.executionId)).toMatchObject({ status: 'succeeded', outcome: 'confirmed' });
    } finally { store.close(); }
  });
});

describe('P04 session recovery budget', () => {
  it('retries a recoverable failure and resets the budget on success', () => {
    const store = new SQLiteStore(':memory:');
    const original = store.pendingEffects.bind(store);
    let failOnce = true;
    (store as unknown as { pendingEffects: () => unknown }).pendingEffects = () => {
      if (failOnce) { failOnce = false; throw new Error('store-offline'); }
      return original();
    };
    try {
      const session = new SessionRuntime(new FakeClientBridge(), store, { maxRecoveryAttempts: 2 });
      expect(() => session.start()).toThrow('store-offline');
      expect(session.state).toBe('recoverable-failure');
      expect(session.recoveryAttempts).toBe(1);
      const recovered = session.recover();
      expect(recovered).toMatchObject({ recovered: true, attempts: 2, budget: 2 });
      expect(session.state).toBe('running');
      expect(session.recoveryAttempts).toBe(0);
    } finally { store.close(); }
  });

  it('suspends after exhausting the consecutive recovery budget', () => {
    const store = new SQLiteStore(':memory:');
    (store as unknown as { pendingEffects: () => unknown }).pendingEffects = () => { throw new Error('store-offline'); };
    try {
      const session = new SessionRuntime(new FakeClientBridge(), store, { maxRecoveryAttempts: 2 });
      expect(() => session.start()).toThrow('store-offline');
      expect(session.state).toBe('recoverable-failure');
      expect(() => session.start()).toThrow('store-offline');
      expect(session.state).toBe('suspended');
      expect(() => session.recover()).toThrow('recovery-budget-exhausted');
    } finally { store.close(); }
  });
});
