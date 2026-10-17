import type { BridgePacket } from './session.js';

/**
 * Domain projection for decoded protocol packets. The current codec is the legacy
 * fixture, so only the packet families that fixture can actually emit are mapped; every
 * other packet becomes an explicit `unknown` observation instead of disappearing.
 * Sources stay labelled `fixture` and are never promoted to live-client evidence.
 */
export type DomainKind = 'position' | 'health' | 'inventory' | 'chat' | 'entity' | 'chunk' | 'registry' | 'unknown';
export type DomainAvailability = 'observed' | 'predicted' | 'unknown' | 'degraded';

export type DomainProjection = {
  kind: DomainKind;
  source: 'fixture';
  availability: DomainAvailability;
  sessionEpoch: string;
  sequence: string;
  /** Stable scope so projections from another world/account cannot be merged. */
  scope: { serverProfileId: string; dimension: string; worldGenerationId: string };
  payload: Record<string, unknown>;
  evidence: { packet: string; direction: string; phase: string };
};

export type ProjectionScope = { serverProfileId: string; dimension: string; worldGenerationId: string };

const number = (input: unknown): number | undefined => (typeof input === 'number' && Number.isFinite(input) ? input : undefined);

export function projectPacket(packet: BridgePacket, scope: ProjectionScope, sessionEpoch: string, sequence: string): DomainProjection {
  const base = { source: 'fixture' as const, sessionEpoch, sequence, scope, evidence: { packet: packet.name, direction: packet.direction, phase: packet.phase } };
  const params = packet.params ?? {};
  switch (packet.name) {
    case 'position': {
      const x = number(params.x); const y = number(params.y);
      if (x === undefined || y === undefined) return { ...base, kind: 'unknown', availability: 'unknown', payload: { reason: 'position-missing-coordinates' } };
      return { ...base, kind: 'position', availability: 'observed', payload: { x, y } };
    }
    case 'chat_message': {
      const message = typeof params.message === 'string' ? params.message : undefined;
      if (message === undefined) return { ...base, kind: 'unknown', availability: 'unknown', payload: { reason: 'chat-missing-message' } };
      return { ...base, kind: 'chat', availability: 'observed', payload: { message, sender: typeof params.sender === 'string' ? params.sender : undefined } };
    }
    case 'set_protocol': {
      const protocolVersion = number(params.protocolVersion);
      return { ...base, kind: 'registry', availability: protocolVersion === undefined ? 'degraded' : 'observed', payload: { protocolVersion, nextState: number(params.nextState) } };
    }
    default:
      return { ...base, kind: 'unknown', availability: 'unknown', payload: { reason: 'unsupported-packet-family', name: packet.name } };
  }
}
