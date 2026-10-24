import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { createRuntime } from '../../src/execution/factory.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ManualClock } from '../../src/contracts/index.js';
import { ScriptedModelProvider } from '../../src/providers/scripted/index.js';
import { ActionPlanner } from '../../src/motor/action-graph.js';
import { SparseVoxelWorld } from '../../src/motor/geometry.js';
import { createLoopbackBytePair } from '../../src/bridge/protocol/session.js';
import { BoundedObserver } from '../../src/bridge/observer/bounded.js';
import { createRawTcpRelay } from '../../src/bridge/relay/raw.js';

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
    expect(obstructed.status).toBe('COMPLETE');
    expect(obstructed.edges.length).toBeGreaterThan(0);
    expect(obstructed.edges.some(edge => edge.to.x === 1 && edge.to.z === 1)).toBe(false);
  });

  it('S06 ambiguous is never upgraded by the router', async () => {
    const bridge = new FakeClientBridge(12, { faults: { place: { fault: 'ambiguous', count: 1 } } });
    const runtime = createRuntime({ bridge });
    try {
      const result = await runtime.router.invoke({ id: 's06', name: 'start_skill', arguments: JSON.stringify({ skill: 'place_one', x: 1, y: 0, proposalId: 's06-p' }) });
      expect(result.ok).toBe(false);
      const effects = runtime.store.listEffects();
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({ status: 'ambiguous' });
      expect(effects.some(effect => effect.status === 'confirmed')).toBe(false);
      expect(runtime.store.getExecution(effects[0]!.executionId)).toMatchObject({ status: 'suspended', outcome: 'ambiguous' });
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
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ status: 'ambiguous' });
        const recovery = reopened.session.start();
        // The ambiguous dispatch applied exactly once; recovery must not decrement again.
        expect(recovery.reconciled).toEqual([{ effectId: pending[0]!.effectId, status: 'ambiguous' }]);
        expect(bridge.inventory).toBe(7);
        const effects = reopened.store.listEffects();
        expect(effects).toHaveLength(1);
        expect(effects[0]).toMatchObject({ status: 'ambiguous' });
        expect(effects.some(effect => effect.status === 'confirmed')).toBe(false);
        expect(reopened.store.getExecution(effects[0]!.executionId)).toMatchObject({ status: 'suspended', outcome: 'ambiguous' });
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
    // A loopback echo relay with a passive observer tap. The observer has no room for even one
    // frame payload, so the first frame overflows its queue; the relay must keep forwarding both
    // directions verbatim and report exactly one explicit global gap.
    const observer = new BoundedObserver({ maxQueuedFrames: 1, maxQueuedBytes: 1, maxConcurrency: 1 });
    const gaps: Array<{ scope: string; reason: string }> = [];
    observer.subscribe(event => { if (event.kind === 'observer_gap') gaps.push(event.gap); });
    const forwarded: Record<'client-to-server' | 'server-to-client', Buffer[]> = {
      'client-to-server': [],
      'server-to-client': [],
    };
    const upstream = net.createServer(socket => socket.on('data', chunk => socket.write(chunk)));
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', () => resolve());
    });
    const relay = createRawTcpRelay({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: (upstream.address() as net.AddressInfo).port,
      allowMinecraftUpstream: true,
      onChunk: (direction, chunk) => {
        forwarded[direction].push(Buffer.from(chunk));
        observer.attach(direction, chunk);
      },
    });
    let client: net.Socket | undefined;
    try {
      await relay.start();
      client = await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection(relay.address.port, '127.0.0.1', () => resolve(socket));
        socket.once('error', reject);
      });
      const roundTrip = (payload: Buffer) => new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const onData = (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
          if (Buffer.concat(chunks).length >= payload.length) {
            client!.off('data', onData);
            resolve(Buffer.concat(chunks));
          }
        };
        client!.on('data', onData);
        client!.once('error', reject);
        client!.write(payload);
      });

      // One complete frame ("hello"); its payload exceeds the observer's one-byte queue.
      const payload = Buffer.from([5, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
      expect(await roundTrip(payload)).toEqual(payload);
      expect(Buffer.concat(forwarded['client-to-server'])).toEqual(payload);
      expect(Buffer.concat(forwarded['server-to-client'])).toEqual(payload);
      expect(gaps).toHaveLength(1);
      expect(gaps[0]).toMatchObject({ scope: 'global', reason: 'queue-overflow' });
      expect(observer.health).toBe('unknown');

      // Forwarding stays alive after the observer stops interpreting.
      const afterGap = Buffer.from([4, 0x61, 0x6c, 0x69, 0x76]);
      expect(await roundTrip(afterGap)).toEqual(afterGap);
      expect(gaps).toHaveLength(1);
    } finally {
      client?.destroy();
      await relay.stop();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      await observer.stop();
    }
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
        // A replayed request must reuse the durable receipt instead of writing a second revision.
        expect(reopened.store.getGoal('g')?.revision).toBe(1);
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
      expect(states).toHaveLength(2);
      expect(states.filter(state => state === 'terminal')).toHaveLength(1);
      expect(states.every(state => state === 'terminal' || state === 'accepted')).toBe(true);
      expect(runtime.store.listGoals().filter(goal => goal.goal_id === 'dup')).toHaveLength(1);
      // A duplicate execution would have incremented the revision; exactly one write is observable.
      expect(runtime.store.getGoal('dup')?.revision).toBe(1);
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
