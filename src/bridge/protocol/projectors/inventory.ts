import { SchemaProjector, type PacketEnvelope, type PacketSpec, type ProjectorSchema } from './types.js';

export const INVENTORY_SCHEMA: ProjectorSchema = {
  id: 'synthetic/inventory-v1',
  adapterVersion: 'synthetic-fixture-v1',
  source: 'synthetic',
  release: 'synthetic-fixture',
  packets: {
    window_items: { fields: { windowId: 'number', stateId: 'number', slots: 'array' }, required: ['windowId', 'slots'] },
    inventory_update: { fields: { slots: 'array', stateId: 'number' }, required: ['slots'] },
    ui_mode: { fields: { mode: 'string', stateId: 'number' }, required: ['mode'] },
    held_slot: { fields: { slot: 'number' }, required: ['slot'] },
  },
};

export class InventoryProjector extends SchemaProjector {
  constructor(schema: ProjectorSchema = INVENTORY_SCHEMA) { super('inventory', schema); }

  protected build(packet: PacketEnvelope, params: Record<string, unknown>, _spec: PacketSpec) {
    if (packet.name === 'ui_mode') {
      const mode = this.string(params, 'mode');
      if (!mode) return { rejection: { code: 'malformed-field' as const, reason: 'ui_mode requires a mode string', packet: packet.name } };
      return { availability: 'observed' as const, payload: { uiMode: mode, stateId: this.number(params, 'stateId') ?? null } };
    }
    if (packet.name === 'held_slot') {
      const slot = this.number(params, 'slot');
      if (slot === undefined) return { rejection: { code: 'malformed-field' as const, reason: 'held_slot requires a numeric slot', packet: packet.name } };
      return { availability: 'observed' as const, payload: { heldSlot: slot } };
    }
    if (!Array.isArray(params.slots)) return { rejection: { code: 'malformed-field' as const, reason: `${packet.name} requires a slots array`, packet: packet.name } };
    return {
      availability: 'observed' as const,
      payload: {
        windowId: this.number(params, 'windowId') ?? null,
        stateId: this.number(params, 'stateId') ?? null,
        slots: params.slots,
      },
    };
  }
}
