import { describe, expect, it } from 'vitest';
import {
  createSyntheticProjectors,
  projectWith,
  type PacketEnvelope,
  type ProjectionScope,
} from '../../src/bridge/protocol/projectors/index.js';
import { DomainProjectionPipeline } from '../../src/bridge/protocol/projection-pipeline.js';
import { projectPacket } from '../../src/bridge/protocol/domain.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { WorldState } from '../../src/state/world.js';

const scope: ProjectionScope = { serverProfileId: 'p1', dimension: 'overworld', worldGenerationId: 'w1', accountId: 'account-a' };
const packet = (name: string, params: Record<string, unknown>, direction: 'downstream' | 'upstream' = 'downstream'): PacketEnvelope => ({ name, direction, phase: 'PLAY', params });
const input = (sequence: string, envelope: PacketEnvelope, epoch = 'epoch-1', direction: 'downstream' | 'upstream' = 'downstream') => ({ epoch, direction, sequence, packet: envelope, scope });

const positionPacket = () => packet('position', { x: 0, y: 1, z: 2 });

describe('Round 3 — per-direction pipeline uncertainty', () => {
  it('loses only the downstream direction on a downstream sequence gap, and a downstream resync clears only that gap', () => {
    const pipeline = new DomainProjectionPipeline();
    pipeline.start('epoch-1');
    expect(pipeline.project(input('1', positionPacket())).accepted).toBe(true);
    expect(pipeline.project(input('3', positionPacket()))).toMatchObject({ accepted: false, reason: 'sequence-gap' });
    expect(pipeline.stickyUnknown).toContain('sequence-gap:downstream');
    expect(pipeline.state().directionCauses).toEqual({ downstream: expect.stringContaining('sequence-gap:downstream'), upstream: null });

    // The upstream sequence space and control observation are unaffected by a downstream gap.
    expect(pipeline.project(input('1', positionPacket(), 'epoch-1', 'upstream')).accepted).toBe(true);

    pipeline.resync('epoch-1', '3', 'downstream');
    expect(pipeline.stickyUnknown).toBeUndefined();
    expect(pipeline.state()).toMatchObject({ status: 'healthy', globalCause: null, directionCauses: { downstream: null, upstream: null } });
    expect(pipeline.project(input('4', positionPacket())).accepted).toBe(true);
    expect(pipeline.project(input('2', positionPacket(), 'epoch-1', 'upstream')).accepted).toBe(true);
  });

  it('keeps a global control-loss cause and degraded domains across a one-direction resync until both directions are anchored', () => {
    const pipeline = new DomainProjectionPipeline();
    pipeline.start('epoch-1');
    pipeline.noteObservationDrop({ control: true, reason: 'queue-overflow' });
    pipeline.noteObservationDrop({ control: false, domain: 'inventory' });
    expect(pipeline.state()).toMatchObject({ status: 'unknown', globalCause: expect.stringContaining('observation-control-loss') });

    pipeline.resync('epoch-1', '5', 'downstream');
    expect(pipeline.stickyUnknown).toContain('observation-control-loss');
    expect(pipeline.state().globalCause).toContain('observation-control-loss');
    expect(pipeline.state().directionCauses).toEqual({ downstream: null, upstream: null });
    // A local domain's degradation is not evidence that the control cause is resolved.
    expect(pipeline.degradedDomains).toEqual(['inventory']);
    expect(pipeline.project(input('6', positionPacket()))).toMatchObject({ accepted: false, reason: 'sticky-unknown' });

    pipeline.resync('epoch-1', '5', 'upstream');
    expect(pipeline.state()).toMatchObject({ globalCause: null, directionCauses: { downstream: null, upstream: null } });
    expect(pipeline.degradedDomains).toEqual(['inventory']);
    expect(pipeline.project(input('6', positionPacket()))).toMatchObject({ accepted: true, degradedDomains: ['inventory'] });
  });

  it('treats an upstream gap as global until upstream itself is anchored', () => {
    const pipeline = new DomainProjectionPipeline();
    pipeline.start('epoch-1');
    expect(pipeline.project(input('1', positionPacket(), 'epoch-1', 'upstream')).accepted).toBe(true);
    expect(pipeline.project(input('3', positionPacket(), 'epoch-1', 'upstream'))).toMatchObject({ accepted: false, reason: 'sequence-gap' });
    expect(pipeline.state().globalCause).toContain('sequence-gap:upstream');
    expect(pipeline.project(input('1', positionPacket()))).toMatchObject({ accepted: false, reason: 'sticky-unknown' });

    // Anchoring the unaffected direction cannot clear control-relevant uncertainty.
    pipeline.resync('epoch-1', '1', 'downstream');
    expect(pipeline.state().globalCause).toContain('sequence-gap:upstream');
    expect(pipeline.project(input('4', positionPacket(), 'epoch-1', 'upstream'))).toMatchObject({ accepted: false, reason: 'sticky-unknown' });

    pipeline.resync('epoch-1', '3', 'upstream');
    expect(pipeline.state().globalCause).toBeNull();
    expect(pipeline.project(input('2', positionPacket()))).toMatchObject({ accepted: true });
    expect(pipeline.project(input('4', positionPacket(), 'epoch-1', 'upstream'))).toMatchObject({ accepted: true });
  });

  it('rejects a resync for a different epoch but allows an explicit new session start, and resyncAll clears global state', () => {
    const pipeline = new DomainProjectionPipeline();
    pipeline.start('epoch-1');
    pipeline.noteObservationDrop({ control: true, reason: 'helper-exit' });
    pipeline.noteObservationDrop({ control: false, domain: 'chat' });
    expect(() => pipeline.resync('epoch-old', '1')).toThrow('stale-epoch');
    expect(() => pipeline.resyncAll('epoch-old', { downstream: '1' })).toThrow('stale-epoch');
    expect(pipeline.epoch).toBe('epoch-1');
    expect(pipeline.state().globalCause).toContain('observation-control-loss');

    pipeline.resyncAll('epoch-1', { downstream: '1', upstream: '1' });
    expect(pipeline.state()).toMatchObject({ status: 'healthy', stickyUnknown: null, globalCause: null, degradedDomains: [] });
    expect(pipeline.project(input('2', positionPacket()))).toMatchObject({ accepted: true });

    // A new session is started explicitly, never by resyncing into a different epoch.
    pipeline.start('epoch-2');
    expect(pipeline.epoch).toBe('epoch-2');
    expect(pipeline.state()).toMatchObject({ status: 'healthy', globalCause: null });
    expect(pipeline.project(input('1', positionPacket(), 'epoch-2')).accepted).toBe(true);
    expect(pipeline.project(input('1', positionPacket(), 'epoch-1'))).toMatchObject({ accepted: false, reason: 'stale-epoch' });
  });
});

describe('Round 5 — projection scope fencing and resynchronisation anchors', () => {
  it('binds the scope on the first projection and rejects a different account/world/dimension/server profile', () => {
    const pipeline = new DomainProjectionPipeline();
    pipeline.start('epoch-1');
    expect(pipeline.project(input('1', positionPacket())).accepted).toBe(true);
    // The exact reported case: same epoch and sequence, different account, must not be sequenced.
    expect(pipeline.project({ ...input('1', positionPacket()), scope: { ...scope, accountId: 'account-b' } })).toMatchObject({ accepted: false, reason: 'scope-mismatch' });
    const changes = [
      ['accountId', 'account-b'],
      ['worldGenerationId', 'w2'],
      ['dimension', 'nether'],
      ['serverProfileId', 'p2'],
    ] as const;
    for (let index = 0; index < changes.length; index += 1) {
      const [field, value] = changes[index]!;
      const sequence = String(index + 2);
      const mismatched = pipeline.project({ ...input(sequence, positionPacket()), scope: { ...scope, [field]: value } });
      expect(mismatched, field).toMatchObject({ accepted: false, reason: 'scope-mismatch' });
      if (!mismatched.accepted) expect(mismatched.detail).toContain(field);
      // A rejected scope never advances the sequence for the next legitimate packet.
      expect(pipeline.state().lastSequences.downstream).toBe(String(index + 1));
      expect(pipeline.project(input(sequence, positionPacket())).accepted, field).toBe(true);
    }
    expect(pipeline.scope).toEqual(scope);

    // Only an explicit new session may rebind the scope.
    const rebounded = { ...scope, accountId: 'account-b' };
    pipeline.start('epoch-2', {}, rebounded);
    expect(pipeline.scope).toEqual(rebounded);
    expect(pipeline.project({ ...input('1', positionPacket(), 'epoch-2'), scope: rebounded }).accepted).toBe(true);
    expect(pipeline.project({ ...input('2', positionPacket(), 'epoch-2'), scope })).toMatchObject({ accepted: false, reason: 'scope-mismatch' });
  });

  it('rejects non-decimal and non-advancing resync anchors without moving the fence', () => {
    const pipeline = new DomainProjectionPipeline();
    pipeline.start('epoch-1');
    expect(pipeline.project(input('100', positionPacket())).accepted).toBe(true);

    expect(() => pipeline.resync('epoch-1', 'not-a-number')).not.toThrow();
    expect(pipeline.resync('epoch-1', 'not-a-number')).toMatchObject({ accepted: false, reason: 'invalid-resync-sequence' });
    expect(pipeline.resync('epoch-1', '')).toMatchObject({ accepted: false, reason: 'invalid-resync-sequence' });
    expect(pipeline.resyncAll('epoch-1', { downstream: '1.5' })).toMatchObject({ accepted: false, reason: 'invalid-resync-sequence' });
    expect(pipeline.resync('epoch-1', '1')).toMatchObject({ accepted: false, reason: 'stale-resync-sequence' });
    expect(pipeline.resync('epoch-1', '100')).toMatchObject({ accepted: false, reason: 'stale-resync-sequence' });
    expect(pipeline.resyncAll('epoch-1', { downstream: '50' })).toMatchObject({ accepted: false, reason: 'stale-resync-sequence' });

    expect(pipeline.state().lastSequences.downstream).toBe('100');
    expect(pipeline.project(input('2', positionPacket()))).toMatchObject({ accepted: false, reason: 'stale-sequence' });
    expect(pipeline.project(input('101', positionPacket())).accepted).toBe(true);
  });
});

describe('Round 3 — nested unknown variable-length data', () => {
  const projectors = createSyntheticProjectors();

  const expectRejected = (name: string, params: Record<string, unknown>, field: string) => {
    const { result } = projectWith(projectors, packet(name, params), scope, 's', '1');
    expect(result.ok, `${name} with nested ${field} must be rejected`).toBe(false);
    if (!result.ok) expect(result.rejection).toMatchObject({ code: 'unknown-var-length-field', field });
  };

  it('rejects nested containers/strings inside declared arrays instead of silently stripping them', () => {
    expectRejected('window_items', { windowId: 0, slots: [{ slot: 0, components: ['minecraft:custom_data'] }] }, 'slots[0].components');
    expectRejected('window_items', { windowId: 0, slots: [{ slot: 0, item: { id: 'minecraft:stone' } }] }, 'slots[0].item.id');
    expectRejected('window_items', { windowId: 0, slots: [new Uint8Array([1, 2])] }, 'slots[0]');
    expectRejected('chunk_delta', { chunkX: 0, chunkZ: 0, sections: [{ y: 0, palette: ['minecraft:stone'] }] }, 'sections[0].palette');
    expectRejected('inventory_update', { slots: [0, { slot: 1, label: 'opaque' }] }, 'slots[1].label');
  });

  it('rejects extra keys outside a declared safe nested shape', () => {
    expectRejected('position', { x: 0, y: 0, z: 0, velocity: { x: 1, y: 2, z: 3, extra: { opaque: true } } }, 'velocity.extra');
    expectRejected('position', { x: 0, y: 0, z: 0, velocity: { x: 1, y: 2, z: 3, extra: 'opaque' } }, 'velocity.extra');
    expectRejected('position', { x: 0, y: 0, z: 0, velocity: { x: 'opaque', y: 2, z: 3 } }, 'velocity.x');
  });

  it('still accepts declared arrays/objects that contain only primitives', () => {
    const slots = projectWith(projectors, packet('window_items', { windowId: 0, slots: [0, 1, true, null, { slot: 0, count: 2 }] }), scope, 's', '1');
    expect(slots.result.ok).toBe(true);
    const sections = projectWith(projectors, packet('chunk_delta', { chunkX: 0, chunkZ: 0, sections: [0, 1, { y: 0, revision: 2 }] }), scope, 's', '2');
    expect(sections.result.ok).toBe(true);
    const velocity = projectWith(projectors, packet('position', { x: 0, y: 1, z: 2, velocity: { x: 1, y: 2, z: 3 } }), scope, 's', '3');
    expect(velocity.result.ok).toBe(true);
    if (velocity.result.ok) expect(velocity.result.projection.payload.velocity).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('Round 3 — WorldState snapshot and epoch fencing', () => {
  const ctx = { serverProfileId: 'simulated', worldGenerationId: 'world-1', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' } as const;
  const observation = (bridge: FakeClientBridge, sequence: string, baseline: 'full' | 'delta' = 'delta', sourceEpoch = bridge.sessionEpoch) => ({
    ...bridge.snapshot(), observedAt: 0, sequence, sourceEpoch, ttl: 100, baseline,
  });

  it('ignores a same-epoch full snapshot that does not advance the sequence', () => {
    const bridge = new FakeClientBridge(4);
    const state = new WorldState(ctx);
    const first = state.apply(observation(bridge, '5', 'full'));
    bridge.block(2, 2);
    const sameSequence = state.apply(observation(bridge, '5', 'full'));
    expect(sameSequence.revision).toBe(first.revision);
    expect(sameSequence.cells['2,2']).toBe('free');
    const older = state.apply(observation(bridge, '4', 'full'));
    expect(older.revision).toBe(first.revision);
    expect(older.cells['2,2']).toBe('free');
  });

  it('rejects a full snapshot from a superseded source epoch but accepts an unseen epoch without ordering its sequence', () => {
    const bridge = new FakeClientBridge(4);
    const state = new WorldState(ctx);
    state.apply(observation(bridge, '100', 'full', '1:1'));
    bridge.disconnect();
    // The unseen epoch is accepted by its full baseline even though its sequence is lower.
    const newer = state.apply(observation(bridge, '1', 'full', '1:2'));
    expect(newer.gap).toBe(false);
    expect(state.snapshot().position).toEqual(bridge.position);
    const before = state.snapshot();
    expect(() => state.apply(observation(bridge, '101', 'full', '1:1'))).toThrow('stale-source-epoch');
    expect(state.snapshot().revision).toBe(before.revision);
  });

  it('keeps a gap:true full snapshot unknown and only an explicit full baseline without gap clears it', () => {
    const bridge = new FakeClientBridge(4);
    const state = new WorldState(ctx, () => 0);
    expect(state.apply(observation(bridge, '1', 'full')).gap).toBe(false);
    bridge.block(1, 1);

    const gappedFull = state.apply({ ...observation(bridge, '2', 'full'), gap: true });
    expect(gappedFull.gap).toBe(true);
    expect(gappedFull.freshness).toBe('unknown');
    expect(gappedFull.cells['1,1']).toBe('unknown');
    expect(Object.values(gappedFull.fields).every(field => field.available === false && field.freshness === 'unknown')).toBe(true);

    // Deltas stay sticky while the gap is unresolved.
    expect(state.apply(observation(bridge, '3')).gap).toBe(true);

    const clean = state.apply(observation(bridge, '4', 'full'));
    expect(clean.gap).toBe(false);
    expect(clean.cells['1,1']).toBe('blocked');
  });

  it('does not merge a known account with a different or unknown account', () => {
    const state = new WorldState({ ...ctx, accountId: 'account-a' });
    const accountA = new FakeClientBridge(4, { context: { accountId: 'account-a' } });
    expect(state.apply(observation(accountA, '1', 'full')).gap).toBe(false);

    const accountB = new FakeClientBridge(4, { context: { accountId: 'account-b' } });
    expect(() => state.apply(observation(accountB, '2', 'full'))).toThrow('world-context-mismatch');
    const anonymous = new FakeClientBridge(4);
    expect(() => state.apply(observation(anonymous, '3', 'full'))).toThrow('world-context-mismatch');

    // Both unknown is allowed; the account is only a mismatch when one side knows it.
    const unknownState = new WorldState(ctx);
    expect(unknownState.apply(observation(anonymous, '1', 'full')).gap).toBe(false);
  });
});

describe('Round 3 — projection scope carries account identity', () => {
  it('propagates accountId through direct projections, the pipeline and the fixture domain projector', () => {
    const projectors = createSyntheticProjectors();
    const direct = projectWith(projectors, positionPacket(), scope, 'session-1', '1');
    expect(direct.result.ok).toBe(true);
    if (direct.result.ok) expect(direct.result.projection.scope).toEqual(scope);

    const pipeline = new DomainProjectionPipeline();
    pipeline.start('epoch-1');
    const piped = pipeline.project(input('1', positionPacket()));
    expect(piped.accepted).toBe(true);
    if (piped.accepted) expect(piped.projection.scope).toEqual(scope);

    const domain = projectPacket({ name: 'position', direction: 'upstream', phase: 'PLAY', params: { x: 1, y: 2 } }, scope, 'session-1', '1');
    expect(domain.scope).toEqual(scope);
  });
});
