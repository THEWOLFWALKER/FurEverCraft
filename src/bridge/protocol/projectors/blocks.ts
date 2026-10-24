import { SchemaProjector, type PacketEnvelope, type PacketSpec, type ProjectorSchema } from './types.js';

export const BLOCKS_SCHEMA: ProjectorSchema = {
  id: 'synthetic/blocks-v1',
  adapterVersion: 'synthetic-fixture-v1',
  source: 'synthetic',
  release: 'synthetic-fixture',
  packets: {
    block_change: { fields: { x: 'number', y: 'number', z: 'number', block: 'string', stateId: 'number' }, required: ['x', 'y', 'z', 'block'] },
    chunk_delta: { fields: { chunkX: 'number', chunkZ: 'number', sections: 'array', revision: 'string' }, required: ['chunkX', 'chunkZ', 'sections'] },
    chunk_unload: { fields: { chunkX: 'number', chunkZ: 'number' }, required: ['chunkX', 'chunkZ'] },
  },
};

export class BlocksProjector extends SchemaProjector {
  constructor(schema: ProjectorSchema = BLOCKS_SCHEMA) { super('blocks', schema); }

  protected build(packet: PacketEnvelope, params: Record<string, unknown>, _spec: PacketSpec) {
    if (packet.name === 'block_change') {
      const x = this.number(params, 'x'); const y = this.number(params, 'y'); const z = this.number(params, 'z'); const block = this.string(params, 'block');
      if (x === undefined || y === undefined || z === undefined || block === undefined) return { rejection: { code: 'malformed-field' as const, reason: 'block_change requires integer coordinates and a block name', packet: packet.name } };
      return { availability: 'observed' as const, payload: { position: { x, y, z }, block, stateId: this.number(params, 'stateId') ?? null } };
    }
    if (packet.name === 'chunk_delta') {
      const chunkX = this.number(params, 'chunkX'); const chunkZ = this.number(params, 'chunkZ');
      if (chunkX === undefined || chunkZ === undefined || !Array.isArray(params.sections)) return { rejection: { code: 'malformed-field' as const, reason: 'chunk_delta requires chunk coordinates and sections', packet: packet.name } };
      return { availability: 'observed' as const, payload: { chunk: { x: chunkX, z: chunkZ }, sections: params.sections, revision: this.string(params, 'revision') ?? null } };
    }
    const chunkX = this.number(params, 'chunkX'); const chunkZ = this.number(params, 'chunkZ');
    if (chunkX === undefined || chunkZ === undefined) return { rejection: { code: 'malformed-field' as const, reason: 'chunk_unload requires chunk coordinates', packet: packet.name } };
    return { availability: 'observed' as const, payload: { chunk: { x: chunkX, z: chunkZ }, unloaded: true } };
  }
}
