import { createHash } from 'node:crypto';

/**
 * Shared contracts for the independent domain projectors. Each family has its own
 * projector and schema provenance; a packet is only projected by the family that owns
 * it. An unknown variable-length field means the whole packet cannot be parsed safely,
 * so it is rejected rather than skipped.
 */
export type ProjectionDirection = 'downstream' | 'upstream';
export type ProjectionSource = 'fixture' | 'synthetic';
export type DomainFamily = 'position' | 'blocks' | 'entities' | 'inventory' | 'chat' | 'lifecycle';
export type ProjectionScope = { serverProfileId: string; dimension: string; worldGenerationId: string };
export type FieldKind = 'number' | 'string' | 'boolean' | 'vec3' | 'array' | 'object' | 'bytes';
export type PacketSpec = { fields: Record<string, FieldKind>; required: string[]; variableLength?: string[] };
export type ProjectorSchema = { id: string; adapterVersion: string; source: ProjectionSource; release: string; packets: Record<string, PacketSpec> };
export type Provenance = { schemaId: string; schemaHash: string; adapterVersion: string; source: ProjectionSource; release: string };
export type PacketEnvelope = {
  name: string;
  direction: ProjectionDirection;
  phase: string;
  params?: Record<string, unknown>;
  /** Fields the decoder already knows are unknown variable-length data. */
  unknownVarLengthFields?: string[];
};
export type DomainProjection = {
  kind: DomainFamily | 'unknown';
  packet: string;
  source: ProjectionSource;
  availability: 'observed' | 'degraded' | 'unknown';
  sessionEpoch: string;
  sequence: string;
  scope: ProjectionScope;
  provenance: Provenance;
  payload: Record<string, unknown>;
  evidence: { direction: ProjectionDirection; phase: string };
};
export type ProjectionRejectionCode = 'unknown-packet-family' | 'unknown-var-length-field' | 'missing-required-field' | 'malformed-field';
export type ProjectionRejection = { code: ProjectionRejectionCode; reason: string; packet: string; field?: string };
export type ProjectionResult = { ok: true; projection: DomainProjection } | { ok: false; rejection: ProjectionRejection };

export interface DomainProjector {
  readonly family: DomainFamily;
  handles(packetName: string): boolean;
  project(packet: PacketEnvelope, scope: ProjectionScope, sessionEpoch: string, sequence: string): ProjectionResult;
}

export function hashSchema(schema: ProjectorSchema): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, normalize((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(normalize(schema))).digest('hex');
}

export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const isString = (value: unknown): value is string => typeof value === 'string';
export const isPlainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);

/** Variable-length data cannot be skipped: an unknown one rejects the whole packet. */
export function unknownVarLengthField(packet: PacketEnvelope, spec: PacketSpec): string | undefined {
  const explicit = packet.unknownVarLengthFields?.find(field => !(spec.variableLength ?? []).includes(field));
  if (explicit) return explicit;
  for (const [key, value] of Object.entries(packet.params ?? {})) {
    if (spec.fields[key]) continue;
    if (typeof value === 'string' || Array.isArray(value) || ArrayBuffer.isView(value) || isPlainObject(value)) return key;
  }
  return undefined;
}

export abstract class SchemaProjector implements DomainProjector {
  readonly schemaHash: string;
  private readonly handled = new Set<string>();
  constructor(readonly family: DomainFamily, protected readonly schema: ProjectorSchema) {
    this.schemaHash = hashSchema(schema);
    for (const name of Object.keys(schema.packets)) this.handled.add(name);
  }

  handles(packetName: string): boolean { return this.handled.has(packetName); }

  project(packet: PacketEnvelope, scope: ProjectionScope, sessionEpoch: string, sequence: string): ProjectionResult {
    const spec = this.schema.packets[packet.name];
    if (!spec) return this.reject('unknown-packet-family', `packet ${packet.name} is not owned by the ${this.family} projector`, packet.name);
    const params = packet.params ?? {};
    const unknown = unknownVarLengthField(packet, spec);
    if (unknown) return this.reject('unknown-var-length-field', `unknown variable-length field ${unknown} makes ${packet.name} unsafe to parse`, packet.name, unknown);
    for (const field of spec.required) {
      if (!(field in params)) return this.reject('missing-required-field', `${packet.name} is missing required field ${field}`, packet.name, field);
    }
    const built = this.build(packet, params, spec);
    if ('rejection' in built) return { ok: false, rejection: built.rejection };
    return {
      ok: true,
      projection: {
        kind: this.family,
        packet: packet.name,
        source: this.schema.source,
        availability: built.availability,
        sessionEpoch,
        sequence,
        scope: { ...scope },
        provenance: { schemaId: this.schema.id, schemaHash: this.schemaHash, adapterVersion: this.schema.adapterVersion, source: this.schema.source, release: this.schema.release },
        payload: built.payload,
        evidence: { direction: packet.direction, phase: packet.phase },
      },
    };
  }

  protected abstract build(packet: PacketEnvelope, params: Record<string, unknown>, spec: PacketSpec): { payload: Record<string, unknown>; availability: 'observed' | 'degraded' } | { rejection: ProjectionRejection };

  protected reject(code: ProjectionRejectionCode, reason: string, packet: string, field?: string): ProjectionResult {
    return { ok: false, rejection: { code, reason, packet, ...(field === undefined ? {} : { field }) } };
  }

  protected malformed(packet: PacketEnvelope, field: string): ProjectionResult {
    return this.reject('malformed-field', `${packet.name} field ${field} is malformed`, packet.name, field);
  }

  protected number(params: Record<string, unknown>, field: string): number | undefined { const value = params[field]; return isFiniteNumber(value) ? value : undefined; }
  protected string(params: Record<string, unknown>, field: string): string | undefined { const value = params[field]; return isString(value) ? value : undefined; }
}