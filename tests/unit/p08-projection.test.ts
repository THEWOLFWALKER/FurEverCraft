import { describe, expect, it } from 'vitest';
import {
  createSyntheticProjectors,
  hashSchema,
  projectWith,
  realProjectionAvailability,
  type DomainProjection,
  type PacketEnvelope,
  type ProjectionScope,
} from '../../src/bridge/protocol/projectors/index.js';
import { BoundedObservationQueue, DomainProjectionPipeline } from '../../src/bridge/protocol/projection-pipeline.js';
import { POSITION_SCHEMA } from '../../src/bridge/protocol/projectors/position.js';

const scope: ProjectionScope = { serverProfileId: 'p1', dimension: 'overworld', worldGenerationId: 'w1' };
const packet = (name: string, params: Record<string, unknown>, direction: 'downstream' | 'upstream' = 'downstream'): PacketEnvelope => ({ name, direction, phase: 'PLAY', params });

const valid: Array<[string, Record<string, unknown>, DomainProjection['kind']]> = [
  ['position', { x: 1.5, y: 64, z: -3.25, yawDeg: 90, pitchDeg: 0 }, 'position'],
  ['position_correction', { x: 0, y: 2, z: 0, yawDeg: 0, pitchDeg: 0 }, 'position'],
  ['block_change', { x: 1, y: 2, z: 3, block: 'minecraft:stone' }, 'blocks'],
  ['chunk_delta', { chunkX: 0, chunkZ: 4, sections: [] }, 'blocks'],
  ['chunk_unload', { chunkX: 0, chunkZ: 4 }, 'blocks'],
  ['entity_spawn', { entityId: 9, x: 1, y: 2, z: 3, type: 'minecraft:zombie' }, 'entities'],
  ['entity_move', { entityId: 9, x: 2, y: 2, z: 3 }, 'entities'],
  ['entity_remove', { entityId: 9 }, 'entities'],
  ['window_items', { windowId: 0, slots: [] }, 'inventory'],
  ['inventory_update', { slots: [] }, 'inventory'],
  ['ui_mode', { mode: 'inventory' }, 'inventory'],
  ['held_slot', { slot: 2 }, 'inventory'],
  ['chat_message', { message: 'hello', sender: 'steve' }, 'chat'],
  ['system_message', { message: 'joined', level: 'info' }, 'chat'],
  ['join_game', { dimension: 'minecraft:overworld', entityId: 1 }, 'lifecycle'],
  ['respawn', { dimension: 'minecraft:overworld' }, 'lifecycle'],
  ['death', { cause: 'fall' }, 'lifecycle'],
  ['disconnect', { reason: 'bye' }, 'lifecycle'],
  ['game_mode', { mode: 'survival' }, 'lifecycle'],
  ['set_protocol', { protocolVersion: 765, nextState: 2 }, 'lifecycle'],
];

describe('P08 independent domain projectors', () => {
  it('projects every synthetic family with provenance and scope', () => {
    const projectors = createSyntheticProjectors();
    const kinds = new Set<string>();
    for (const [name, params, kind] of valid) {
      const { projector, result } = projectWith(projectors, packet(name, params), scope, 'session-1', '1');
      expect(result.ok, `${name} should project`).toBe(true);
      if (!result.ok) continue;
      expect(result.projection.kind).toBe(kind);
      expect(result.projection.packet).toBe(name);
      expect(result.projection.provenance).toMatchObject({ source: 'synthetic', adapterVersion: 'synthetic-fixture-v1', release: 'synthetic-fixture' });
      expect(result.projection.provenance.schemaHash).toHaveLength(64);
      expect(result.projection.scope).toEqual(scope);
      expect(result.projection.evidence).toEqual({ direction: 'downstream', phase: 'PLAY' });
      expect(projector?.family).toBe(kind);
      kinds.add(result.projection.kind);
    }
    expect([...kinds].sort()).toEqual(['blocks', 'chat', 'entities', 'inventory', 'lifecycle', 'position']);
  });

  it('uses one owner per packet family instead of letting every projector claim it', () => {
    const projectors = createSyntheticProjectors();
    for (const name of ['position', 'block_change', 'entity_spawn', 'window_items', 'chat_message', 'join_game']) {
      expect(projectors.filter(projector => projector.handles(name))).toHaveLength(1);
    }
    expect(projectors.filter(projector => projector.handles('mystery_packet'))).toHaveLength(0);
  });

  it('rejects the whole packet when an unknown variable-length field would have to be skipped', () => {
    const projectors = createSyntheticProjectors();
    const { result } = projectWith(projectors, packet('chat_message', { message: 'hi', mysterious: 'variable-length-data' }), scope, 's', '1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection).toMatchObject({ code: 'unknown-var-length-field', field: 'mysterious' });

    const declared = projectWith(projectors, { ...packet('inventory_update', { slots: [] }), unknownVarLengthFields: ['components'] }, scope, 's', '2');
    expect(declared.result.ok).toBe(false);
    if (!declared.result.ok) expect(declared.result.rejection.code).toBe('unknown-var-length-field');
  });

  it('rejects missing and malformed required fields without fabricating defaults', () => {
    const projectors = createSyntheticProjectors();
    const missing = projectWith(projectors, packet('position', { x: 1, y: 2 }), scope, 's', '1');
    expect(missing.result.ok).toBe(false);
    if (!missing.result.ok) expect(missing.result.rejection).toMatchObject({ code: 'missing-required-field', field: 'z' });

    const malformed = projectWith(projectors, packet('position', { x: 'nope', y: 2, z: 3 }), scope, 's', '2');
    expect(malformed.result.ok).toBe(false);
    if (!malformed.result.ok) expect(malformed.result.rejection.code).toBe('malformed-field');

    // Three-dimensional contract: a plane coordinate is never filled in as z=0.
    const planar = projectWith(projectors, packet('position', { x: 1, y: 2, z: undefined as unknown as number }), scope, 's', '3');
    expect(planar.result.ok).toBe(false);
  });

  it('reports a differing schema hash when the schema content changes', () => {
    const alternate = { ...POSITION_SCHEMA, adapterVersion: 'synthetic-fixture-v2' };
    expect(hashSchema(alternate)).not.toBe(hashSchema(POSITION_SCHEMA));
  });

  it('labels synthetic projectors as assembly-only and real 26.3 projection as unavailable', () => {
    expect(realProjectionAvailability()).toMatchObject({
      release: '26.3', real26_3Projectors: 'unavailable', syntheticFixture: 'assembly-only', reason: '26.3-codec-data-unavailable',
    });
  });
});

describe('P08 ordered projection pipeline', () => {
  const make = () => new DomainProjectionPipeline();
  const input = (sequence: string, envelope: PacketEnvelope, epoch = 'epoch-1', direction: 'downstream' | 'upstream' = 'downstream') => ({ epoch, direction, sequence, packet: envelope, scope });

  it('accepts ordered packets and records provenance and sequence', () => {
    const pipeline = make();
    pipeline.start('epoch-1');
    const first = pipeline.project(input('1', packet('position', { x: 0, y: 1, z: 2 })));
    expect(first.accepted).toBe(true);
    if (first.accepted) {
      expect(first.projection.sequence).toBe('1');
      expect(first.projection.sessionEpoch).toBe('epoch-1');
      expect(first.projection.provenance.schemaId).toBe('synthetic/position-v1');
    }
    expect(pipeline.state()).toMatchObject({ status: 'healthy', epoch: 'epoch-1', lastSequences: { downstream: '1', upstream: null } });
  });

  it('requires an explicit trusted epoch before accepting observations', () => {
    const pipeline = make();
    expect(pipeline.project(input('1', packet('position', { x: 0, y: 1, z: 2 })))).toMatchObject({ accepted: false, reason: 'epoch-required' });
    expect(pipeline.epoch).toBeUndefined();
    pipeline.start('epoch-1');
    expect(pipeline.project(input('1', packet('position', { x: 0, y: 1, z: 2 }))).accepted).toBe(true);
  });

  it('turns a sequence gap into sticky global unknown until an explicit resync', () => {
    const pipeline = make();
    pipeline.start('epoch-1');
    expect(pipeline.project(input('1', packet('position', { x: 0, y: 1, z: 2 }))).accepted).toBe(true);
    const gap = pipeline.project(input('3', packet('position', { x: 0, y: 1, z: 2 })));
    expect(gap).toMatchObject({ accepted: false, reason: 'sequence-gap' });
    expect(pipeline.stickyUnknown).toContain('sequence-gap:downstream');
    expect(pipeline.project(input('4', packet('position', { x: 0, y: 1, z: 2 })))).toMatchObject({ accepted: false, reason: 'sticky-unknown' });
    pipeline.resync('epoch-1', '4');
    expect(pipeline.stickyUnknown).toBeUndefined();
    expect(pipeline.project(input('5', packet('position', { x: 0, y: 1, z: 2 }))).accepted).toBe(true);
  });

  it('rejects stale epochs and non-increasing sequences', () => {
    const pipeline = make();
    pipeline.start('epoch-1');
    expect(pipeline.project(input('1', packet('position', { x: 0, y: 1, z: 2 }))).accepted).toBe(true);
    expect(pipeline.project(input('2', packet('position', { x: 0, y: 1, z: 2 }), 'epoch-old'))).toMatchObject({ accepted: false, reason: 'stale-epoch' });
    expect(pipeline.project(input('1', packet('position', { x: 0, y: 1, z: 2 })))).toMatchObject({ accepted: false, reason: 'stale-sequence' });
    // Directions have independent sequence spaces.
    expect(pipeline.project(input('1', packet('position', { x: 0, y: 1, z: 2 }), 'epoch-1', 'upstream')).accepted).toBe(true);
  });

  it('keeps sticky unknown when a possible control packet cannot be classified', () => {
    const pipeline = make();
    pipeline.start('epoch-1');
    const result = pipeline.project(input('1', packet('mystery_control', { opaque: 'bytes' })));
    expect(result).toMatchObject({ accepted: false, reason: 'rejected-packet' });
    expect(pipeline.state().status).toBe('unknown');
    expect(pipeline.stickyUnknown).toContain('control-unknown:mystery_control');
    expect(pipeline.project(input('2', packet('position', { x: 0, y: 1, z: 2 })))).toMatchObject({ accepted: false, reason: 'sticky-unknown' });
  });

  it('degrades only the affected non-control domain for a malformed packet', () => {
    const pipeline = make();
    pipeline.start('epoch-1');
    const rejected = pipeline.project(input('1', packet('chunk_delta', { chunkX: 0, chunkZ: 0 })));
    expect(rejected).toMatchObject({ accepted: false, reason: 'rejected-packet' });
    expect(pipeline.stickyUnknown).toBeUndefined();
    expect(pipeline.degradedDomains).toEqual(['blocks']);
    expect(pipeline.state().status).toBe('degraded');
    const position = pipeline.project(input('2', packet('position', { x: 0, y: 1, z: 2 })));
    expect(position.accepted).toBe(true);
    if (position.accepted) expect(position.degradedDomains).toEqual(['blocks']);
  });

  it('treats control loss as global and non-control loss as local', () => {
    const pipeline = make();
    pipeline.start('epoch-1');
    pipeline.noteObservationDrop({ control: false, domain: 'inventory' });
    expect(pipeline.stickyUnknown).toBeUndefined();
    expect(pipeline.degradedDomains).toEqual(['inventory']);
    pipeline.noteObservationDrop({ control: true, reason: 'queue-overflow' });
    expect(pipeline.state().status).toBe('unknown');
    expect(pipeline.stickyUnknown).toContain('observation-control-loss:queue-overflow');
  });

  it('bounds the observation queue and reports which items were dropped', () => {
    const queue = new BoundedObservationQueue({ maxItems: 2, maxBytes: 100 });
    expect(queue.push({ sequence: '1', control: false, bytes: 10 }).accepted).toBe(true);
    expect(queue.push({ sequence: '2', control: true, domain: 'lifecycle', bytes: 10 }).accepted).toBe(true);
    const third = queue.push({ sequence: '3', control: false, bytes: 10 });
    expect(third.dropped).toHaveLength(1);
    expect(third.dropped[0]).toMatchObject({ item: { sequence: '1' }, reason: 'count' });
    expect(queue.drain().map(item => item.sequence)).toEqual(['2', '3']);
    expect(queue.size()).toEqual({ items: 0, bytes: 0 });
    const tooLarge = queue.push({ sequence: '4', control: true, bytes: 101 });
    expect(tooLarge.accepted).toBe(false);
    expect(tooLarge.dropped.some(drop => drop.reason === 'bytes')).toBe(true);
  });
});
