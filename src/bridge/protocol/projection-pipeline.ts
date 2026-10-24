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
type PipelineDirection = 'downstream' | 'upstream';
type GlobalUncertainty = {
  reason: string;
  /** Directions whose anchoring is required before this global cause can be cleared. */
  directions: Set<PipelineDirection>;
  anchored: Set<PipelineDirection>;
};
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
  private readonly lastSequences: Record<PipelineDirection, bigint | undefined> = { downstream: undefined, upstream: undefined };
  private globalUncertainty?: GlobalUncertainty;
  private readonly directionUncertainty: Record<PipelineDirection, string | undefined> = { downstream: undefined, upstream: undefined };
  private readonly degraded = new Set<string>();

  constructor(options: PipelineOptions = {}) {
    this.projectors = options.projectors ?? createSyntheticProjectors();
    this.controlFamilies = new Set(options.controlFamilies ?? ['lifecycle']);
    this.controlPackets = new Set(options.controlPackets ?? []);
  }

  get epoch(): string | undefined { return this.epochValue; }
  /** Effective uncertainty: the global cause first, otherwise a direction-local cause. */
  get stickyUnknown(): string | undefined {
    return this.globalUncertainty?.reason ?? this.directionUncertainty.downstream ?? this.directionUncertainty.upstream;
  }
  /** Backwards-compatible alias: a global cause is not cleared by a one-direction resync. */
  get globalCause(): string | undefined { return this.globalUncertainty?.reason; }
  get degradedDomains(): string[] { return [...this.degraded].sort(); }

  /** Bind the first trusted epoch and optional starting sequences. This is an explicit new session. */
  start(epoch: string, sequences: Partial<Record<PipelineDirection, string>> = {}): void {
    if (!epoch) throw new Error('epoch-required');
    this.epochValue = epoch;
    this.globalUncertainty = undefined;
    this.directionUncertainty.downstream = undefined;
    this.directionUncertainty.upstream = undefined;
    this.degraded.clear();
    this.lastSequences.downstream = sequences.downstream === undefined ? undefined : BigInt(sequences.downstream);
    this.lastSequences.upstream = sequences.upstream === undefined ? undefined : BigInt(sequences.upstream);
  }

  /**
   * Explicit recovery after a verified resynchronisation anchor for one direction.
   * Only that direction's gap is cleared; a global cause (control loss or an upstream
   * gap) remains until every affected direction has been anchored. A changed epoch is
   * rejected: a new session must go through start().
   */
  resync(epoch: string, sequence: string, direction: PipelineDirection = 'downstream'): void {
    this.assertResyncEpoch(epoch);
    this.lastSequences[direction] = BigInt(sequence);
    this.directionUncertainty[direction] = undefined;
    const global = this.globalUncertainty;
    if (global) {
      if (global.directions.has(direction)) global.anchored.add(direction);
      if ([...global.directions].every(candidate => global.anchored.has(candidate))) this.globalUncertainty = undefined;
    }
  }

  /** Explicit full resynchronisation: clears global/direction uncertainty and domain degradation. */
  resyncAll(epoch: string, sequences: Partial<Record<PipelineDirection, string>> = {}): void {
    this.assertResyncEpoch(epoch);
    if (sequences.downstream !== undefined) this.lastSequences.downstream = BigInt(sequences.downstream);
    if (sequences.upstream !== undefined) this.lastSequences.upstream = BigInt(sequences.upstream);
    this.globalUncertainty = undefined;
    this.directionUncertainty.downstream = undefined;
    this.directionUncertainty.upstream = undefined;
    this.degraded.clear();
  }

  private assertResyncEpoch(epoch: string): void {
    if (!epoch) throw new Error('epoch-required');
    if (!this.epochValue) throw new Error('epoch-required');
    if (epoch !== this.epochValue) throw new Error(`stale-epoch: resync epoch ${epoch} != active ${this.epochValue}`);
  }

  project(input: ProjectInput): PipelineProjection {
    if (!this.epochValue) return this.reject('epoch-required', 'observation pipeline has no bound epoch; call start() with the trusted session epoch');
    if (input.epoch !== this.epochValue) {
      return this.reject('stale-epoch', `observation epoch ${input.epoch} != active ${this.epochValue}`);
    }
    if (this.globalUncertainty) return this.reject('sticky-unknown', `global uncertainty: ${this.globalUncertainty.reason}`);
    const directionCause = this.directionUncertainty[input.direction];
    if (directionCause) return this.reject('sticky-unknown', `${input.direction} uncertainty: ${directionCause}`);
    let sequence: bigint;
    try { sequence = BigInt(input.sequence); } catch { return this.reject('stale-sequence', `invalid sequence ${input.sequence}`); }
    const last = this.lastSequences[input.direction];
    if (last !== undefined) {
      if (sequence <= last) return this.reject('stale-sequence', `sequence ${sequence} is not newer than ${last}`);
      if (sequence !== last + 1n) {
        const cause = `sequence-gap:${input.direction}:${last}->${sequence}`;
        this.lastSequences[input.direction] = sequence;
        this.directionUncertainty[input.direction] = cause;
        // Losing upstream information is control-relevant: it taints both directions until
        // upstream itself is re-anchored. A downstream gap only fences downstream.
        if (input.direction === 'upstream') this.raiseGlobalUncertainty(cause, ['upstream']);
        return { accepted: false, reason: 'sequence-gap', detail: `sequence gap on ${input.direction}: ${last} -> ${sequence}`, degradedDomains: this.degradedDomains, ...(this.stickyUnknown === undefined ? {} : { stickyUnknown: this.stickyUnknown }) };
      }
    }
    this.lastSequences[input.direction] = sequence;

    const { projector, result } = projectWith(this.projectors, input.packet, input.scope, input.epoch, input.sequence);
    if (result.ok) {
      return { accepted: true, projection: result.projection, degradedDomains: this.degradedDomains };
    }
    const control = this.isControl(input.packet.name, projector?.family);
    if (control) {
      this.raiseGlobalUncertainty(`control-unknown:${input.packet.name}:${result.rejection.code}`, ['downstream', 'upstream']);
      return { accepted: false, reason: 'rejected-packet', detail: result.rejection.reason, rejection: result.rejection, degradedDomains: this.degradedDomains, stickyUnknown: this.stickyUnknown };
    }
    const domain = projector?.family ?? input.packet.name;
    this.degraded.add(domain);
    return { accepted: false, reason: 'rejected-packet', detail: result.rejection.reason, rejection: result.rejection, degradedDomains: this.degradedDomains };
  }

  /** A bounded observation queue dropped an item. Control loss is global, domain loss is local. */
  noteObservationDrop(drop: { control: boolean; domain?: string; reason?: string }): void {
    if (drop.control) {
      this.raiseGlobalUncertainty(`observation-control-loss:${drop.reason ?? 'queue-overflow'}`, ['downstream', 'upstream']);
      return;
    }
    if (drop.domain) this.degraded.add(drop.domain);
  }

  state() {
    return {
      epoch: this.epochValue ?? null,
      status: this.stickyUnknown !== undefined ? 'unknown' as const : this.degraded.size > 0 ? 'degraded' as const : 'healthy' as const,
      stickyUnknown: this.stickyUnknown ?? null,
      globalCause: this.globalUncertainty?.reason ?? null,
      directionCauses: {
        downstream: this.directionUncertainty.downstream ?? null,
        upstream: this.directionUncertainty.upstream ?? null,
      },
      degradedDomains: this.degradedDomains,
      lastSequences: {
        downstream: this.lastSequences.downstream?.toString() ?? null,
        upstream: this.lastSequences.upstream?.toString() ?? null,
      },
    };
  }

  private raiseGlobalUncertainty(reason: string, directions: readonly PipelineDirection[]): void {
    if (!this.globalUncertainty) {
      this.globalUncertainty = { reason, directions: new Set(directions), anchored: new Set() };
      return;
    }
    if (!this.globalUncertainty.reason.includes(reason)) this.globalUncertainty.reason = `${this.globalUncertainty.reason};${reason}`;
    for (const direction of directions) {
      this.globalUncertainty.directions.add(direction);
      // A newly affected direction has not been anchored against this cause yet.
      this.globalUncertainty.anchored.delete(direction);
    }
  }

  private isControl(packetName: string, family?: DomainFamily): boolean {
    if (this.controlPackets.has(packetName)) return true;
    if (!family) return true; // Unknown packet could be control; refuse to narrow the blast radius.
    return this.controlFamilies.has(family);
  }

  private reject(reason: PipelineReason, detail: string): PipelineProjection {
    return { accepted: false, reason, detail, degradedDomains: this.degradedDomains, ...(this.stickyUnknown === undefined ? {} : { stickyUnknown: this.stickyUnknown }) };
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
