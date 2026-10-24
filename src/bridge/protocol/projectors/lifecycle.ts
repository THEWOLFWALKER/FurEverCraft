import { SchemaProjector, type PacketEnvelope, type PacketSpec, type ProjectorSchema } from './types.js';

export const LIFECYCLE_SCHEMA: ProjectorSchema = {
  id: 'synthetic/lifecycle-v1',
  adapterVersion: 'synthetic-fixture-v1',
  source: 'synthetic',
  release: 'synthetic-fixture',
  packets: {
    join_game: { fields: { dimension: 'string', entityId: 'number', worldGenerationId: 'string' }, required: ['dimension'] },
    respawn: { fields: { dimension: 'string', entityId: 'number' }, required: ['dimension'] },
    death: { fields: { cause: 'string' }, required: [] },
    disconnect: { fields: { reason: 'string' }, required: [] },
    game_mode: { fields: { mode: 'string' }, required: ['mode'] },
    set_protocol: { fields: { protocolVersion: 'number', nextState: 'number' }, required: ['protocolVersion'] },
  },
};

export class LifecycleProjector extends SchemaProjector {
  constructor(schema: ProjectorSchema = LIFECYCLE_SCHEMA) { super('lifecycle', schema); }

  protected build(packet: PacketEnvelope, params: Record<string, unknown>, _spec: PacketSpec) {
    if (packet.name === 'set_protocol') {
      const protocolVersion = this.number(params, 'protocolVersion');
      if (protocolVersion === undefined) return { rejection: { code: 'malformed-field' as const, reason: 'set_protocol requires protocolVersion', packet: packet.name } };
      return { availability: 'observed' as const, payload: { protocolVersion, nextState: this.number(params, 'nextState') ?? null } };
    }
    if (packet.name === 'game_mode') {
      const mode = this.string(params, 'mode');
      if (mode === undefined) return { rejection: { code: 'malformed-field' as const, reason: 'game_mode requires mode', packet: packet.name } };
      return { availability: 'observed' as const, payload: { mode } };
    }
    return {
      availability: 'observed' as const,
      payload: {
        event: packet.name,
        dimension: this.string(params, 'dimension') ?? null,
        entityId: this.number(params, 'entityId') ?? null,
        worldGenerationId: this.string(params, 'worldGenerationId') ?? null,
        cause: this.string(params, 'cause') ?? null,
        reason: this.string(params, 'reason') ?? null,
      },
    };
  }
}
