import { afterEach, describe, expect, it } from 'vitest';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ManualClock, type BodyContext } from '../../src/contracts/index.js';
import { createRuntime } from '../../src/execution/factory.js';
import { ActionGateway } from '../../src/execution/action-gateway.js';
import { SQLiteStore } from '../../src/persistence/store.js';
import { gatherBlocks } from '../../src/skills/skills.js';
import { SparseVoxelWorld } from '../../src/motor/geometry.js';
import { SimulatedBody } from '../../src/fixtures/simulated-body.js';
import { SimulatedBodyAdapter } from '../../src/fixtures/body-adapter.js';

const context: BodyContext = { serverProfileId: 'simulated', worldGenerationId: 'world-1', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };

function flatWorld(): SparseVoxelWorld {
  const world = new SparseVoxelWorld(context, { id: 's04-fixture', registryVersion: 'fixture-1', source: 'fixture', approximate: false });
  for (let x = -3; x <= 12; x++) for (let z = -3; z <= 12; z++) {
    world.setBlock({ x, y: -1, z }, 'full_cube', 'stone');
    for (let y = 0; y <= 5; y++) world.setAir({ x, y, z });
  }
  return world;
}

function make3D() {
  const clock = new ManualClock();
  const world = flatWorld();
  const body = new SimulatedBody(context, world, clock, { start: { x: 0.5, y: 0, z: 0.5, yaw: 0, pitch: 0 } });
  const adapter = new SimulatedBodyAdapter(body, world, clock, { tickMs: 20, observationRadius: 16 });
  return { clock, world, adapter };
}

const open: Array<{ close(): void }> = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
function track<T extends { close(): void }>(runtime: T): T { open.push(runtime); return runtime; }

describe('S04 ActionGateway is the single effect write path', () => {
  it('does not create a durable effect for a skill invoked directly, outside the gateway', () => {
    // A direct skill call bypasses the executor/gateway entirely: it must not write an effect row.
    const store = new SQLiteStore(':memory:');
    const bridge = new FakeClientBridge();
    bridge.block(1, 0, 'stone');
    const ctx = {
      bridge,
      lease: { leaseId: 'l', owner: 'e', resources: [], until: 1, generation: 1, contextEpoch: '' },
      report: () => undefined,
    };
    const result = gatherBlocks(ctx as never, 'stone');
    expect((result as { outcome: string }).outcome).toBe('confirmed');
    expect(store.listEffects()).toHaveLength(0);
    store.close();
  });

  it('mints exactly one effect per dig for gather_blocks(count>1) with distinct ordinals (FEC-35)', async () => {
    const { clock, world, adapter } = make3D();
    world.setBlock({ x: 1, y: 0, z: 0 }, 'full_cube', 'coal_ore');
    world.setBlock({ x: 0, y: 0, z: 1 }, 'full_cube', 'coal_ore');
    const bridge = new FakeClientBridge(16, { context });
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock, bodyAdapter: adapter }));

    const result = await runtime.router.invoke({ id: 'gather-2', name: 'start_skill', arguments: JSON.stringify({ skill: 'gather_blocks', block: 'coal_ore', count: 2 }) });
    expect(result.ok).toBe(true);
    expect((result.result as { outcome?: string }).outcome).toBe('confirmed');

    const effects = runtime.store.listEffects();
    // Two digs must be attributed as two effects, not one aggregated effect.
    expect(effects).toHaveLength(2);
    const ordinals = effects.map(effect => Number(effect.actionOrdinal)).sort();
    expect(ordinals).toEqual([0, 1]);
    // Both effects share one logical action id (the single gather call) and are individually confirmed.
    const logical = new Set(effects.map(effect => String(effect.logicalActionId)));
    expect(logical.size).toBe(1);
    expect([...logical][0]).not.toMatch(/^single:/);
    expect(effects.every(effect => effect.status === 'confirmed')).toBe(true);
  });

  it('keeps a single-effect write to one effect row with ordinal 0', async () => {
    const { clock, world, adapter } = make3D();
    world.setBlock({ x: 1, y: 0, z: 0 }, 'full_cube', 'coal_ore');
    const bridge = new FakeClientBridge(16, { context });
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock, bodyAdapter: adapter }));
    const result = await runtime.router.invoke({ id: 'gather-1', name: 'start_skill', arguments: JSON.stringify({ skill: 'gather_blocks', block: 'coal_ore', count: 1 }) });
    expect(result.ok).toBe(true);
    const effects = runtime.store.listEffects();
    expect(effects).toHaveLength(1);
    expect(Number(effects[0]!.actionOrdinal)).toBe(0);
    expect(effects[0]).toMatchObject({ status: 'confirmed', intent: expect.objectContaining({ kind: 'dig', block: 'coal_ore' }) });
  });

  it('halts a legacy gather on an indeterminate dig receipt instead of continuing to mine (FEC-34)', () => {
    const bridge = new FakeClientBridge();
    // Three adjacent stone blocks so the gather would otherwise keep digging.
    bridge.block(1, 0); bridge.block(-1, 0); bridge.block(0, 1);
    let digs = 0;
    const original = bridge.digBlock.bind(bridge);
    // The first dig returns an *ambiguous* receipt: the body may or may not have mined.
    (bridge as unknown as { digBlock: (x: number, y: number, block: string) => unknown }).digBlock = (x: number, y: number, block: string) => {
      digs += 1;
      if (digs === 1) return { accepted: true, ambiguous: true, commandId: 'cmd-ambiguous', block };
      return original(x, y, block);
    };
    const ctx = { bridge, lease: { leaseId: 'l', owner: 'e', resources: [], until: 1, generation: 1, contextEpoch: '' }, report: () => undefined };
    const result = gatherBlocks(ctx as never, 'stone', 3) as { ok: boolean; outcome: string; reason?: string };
    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('ambiguous');
    expect(result.reason).toBe('dig-receipt-indeterminate');
    // Crucially, no further physical mining happened after the indeterminate receipt.
    expect(digs).toBe(1);
  });

  it('still gathers successfully when every receipt is accepted and non-ambiguous', () => {
    const bridge = new FakeClientBridge();
    bridge.block(1, 0); bridge.block(-1, 0); bridge.block(0, 1);
    const ctx = { bridge, lease: { leaseId: 'l', owner: 'e', resources: [], until: 1, generation: 1, contextEpoch: '' }, report: () => undefined };
    const result = gatherBlocks(ctx as never, 'stone', 3) as { ok: boolean; outcome: string; value: { gathered: number } };
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('confirmed');
    expect(result.value.gathered).toBe(3);
  });
});

describe('S04 ActionGateway settlement semantics', () => {
  it('never reports a prepared-but-unsettled effect as confirmed', () => {
    const store = new SQLiteStore(':memory:');
    store.saveExecution({ executionId: 'exec-1', proposalId: 'p-1', proposalHash: 'h', goalId: 'g', skillId: 'dig_one', skillVersion: '1.0.0', status: 'running' });
    const gateway = new ActionGateway(store, () => context);
    const managed = gateway.prepareEffect({ effectId: 'e-1', executionId: 'exec-1', intent: { kind: 'dig' }, logicalActionId: 'action-1', actionOrdinal: 0 });
    expect('effectId' in managed).toBe(true);
    // Settling with a non-confirmed outcome leaves it prepared (may not have been dispatched).
    const settled = gateway.settleEffect('e-1', 'ambiguous', { reason: 'no-proof' });
    expect(settled.status).toBe('applied');
    expect(gateway.status('e-1')).toBe('prepared');
    store.close();
  });

  it('settles a whole logical action atomically and keeps unknown out of success', () => {
    const store = new SQLiteStore(':memory:');
    store.saveExecution({ executionId: 'exec-1', proposalId: 'p-1', proposalHash: 'h', goalId: 'g', skillId: 'gather_blocks', skillVersion: '1.0.0', status: 'running' });
    const gateway = new ActionGateway(store, () => context);
    gateway.prepareEffect({ effectId: 'd0', executionId: 'exec-1', intent: { kind: 'dig', ordinal: 0 }, logicalActionId: 'act', actionOrdinal: 0 });
    gateway.prepareEffect({ effectId: 'd1', executionId: 'exec-1', intent: { kind: 'dig', ordinal: 1 }, logicalActionId: 'act', actionOrdinal: 1 });
    gateway.markDispatched('d0', { barrier: 'pre-dispatch' });
    gateway.markDispatched('d1', { barrier: 'pre-dispatch' });
    const results = gateway.settleLogicalAction('act', 'ambiguous', { reason: 'gather-aborted' });
    expect(results.every(item => item.status === 'applied')).toBe(true);
    expect(gateway.effectsFor('act').map(effect => effect.status)).toEqual(['ambiguous', 'ambiguous']);
    store.close();
  });
});
