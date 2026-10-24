import { SchemaProjector, type PacketEnvelope, type PacketSpec, type ProjectorSchema } from './types.js';

export const CHAT_SCHEMA: ProjectorSchema = {
  id: 'synthetic/chat-v1',
  adapterVersion: 'synthetic-fixture-v1',
  source: 'synthetic',
  release: 'synthetic-fixture',
  packets: {
    chat_message: { fields: { message: 'string', sender: 'string', target: 'string' }, required: ['message'] },
    system_message: { fields: { message: 'string', level: 'string' }, required: ['message'] },
  },
};

export class ChatProjector extends SchemaProjector {
  constructor(schema: ProjectorSchema = CHAT_SCHEMA) { super('chat', schema); }

  protected build(packet: PacketEnvelope, params: Record<string, unknown>, _spec: PacketSpec) {
    const message = this.string(params, 'message');
    if (message === undefined) return { rejection: { code: 'malformed-field' as const, reason: `${packet.name} requires a message string`, packet: packet.name } };
    return {
      availability: 'observed' as const,
      payload: {
        message,
        sender: this.string(params, 'sender') ?? null,
        target: this.string(params, 'target') ?? null,
        level: this.string(params, 'level') ?? null,
      },
    };
  }
}
