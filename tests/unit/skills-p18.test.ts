import { describe, expect, it, vi } from 'vitest';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { EventHub } from '../../src/diagnostics/events.js';
import { TaskScheduler } from '../../src/autonomous/tasks.js';
import { AuthCoordinator } from '../../src/autonomous/session.js';
import { SkillLifecycle } from '../../src/skills/lifecycle.js';
import { hasAllPreconditions, missingPreconditions, skillManifests, findSkill } from '../../src/skills/registry.js';
import { collectNearby, digOne, gatherBlocks, placeOne } from '../../src/skills/skills.js';

const lease = { leaseId: 'l', owner: 'e', resources: [], until: 1, generation: 1, contextEpoch: '' };
const ctxFor = (bridge: FakeClientBridge, extra: Record<string, unknown> = {}) => ({ bridge, lease, report: () => undefined, ...extra });
const tick = () => new Promise(resolve => setTimeout(resolve, 2));

describe('P18 skill lifecycle', () => {
  it('registers lifecycle, evidence and write semantics for all eleven skills', () => {
    expect(skillManifests).toHaveLength(11);
    for (const manifest of skillManifests) {
      expect(manifest.progress).toContain('prepare');
      expect(manifest.progress).toContain('verify');
      expect(manifest.evidence.length).toBeGreaterThan(0);
      expect(typeof manifest.suspendable).toBe('boolean');
      expect(typeof manifest.writes).toBe('boolean');
    }
    expect(findSkill('place_one')?.writes).toBe(true);
    expect(findSkill('observe_ui')?.writes).toBe(false);
    expect(findSkill('wait_for_condition')?.suspendable).toBe(false);
  });

  it('fails before dispatch when a declared precondition is unknown, not false', async () => {
    const lifecycle = new SkillLifecycle(undefined, { now: () => 10 });
    let ran = false;
    const result = await lifecycle.run('place_one', () => { ran = true; return { ok: true, outcome: 'confirmed' }; }, { preconditions: { 'free-target': true } });
    expect(ran).toBe(false);
    expect(result).toMatchObject({ state: 'failed', reason: 'precondition:inventory' });
    const manifest = findSkill('place_one')!;
    expect(hasAllPreconditions(manifest, { 'free-target': true, inventory: true })).toBe(true);
    expect(missingPreconditions(manifest, { 'free-target': true, inventory: undefined })).toEqual(['inventory']);
  });

  it('records progress and maps confirmed, partial and ambiguous without promotion', async () => {
    const lifecycle = new SkillLifecycle();
    const confirmed = await lifecycle.run('observe_ui', (_signal, report) => { report({ stage: 'dispatch', completed: 1, total: 1 }); return { ok: true, outcome: 'confirmed' }; }, { preconditions: { 'ui-observation': true } });
    expect(confirmed.state).toBe('succeeded');
    expect(confirmed.progress.map(item => item.stage)).toEqual(expect.arrayContaining(['prepare', 'dispatch', 'verify']));
    const partial = await lifecycle.run('gather_blocks', (_signal, report) => { report({ stage: 'dispatch', completed: 1, total: 3 }); return { ok: false, outcome: 'partial', value: { gathered: 1, requested: 3 } }; }, { preconditions: { 'known-target': true } });
    expect(partial).toMatchObject({ state: 'suspended', outcome: 'partial' });
    const ambiguous = await lifecycle.run('dig_one', () => ({ ok: false, outcome: 'ambiguous', reason: 'target-not-observed-free' }), { preconditions: { 'reachable-target': true, tool: true } });
    expect(ambiguous).toMatchObject({ state: 'suspended', outcome: 'ambiguous' });
  });

  it('pauses/cancels a running program and resumes only as a fresh dispatch', async () => {
    const lifecycle = new SkillLifecycle();
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const pending = lifecycle.run('navigate_to', signal => new Promise(resolve => {
      started();
      signal.addEventListener('abort', () => resolve({ ok: false, outcome: 'canceled' }), { once: true });
    }), { preconditions: { 'current-position': true } });
    await running;
    const run = lifecycle.list().find(item => item.skillId === 'navigate_to')!;
    const paused = lifecycle.pause(run.runId);
    expect(paused).toMatchObject({ state: 'suspended', outcome: 'paused' });
    await expect(pending).resolves.toMatchObject({ state: 'suspended', outcome: 'paused' });
    const resumed = lifecycle.resume(run.runId)!;
    expect(resumed.state).toBe('queued');
    // The old program was aborted; the resumed plan is a new generation that must re-dispatch.
    const stale = await lifecycle.run('navigate_to', () => ({ ok: true, outcome: 'confirmed' }), { generation: run.generation, preconditions: { 'current-position': true } });
    expect(stale).toMatchObject({ state: 'failed', reason: 'stale-generation' });
    const fresh = await lifecycle.run('navigate_to', () => ({ ok: true, outcome: 'confirmed' }), { generation: resumed.generation, preconditions: { 'current-position': true } });
    expect(fresh.state).toBe('succeeded');
  });

  it('interrupts old plans on human control and fences stale generations', async () => {
    const lifecycle = new SkillLifecycle();
    let started!: () => void;
    const gate = new Promise<void>(resolve => { started = resolve; });
    const pending = lifecycle.run('wait_for_condition', signal => new Promise(resolve => {
      started();
      signal.addEventListener('abort', () => resolve({ ok: false, outcome: 'canceled' }), { once: true });
    }), { preconditions: { clock: true } });
    await gate;
    const before = lifecycle.generationValue;
    const interrupted = lifecycle.humanControl('operator-stop');
    expect(interrupted[0]).toMatchObject({ state: 'canceled', reason: 'operator-stop' });
    expect(lifecycle.generationValue).toBe(before + 1);
    await expect(pending).resolves.toMatchObject({ state: 'canceled' });
    await expect(lifecycle.run('observe_ui', () => ({ ok: true, outcome: 'confirmed' }), { generation: before, preconditions: { 'ui-observation': true } })).resolves.toMatchObject({ state: 'failed', reason: 'stale-generation' });
  });

  it('never reports a short gather as goal completion and never treats a free cell alone as causality', async () => {
    const bridge = new FakeClientBridge();
    bridge.block(1, 0, 'stone');
    const ctx = ctxFor(bridge);
    const short = await gatherBlocks(ctx, 'stone', 3);
    expect(short.outcome).toBe('partial');
    expect(short.value).toMatchObject({ gathered: 1, requested: 3 });
    expect(short.ok).toBe(false);

    // A receipt without a command id is not causal evidence, even if the cell became free.
    const noReceipt = new FakeClientBridge();
    noReceipt.block(1, 0, 'stone');
    (noReceipt as any).dig = () => ({ accepted: true });
    expect(digOne(ctxFor(noReceipt), { x: 1, y: 0 })).toMatchObject({ outcome: 'ambiguous', reason: 'dig-delivery-unconfirmed' });

    const freeAlone = new FakeClientBridge();
    freeAlone.block(1, 0, 'stone');
    (freeAlone as any).digBlock = () => ({ accepted: true, commandId: 'cmd', block: 'stone' });
    (freeAlone as any).adjacentBlock = () => ({ x: 1, y: 0 });
    expect(gatherBlocks(ctxFor(freeAlone), 'stone', 1)).toMatchObject({ outcome: 'failed', reason: 'gather-count-unmet' });
  });

  it('does not treat an entity disappearing as this player picking it up', () => {
    const bridge = new FakeClientBridge();
    (bridge as any).collectNearby = () => ({ accepted: true, commandId: 'collect-1', collected: 1, items: ['stone'] });
    // The drop is gone/accepted but inventory did not change: not proof of pickup.
    expect(collectNearby(ctxFor(bridge))).toMatchObject({ outcome: 'ambiguous', reason: 'inventory-delta-unconfirmed' });
    (bridge as any).collectNearby = () => ({ accepted: true, commandId: 'collect-2', collected: 0, items: [] });
    expect(collectNearby(ctxFor(bridge))).toMatchObject({ outcome: 'partial', reason: 'no-entities-observed' });
  });
});

describe('P18 scheduler and bounded auth', () => {
  it('drops wakeups while paused and fences an in-flight wake on human control', async () => {
    const events = new EventHub();
    let release!: () => void;
    const wake = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const scheduler = new TaskScheduler(events, wake, 1);
    expect(scheduler.wake('goal')).toBe(true);
    await tick();
    expect(wake).toHaveBeenCalledTimes(1);
    const generation = scheduler.humanControl('pause');
    release();
    await tick();
    const stale = events.read('0', 50).events.find(event => event.kind === 'scheduler.stale-wake');
    expect(stale?.payload).toMatchObject({ generation: generation - 1, current: generation });
    scheduler.pause();
    expect(scheduler.wake('observation')).toBe(false);
    expect(scheduler.resume()).toBe(true);
    expect(scheduler.wake('goal')).toBe(true);
    scheduler.close();
  });

  it('emits auth commands only from an observed allow-listed prompt, once, and within budget', () => {
    const auth = new AuthCoordinator([{ id: 'login', promptPattern: /password/i, response: 'secretRef', allowed: true }], { maxAttempts: 3 });
    expect(auth.nextCommand()).toBeUndefined();
    expect(auth.observe('   ')).toMatchObject({ status: 'waiting-observation' });
    const ready = auth.observe('Password?', { ref: 'secret://mc', configured: true });
    expect(ready).toMatchObject({ status: 'ready', templateId: 'login', secretRef: 'secret://mc' });
    expect(JSON.stringify(ready)).not.toContain('Password?');
    expect(auth.nextCommand()).toMatchObject({ templateId: 'login', response: 'secretRef', secretRef: 'secret://mc' });
    expect(auth.nextCommand()).toBeUndefined();
    expect(auth.observe('unknown prompt')).toMatchObject({ status: 'waiting-configuration' });
    expect(auth.observe('unknown again')).toMatchObject({ status: 'blocked', reason: 'attempt-budget-exhausted' });
    expect(auth.nextCommand()).toBeUndefined();
  });

  it('requires an explicit secret reference and does not echo the secret', () => {
    const auth = new AuthCoordinator([{ id: 'login', promptPattern: /password/i, response: 'secretRef', allowed: true }]);
    expect(auth.authorize('Password?')).toMatchObject({ status: 'waiting-configuration', reason: 'secret-ref-not-configured' });
    const ready = auth.authorize('Password?', { ref: 'secret://vault/mc', configured: true });
    expect(ready).toMatchObject({ status: 'ready', secretRef: 'secret://vault/mc' });
    expect(JSON.stringify(ready)).not.toContain('super-secret-value');
  });
});
