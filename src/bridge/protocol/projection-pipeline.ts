import {
  createSyntheticProjectors,
  projectWith,
  type DomainFamily,
  type DomainProjection,
  type DomainProjector,
  type PacketEnvelope,
  type ProjectionRejection,
  type ProjectionScope,
} from './projectors/index.js';

/**
 * Ordered projection pipeline. It fences epochs/sequences, keeps sticky global
 * uncertainty after any lost control information, and refuses old epochs. A local
 * non-control domain may degrade without invalidating unrelated domains.
 */
export type PipelineReason = 'epoch-required' | 'stale-epoch' | 'stale-sequence' | 'sequence-gap' | 'sticky-unknown' | 'rejected-packet';
export type ProjectInput = {
  epoch: string;
  direction: 'downstream' | 'upstream';
  sequence: string;
  packet: PacketEnvelope;
  scope: ProjectionScope;
};
export type PipelineProjection =
  | { accepted: true; projection: DomainProjection; degradedDomains: string[] }
  | {
      accepted: false;
      reason: PipelineReason;
      detail: string;
      rejection?: ProjectionRejection;
      degradedDomains: string[];
      stickyUnknown?: string;
    };

export type PipelineOptions = {
  projectors?: readonly DomainProjector[];
  controlFamilies?: readonly DomainFamily[];
  controlPackets?: readonly string[];
  now?: () => number;
};

export class DomainProjectionPipeline {
  private readonly projectors: readonly DomainProjector[];
  private readonly controlFamilies: ReadonlySet<DomainFamily>;
  private readonly controlPackets: ReadonlySet<string>;
  private epochValue?: string;
  private readonly lastSequences: Record<'downstream' | 'upstream', bigint | undefined> = { downstream: undefined, upstream: undefined };
  private stickyUnknownValue?: string;
  private readonly degraded = new Set<string>();

  constructor(options: PipelineOptions = {}) {
    this.projectors = options.projectors ?? createSyntheticProjectors();
    this.controlFamilies = new Set(options.controlFamilies ?? ['lifecycle']);
    this.controlPackets = new Set(options.controlPackets ?? []);
  }

  get epoch(): string | undefined { return this.epochValue; }
  get stickyUnknown(): string | undefined { return this.stickyUnknownValue; }
  get degradedDomains(): string[] { return [...this.degraded].sort(); }

  /** Bind the first trusted epoch and optional starting sequences. */
  start(epoch: string, sequences: Partial<Record<'downstream' | 'upstream', string>> = {}): void {
    if (!epoch) throw new Error('epoch-required');
    this.epochValue = epoch;
    this.stickyUnknownValue = undefined;
    this.degraded.clear();
    this.lastSequences.downstream = sequences.downstream === undefined ? undefined : BigInt(sequences.downstream);
    this.lastSequences.upstream = sequences.upstream === undefined ? undefined : BigInt(sequences.upstream);
  }

  /** Explicit recovery after a verified resynchronisation anchor. */
  resync(epoch: string, sequence: string, direction: 'downstream' | 'upstream' = 'downstream'): void {
    if (!epoch) throw new Error('epoch-required');
    this.epochValue = epoch;
    this.lastSequences[direction] = BigInt(sequence);
    // Resync proves continuity for the new anchor; unrelated domains start clean.
    this.stickyUnknownValue = undefined;
    this.degraded.clear();
  }

  project(input: ProjectInput): PipelineProjection {
    if (!this.epochValue) return this.reject('epoch-required', 'observation pipeline has no bound epoch; call start() with the trusted session epoch');
    if (input.epoch !== this.epochValue) {
      return this.reject('stale-epoch', `observation epoch ${input.epoch} != active ${this.epochValue}`);
    }
    if (this.stickyUnknownValue) return this.reject('sticky-unknown', `global uncertainty: ${this.stickyUnknownValue}`);
    let sequence: bigint;
    try { sequence = BigInt(input.sequence); } catch { return this.reject('stale-sequence', `invalid sequence ${input.sequence}`); }
    const last = this.lastSequences[input.direction];
    if (last !== undefined) {
      if (sequence <= last) return this.reject('stale-sequence', `sequence ${sequence} is not newer than ${last}`);
      if (sequence !== last + 1n) {
        this.stickyUnknownValue = `sequence-gap:${input.direction}:${last}->${sequence}`;
        this.lastSequences[input.direction] = sequence;
        return this.reject('sequence-gap', `sequence gap on ${input.direction}: ${last} -> ${sequence}`);
      }
    }
    this.lastSequences[input.direction] = sequence;

    const { projector, result } = projectWith(this.projectors, input.packet, input.scope, input.epoch, input.sequence);
    if (result.ok) {
      return { accepted: true, projection: result.projection, degradedDomains: this.degradedDomains };
    }
    const control = this.isControl(input.packet.name, projector?.family);
    if (control) {
      this.stickyUnknownValue = `control-unknown:${input.packet.name}:${result.rejection.code}`;
      return { accepted: false, reason: 'rejected-packet', detail: result.rejection.reason, rejection: result.rejection, degradedDomains: this.degradedDomains, stickyUnknown: this.stickyUnknownValue };
    }
    const domain = projector?.family ?? input.packet.name;
    this.degraded.add(domain);
    return { accepted: false, reason: 'rejected-packet', detail: result.rejection.reason, rejection: result.rejection, degradedDomains: this.degradedDomains };
  }

  /** A bounded observation queue dropped an item. Control loss is global, domain loss is local. */
  noteObservationDrop(drop: { control: boolean; domain?: string; reason?: string }): void {
    if (drop.control) {
      this.stickyUnknownValue = `observation-control-loss:${drop.reason ?? 'queue-overflow'}`;
      return;
    }
    if (drop.domain) this.degraded.add(drop.domain);
  }

  state() {
    return {
      epoch: this.epochValue ?? null,
      status: this.stickyUnknownValue ? 'unknown' as const : this.degraded.size > 0 ? 'degraded' as const : 'healthy' as const,
      stickyUnknown: this.stickyUnknownValue ?? null,
      degradedDomains: this.degradedDomains,
      lastSequences: {
        downstream: this.lastSequences.downstream?.toString() ?? null,
        upstream: this.lastSequences.upstream?.toString() ?? null,
      },
    };
  }

  private isControl(packetName: string, family?: DomainFamily): boolean {
    if (this.controlPackets.has(packetName)) return true;
    if (!family) return true; // Unknown packet could be control; refuse to narrow the blast radius.
    return this.controlFamilies.has(family);
  }

  private reject(reason: PipelineReason, detail: string): PipelineProjection {
    return { accepted: false, reason, detail, degradedDomains: this.degradedDomains, ...(this.stickyUnknownValue === undefined ? {} : { stickyUnknown: this.stickyUnknownValue }) };
  }
}

export type ObservationQueueItem = { sequence: string; control: boolean; domain?: string; bytes?: number; payload?: unknown };
export type ObservationQueueDrop = { item: ObservationQueueItem; reason: 'count' | 'bytes' };

/** Bounded observation queue retaining the control/non-control classification of drops. */
export class BoundedObservationQueue {
  private readonly items: ObservationQueueItem[] = [];
  private bytes = 0;
  constructor(private readonly limits: { maxItems: number; maxBytes: number } = { maxItems: 256, maxBytes: 8 * 1024 * 1024 }) {}

  push(item: ObservationQueueItem): { accepted: boolean; dropped: ObservationQueueDrop[] } {
    const size = item.bytes ?? 0;
    const dropped: ObservationQueueDrop[] = [];
    while (this.items.length > 0 && (this.items.length >= this.limits.maxItems || this.bytes + size > this.limits.maxBytes)) {
      const reason: 'count' | 'bytes' = this.items.length >= this.limits.maxItems ? 'count' : 'bytes';
      const removed = this.items.shift()!;
      this.bytes = Math.max(0, this.bytes - (removed.bytes ?? 0));
      dropped.push({ item: removed, reason });
    }
    if (size > this.limits.maxBytes) return { accepted: false, dropped: [...dropped, { item, reason: 'bytes' }] };
    this.items.push(item);
    this.bytes += size;
    return { accepted: true, dropped };
  }

  drain(): ObservationQueueItem[] { const result = this.items.splice(0); this.bytes = 0; return result; }
  size(): { items: number; bytes: number } { return { items: this.items.length, bytes: this.bytes }; }
}
