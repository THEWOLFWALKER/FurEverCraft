import { describe, expect, it } from 'vitest';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ManualClock } from '../../src/contracts/index.js';
import { Executor, InputArbiter } from '../../src/execution/runtime.js';
import { SQLiteStore } from '../../src/persistence/store.js';
import { navigateTo, observeUi, placeOne, sendChat, waitForCondition, lookAt, digOne, returnToPlace, collectNearby, gatherBlocks } from '../../src/skills/skills.js';

describe('W05/W06 execution lifecycle and skills', () => {
  it('deduplicates proposals and reports lifecycle progress', async () => {
    const store = new SQLiteStore(':memory:');
    const executor = new Executor(new FakeClientBridge(), store);
    const first = await executor.start('g', 'observe_ui', { proposalId: 'p1' }, (_lease, report) => report({ stage: 'dispatch', completed: 1, total: 1 }));
    const duplicate = await executor.start('g', 'observe_ui', { proposalId: 'p1' }, () => { throw new Error('must not run'); });
    expect(first.status).toBe('succeeded');
    expect(duplicate.executionId).toBe(first.executionId);
    expect(executor.progress(first.executionId)?.stage).toBe('verify');
    store.close();
  });

  it('enforces resource ownership and lease expiry', () => {
    const clock = new ManualClock();
    const arbiter = new InputArbiter(() => clock.now());
    const first = arbiter.acquire('a', ['movement'], 10);
    expect(() => arbiter.acquire('b', ['movement'], 10)).toThrow('resource-busy');
    clock.advance(10);
    expect(() => arbiter.validate(first.leaseId, 'a')).toThrow('lease-invalid');
    const second = arbiter.acquire('b', ['movement'], 10);
    expect(second.owner).toBe('b');
  });

  it('runs five skills with progress, cancellation, and verification outcomes', () => {
    const bridge = new FakeClientBridge();
    const progress: string[] = [];
    const ctx = { bridge, lease: { leaseId: 'l', owner: 'e', resources: [], until: 1, generation: 1 }, report: (p: { stage: 'prepare' | 'dispatch' | 'verify' | 'complete'; completed: number }) => progress.push(p.stage) };
    expect(navigateTo(ctx, { x: 1, y: 0 }).outcome).toBe('confirmed');
    expect(observeUi(ctx).outcome).toBe('confirmed');
    expect(sendChat(ctx, 'hello').outcome).toBe('confirmed');
    expect(placeOne({ ...ctx, bridge }, { x: 2, y: 0 }).outcome).toBe('confirmed');
    expect(waitForCondition(ctx, 25).value).toEqual({ waitedMs: 25 });
    expect(progress).toContain('dispatch');
    expect(progress).toContain('verify');
    expect(waitForCondition({ ...ctx, isCanceled: () => true }, 1).outcome).toBe('canceled');
    expect(bridge.inventory).toBe(7);
    expect(bridge.cell(2, 0)).toBe('blocked');
  });

  it('fails closed for the newer skills when the body cannot support them', async () => {
    const bridge = new FakeClientBridge();
    const ctx = { bridge, lease: { leaseId: 'l', owner: 'e', resources: [], until: 1, generation: 1 }, report: () => {} };
    const noLook = new FakeClientBridge(); (noLook as unknown as { lookAt?: unknown }).lookAt = undefined;
    expect(lookAt({ ...ctx, bridge: noLook }, { x: 1, y: 0 }).reason).toContain('orientation-unavailable');
    const noDig = new FakeClientBridge(); noDig.block(1, 0); (noDig as unknown as { dig?: unknown }).dig = undefined;
    expect(digOne({ ...ctx, bridge: noDig }, { x: 1, y: 0 }).reason).toBe('dig-capability-unavailable');
    const noPlace = new FakeClientBridge(); (noPlace as unknown as { findPlace?: unknown }).findPlace = undefined;
    expect(returnToPlace({ ...ctx, bridge: noPlace }, 'home').reason).toBe('place-navigation-capability-unavailable');
    const noCollect = new FakeClientBridge(); (noCollect as unknown as { collectNearby?: unknown }).collectNearby = undefined;
    expect(collectNearby({ ...ctx, bridge: noCollect }).outcome).toBe('failed');
    const noGather = new FakeClientBridge(); (noGather as unknown as { digBlock?: unknown }).digBlock = undefined;
    expect(gatherBlocks({ ...ctx, bridge: noGather }, 'stone').outcome).toBe('failed');
  });

  it('collects and gathers in the simulated body when the capability exists', () => {
    const bridge = new FakeClientBridge();
    const ctx = { bridge, lease: { leaseId: 'l', owner: 'e', resources: [], until: 1, generation: 1 }, report: () => {} };
    bridge.seedDrop(1, 0, 'stone');
    expect(collectNearby(ctx)).toMatchObject({ ok: true, outcome: 'confirmed' });
    bridge.block(0, 1, 'stone');
    expect(gatherBlocks(ctx, 'stone')).toMatchObject({ ok: true, outcome: 'confirmed' });
    expect(bridge.cell(0, 1)).toBe('free');
    expect(gatherBlocks(ctx, 'stone').outcome).toBe('failed');
  });

  it('supports look_at, dig_one and return_to_place against the simulated body', () => {
    const bridge = new FakeClientBridge();
    const progress: string[] = [];
    const ctx = { bridge, lease: { leaseId: 'l', owner: 'e', resources: [], until: 1, generation: 1 }, report: (p: { stage: 'prepare' | 'dispatch' | 'verify' | 'complete'; completed: number }) => progress.push(p.stage) };
    expect(lookAt(ctx, { x: 0, y: 1 })).toMatchObject({ ok: true, outcome: 'confirmed' });
    bridge.block(1, 0);
    expect(digOne(ctx, { x: 1, y: 0 })).toMatchObject({ ok: true, outcome: 'confirmed' });
    expect(bridge.cell(1, 0)).toBe('free');
    bridge.rememberPlace('home', 2, 0);
    expect(returnToPlace(ctx, 'home').outcome).toBe('confirmed');
    expect(bridge.position).toEqual({ x: 2, y: 0 });
    expect(returnToPlace(ctx, 'missing').reason).toContain('unknown-place');
  });

  it('watchdog marks an abandoned execution failed', async () => {
    const store = new SQLiteStore(':memory:');
    const clock = new ManualClock();
    const executor = new Executor(new FakeClientBridge(), store, undefined, { clock, watchdogTtl: 5 });
    const execution = await executor.start('g', 'observe_ui', { proposalId: 'watch' }, () => { clock.advance(6); });
    expect(store.getExecution(execution.executionId)?.reason).toBe('watchdog-timeout');
    store.close();
  });

  it('renews the watchdog and lease while progress is reported', async () => {
    const store = new SQLiteStore(':memory:');
    const clock = new ManualClock();
    const executor = new Executor(new FakeClientBridge(), store, undefined, { clock, watchdogTtl: 5, leaseTtl: 5 });
    const execution = await executor.start('g', 'observe_ui', { proposalId: 'long' }, (_lease, report) => {
      report({ stage: 'dispatch', completed: 1 });
      clock.advance(4);
      report({ stage: 'dispatch', completed: 2 });
      clock.advance(4);
      report({ stage: 'dispatch', completed: 3 });
    });
    expect(execution.status).toBe('succeeded');
    expect(store.getExecution(execution.executionId)?.status).toBe('succeeded');
    store.close();
  });
});
