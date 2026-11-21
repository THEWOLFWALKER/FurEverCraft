import { SchemaProjector, type PacketEnvelope, type PacketSpec, type ProjectorSchema } from './types.js';

export const POSITION_SCHEMA: ProjectorSchema = {
  id: 'synthetic/position-v1',
  adapterVersion: 'synthetic-fixture-v1',
  source: 'synthetic',
  release: 'synthetic-fixture',
  packets: {
    position: {
      fields: { x: 'number', y: 'number', z: 'number', yawDeg: 'number', pitchDeg: 'number', dimension: 'string', velocity: 'vec3' },
      required: ['x', 'y', 'z'],
    },
    position_correction: {
      fields: { x: 'number', y: 'number', z: 'number', yawDeg: 'number', pitchDeg: 'number' },
      required: ['x', 'y', 'z'],
    },
  },
};

export class PositionProjector extends SchemaProjector {
  constructor(schema: ProjectorSchema = POSITION_SCHEMA) { super('position', schema); }

  protected build(packet: PacketEnvelope, params: Record<string, unknown>, _spec: PacketSpec) {
    const x = this.number(params, 'x'); const y = this.number(params, 'y'); const z = this.number(params, 'z');
    if (x === undefined || y === undefined || z === undefined) {
      return { rejection: { code: 'malformed-field' as const, reason: `${packet.name} coordinates must be finite numbers`, packet: packet.name, field: x === undefined ? 'x' : y === undefined ? 'y' : 'z' } };
    }
    const yawDeg = this.number(params, 'yawDeg');
    const pitchDeg = this.number(params, 'pitchDeg');
    if ((params.yawDeg !== undefined && yawDeg === undefined) || (params.pitchDeg !== undefined && pitchDeg === undefined)) {
      return { rejection: { code: 'malformed-field' as const, reason: `${packet.name} orientation must be finite`, packet: packet.name } };
    }
    const velocity = params.velocity;
    if (velocity !== undefined && (!velocity || typeof velocity !== 'object' || Array.isArray(velocity))) {
      return { rejection: { code: 'malformed-field' as const, reason: `${packet.name} velocity must be a vector`, packet: packet.name } };
    }
    return {
      availability: (yawDeg === undefined || pitchDeg === undefined ? 'degraded' : 'observed') as 'degraded' | 'observed',
      payload: {
        position: { x, y, z },
        orientation: { yawDeg: yawDeg ?? null, pitchDeg: pitchDeg ?? null },
        dimension: this.string(params, 'dimension') ?? null,
        ...(velocity === undefined ? {} : { velocity }),
      },
    };
  }
}
