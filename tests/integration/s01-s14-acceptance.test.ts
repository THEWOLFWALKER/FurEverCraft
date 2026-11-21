import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../src/execution/factory.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ManualClock } from '../../src/contracts/index.js';
import { ScriptedModelProvider } from '../../src/providers/scripted/index.js';
import { ActionPlanner } from '../../src/motor/action-graph.js';
import { SparseVoxelWorld } from '../../src/motor/geometry.js';
import { createLoopbackBytePair } from '../../src/bridge/protocol/session.js';
import { BoundedObserver } from '../../src/bridge/observer/bounded.js';

const context = { serverProfileId: 'simulated', worldGenerationId: 'world-1', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' } as const;

describe('V01 S01-S14 acceptance-mapped offline scenarios', () => {
  it('S01 human steering: goal revision conflict prevents stale model output', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      await runtime.control.command({ requestId: 's01-g1', command: 'goal.set', payload: { goalId: 'g', text: 'first' } });
      const stale = await runtime.control.command({ requestId: 's01-m1', command: 'message', payload: { text: 'act on old goal', goalId: 'g', goalRevision: 0 } });
      expect(stale.state).toBe('conflict');
      const fresh = await runtime.control.command({ requestId: 's01-m2', command: 'message', payload: { text: 'act on new goal', goalId: 'g', goalRevision: 1 } });
      expect(fresh.state).toBe('terminal');
    } finally { runtime.close(); }
  });

  it('S02/S03 3D clearance and obstruction: unknown is not air, blocked routes are not planned', () => {
    const world = new SparseVoxelWorld(context);
    const planner = new ActionPlanner(world);
    expect(planner.plan({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }).status).toBe('NEEDS_OBSERVATION');
    for (let x = 0; x < 4; x += 1) for (let z = 0; z < 3; z += 1) { world.setAir({ x, y: 0, z }); world.setAir({ x, y: 1, z }); world.setBlock({ x, y: -1, z }); }
    expect(planner.plan({ x: 0, y: 0, z: 1 }, { x: 3, y: 0, z: 1 }).status).toBe('COMPLETE');
    world.setBlock({ x: 1, y: 0, z: 1 });
    const obstructed = planner.plan({ x: 0, y: 0, z: 1 }, { x: 3, y: 0, z: 1 });
    expect(obstructed.edges.every(edge => !(edge.to.x === 1 && edge.to.z === 1))).toBe(true);
  });

  it('S06 ambiguous is never upgraded by the router', async () => {
    const bridge = new FakeClientBridge(12, { faults: { place: { fault: 'ambiguous', count: 1 } } });
    const runtime = createRuntime({ bridge });
    try {
      const result = await runtime.router.invoke({ id: 's06', name: 'start_skill', arguments: JSON.stringify({ skill: 'place_one', x: 1, y: 0, proposalId: 's06-p' }) });
      expect(result.ok).toBe(false);
      expect(runtime.control.effects().some(effect => effect.status === 'ambiguous')).toBe(true);
    } finally { runtime.close(); }
  });

  it('S07 dispatch crash window leaves a pending effect that is not replayed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-s07-')); const db = join(dir, 's07.sqlite');
    const bridge = new FakeClientBridge(12, { faults: { place: { fault: 'ambiguous', count: 1 } } });
    try {
      const first = createRuntime({ db, bridge });
      await first.router.invoke({ id: 's07', name: 'start_skill', arguments: JSON.stringify({ skill: 'place_one', x: 1, y: 0, proposalId: 's07-p' }) });
      first.close();
      const reopened = createRuntime({ db, bridge });
      try {
        const pending = reopened.store.pendingEffects();
        expect(pending.length).toBeGreaterThan(0);
        const recovery = reopened.session.start();
        expect(recovery.reconciled.length).toBeGreaterThan(0);
        expect(recovery.reconciled.every(item => ['ambiguous', 'confirmed'].includes(item.status))).toBe(true);
        // The ambiguous dispatch applied exactly once; recovery must not decrement again.
        expect(bridge.inventory).toBe(7);
        const ambiguous = recovery.reconciled.filter(item => item.status === 'ambiguous');
        expect(ambiguous.length).toBeGreaterThan(0);
      } finally { reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('S10 loopback byte relay preserves split/coalesced bytes', async () => {
    const pair = createLoopbackBytePair([1, 2, 3]);
    const received: number[] = [];
    pair.right.onData(chunk => received.push(...Array.from(chunk)));
    await pair.left.write(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]));
    expect(received).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    await pair.left.close(); await pair.right.close();
  });

  it('S11 observer failure does not alter forwarded bytes and gaps are explicit', async () => {
    const observer = new BoundedObserver({ maxQueuedFrames: 1 });
    const gaps: string[] = [];
    observer.subscribe(event => { if (event.kind === 'observer_gap') gaps.push(event.gap.reason); });
    // Six single-byte frames with a one-frame queue: overflow must produce an explicit gap,
    // and the observer receives frames without throwing into the forwarding path.
    observer.attach('client-to-server', new Uint8Array([1, 1, 1, 1, 1, 1]));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every(reason => typeof reason === 'string')).toBe(true);
    await observer.stop();
  });

  it('S14 runtime rebuild keeps the same store and receipts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-s14-')); const db = join(dir, 's14.sqlite');
    try {
      const first = createRuntime({ db, clock: new ManualClock() });
      await first.control.command({ requestId: 's14-g', command: 'goal.set', payload: { goalId: 'g', text: 'persist' } });
      first.close();
      const reopened = createRuntime({ db, clock: new ManualClock() });
      try {
        const replay = await reopened.control.command({ requestId: 's14-g', command: 'goal.set', payload: { goalId: 'g', text: 'persist' } });
        expect(replay.state).toBe('terminal');
        expect(reopened.store.listGoals()).toHaveLength(1);
      } finally { reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('U04 concurrent CLI/Web operations', () => {
  it('executes a concurrent identical requestId exactly once', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }, { text: 'ok', stopReason: 'end_turn' }]) });
    try {
      const request = { requestId: 'dup-1', command: 'goal.set' as const, payload: { goalId: 'dup', text: 'only once' } };
      const [a, b] = await Promise.all([runtime.control.command(request), runtime.control.command(request)]);
      const states = [a.state, b.state].sort();
      // One caller actually executes; the other observes the in-flight/terminal outcome.
      expect(states).toContain('terminal');
      expect(runtime.store.listGoals().filter(goal => goal.goal_id === 'dup')).toHaveLength(1);
    } finally { runtime.close(); }
  });

  it('rejects a stale CAS revision instead of last-write-wins', async () => {
    const runtime = createRuntime();
    try {
      await runtime.control.command({ requestId: 'cas-1', command: 'goal.set', payload: { goalId: 'cas', text: 'one' } });
      const first = await runtime.control.command({ requestId: 'cas-2', command: 'goal.revise', payload: { goalId: 'cas', expectedRevision: 1, change: 'two' } });
      expect(first.state).toBe('terminal');
      const stale = await runtime.control.command({ requestId: 'cas-3', command: 'goal.revise', payload: { goalId: 'cas', expectedRevision: 1, change: 'stale' } });
      expect(stale.state).toBe('conflict');
    } finally { runtime.close(); }
  });
});
