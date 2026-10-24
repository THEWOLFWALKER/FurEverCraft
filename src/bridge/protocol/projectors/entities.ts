import { SchemaProjector, type PacketEnvelope, type PacketSpec, type ProjectorSchema } from './types.js';

export const ENTITIES_SCHEMA: ProjectorSchema = {
  id: 'synthetic/entities-v1',
  adapterVersion: 'synthetic-fixture-v1',
  source: 'synthetic',
  release: 'synthetic-fixture',
  packets: {
    entity_spawn: { fields: { entityId: 'number', type: 'string', x: 'number', y: 'number', z: 'number', spawnGeneration: 'string' }, required: ['entityId', 'x', 'y', 'z'] },
    entity_move: { fields: { entityId: 'number', x: 'number', y: 'number', z: 'number', yawDeg: 'number', pitchDeg: 'number' }, required: ['entityId', 'x', 'y', 'z'] },
    entity_remove: { fields: { entityId: 'number' }, required: ['entityId'] },
  },
};

export class EntitiesProjector extends SchemaProjector {
  constructor(schema: ProjectorSchema = ENTITIES_SCHEMA) { super('entities', schema); }

  protected build(packet: PacketEnvelope, params: Record<string, unknown>, _spec: PacketSpec) {
    const entityId = this.number(params, 'entityId');
    if (entityId === undefined) return { rejection: { code: 'malformed-field' as const, reason: `${packet.name} requires a numeric entityId`, packet: packet.name } };
    if (packet.name === 'entity_remove') return { availability: 'observed' as const, payload: { entityId, removed: true } };
    const x = this.number(params, 'x'); const y = this.number(params, 'y'); const z = this.number(params, 'z');
    if (x === undefined || y === undefined || z === undefined) return { rejection: { code: 'malformed-field' as const, reason: `${packet.name} requires finite coordinates`, packet: packet.name } };
    return {
      availability: 'observed' as const,
      payload: {
        entityId,
        position: { x, y, z },
        type: this.string(params, 'type') ?? null,
        spawnGeneration: this.string(params, 'spawnGeneration') ?? null,
        orientation: { yawDeg: this.number(params, 'yawDeg') ?? null, pitchDeg: this.number(params, 'pitchDeg') ?? null },
      },
    };
  }
}
