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
export type PipelineReason = 'epoch-required' | 'stale-epoch' | 'scope-mismatch' | 'stale-sequence' | 'sequence-gap' | 'sticky-unknown' | 'rejected-packet' | PipelineAnchorReason;
export type PipelineAnchorReason = 'invalid-resync-sequence' | 'stale-resync-sequence';
type PipelineDirection = 'downstream' | 'upstream';
const DIRECTIONS: readonly PipelineDirection[] = ['downstream', 'upstream'];
const DECIMAL_SEQUENCE = /^\d+$/;
/** A sequence is a non-negative decimal string; anything else is a typed rejection, not a SyntaxError. */
const parseSequence = (value: unknown): bigint | undefined => {
  if (typeof value !== 'string' || !DECIMAL_SEQUENCE.test(value)) return undefined;
  return BigInt(value);
};
const normalizeAccount = (accountId: string | undefined): string | undefined => (accountId === undefined || accountId.length === 0 ? undefined : accountId);
const SCOPE_KEYS = ['serverProfileId', 'dimension', 'worldGenerationId', 'accountId'] as const;
const readScopeField = (scope: ProjectionScope, key: typeof SCOPE_KEYS[number]): string | undefined =>
  key === 'accountId' ? normalizeAccount(scope.accountId) : scope[key];
export type PipelineResyncResult =
  | { accepted: true }
  | { accepted: false; reason: PipelineAnchorReason; detail: string; degradedDomains: string[] };
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
  /** The account/world/dimension/server identity this session is fenced to. */
  private scopeValue?: ProjectionScope;
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
  /** The bound projection scope, or undefined until start() supplies it or the first packet binds it. */
  get scope(): ProjectionScope | undefined { return this.scopeValue === undefined ? undefined : { ...this.scopeValue }; }
  /** Effective uncertainty: the global cause first, otherwise a direction-local cause. */
  get stickyUnknown(): string | undefined {
    return this.globalUncertainty?.reason ?? this.directionUncertainty.downstream ?? this.directionUncertainty.upstream;
  }
  /** Backwards-compatible alias: a global cause is not cleared by a one-direction resync. */
  get globalCause(): string | undefined { return this.globalUncertainty?.reason; }
  get degradedDomains(): string[] { return [...this.degraded].sort(); }

  /**
   * Bind the first trusted epoch, optional starting sequences and the expected projection
   * scope. This is an explicit new session; it is the only way to change a bound scope.
   */
  start(epoch: string, sequences: Partial<Record<PipelineDirection, string>> = {}, scope?: ProjectionScope): void {
    if (!epoch) throw new Error('epoch-required');
    const downstream = sequences.downstream === undefined ? undefined : parseSequence(sequences.downstream);
    const upstream = sequences.upstream === undefined ? undefined : parseSequence(sequences.upstream);
    if (sequences.downstream !== undefined && downstream === undefined) throw new Error(`invalid-sequence:${sequences.downstream}`);
    if (sequences.upstream !== undefined && upstream === undefined) throw new Error(`invalid-sequence:${sequences.upstream}`);
    this.epochValue = epoch;
    this.scopeValue = scope === undefined ? undefined : { ...scope };
    this.globalUncertainty = undefined;
    this.directionUncertainty.downstream = undefined;
    this.directionUncertainty.upstream = undefined;
    this.degraded.clear();
    this.lastSequences.downstream = downstream;
    this.lastSequences.upstream = upstream;
  }

  /**
   * Explicit recovery after a verified resynchronisation anchor for one direction.
   * Only that direction's gap is cleared; a global cause (control loss or an upstream
   * gap) remains until every affected direction has been anchored. A changed epoch is
   * rejected: a new session must go through start().
   *
   * The anchor must be a non-negative decimal string that advances past the current
   * fence. Re-deriving an already-accepted sequence is a replay, not a recovery; only
   * re-anchoring at the exact sequence that opened the direction's gap is permitted.
   * Invalid/non-advancing anchors return a typed rejection without moving any fence.
   */
  resync(epoch: string, sequence: string, direction: PipelineDirection = 'downstream'): PipelineResyncResult {
    this.assertResyncEpoch(epoch);
    const anchor = parseSequence(sequence);
    if (anchor === undefined) return this.rejectAnchor('invalid-resync-sequence', `invalid ${direction} resync sequence ${JSON.stringify(sequence)}: a non-negative decimal string is required`);
    const rejection = this.checkAnchor(direction, anchor);
    if (rejection) return rejection;
    this.lastSequences[direction] = anchor;
    this.directionUncertainty[direction] = undefined;
    const global = this.globalUncertainty;
    if (global) {
      if (global.directions.has(direction)) global.anchored.add(direction);
      if ([...global.directions].every(candidate => global.anchored.has(candidate))) this.globalUncertainty = undefined;
    }
    return { accepted: true };
  }

  /** Explicit full resynchronisation: clears global/direction uncertainty and domain degradation. */
  resyncAll(epoch: string, sequences: Partial<Record<PipelineDirection, string>> = {}): PipelineResyncResult {
    this.assertResyncEpoch(epoch);
    const anchors: Partial<Record<PipelineDirection, bigint>> = {};
    for (const direction of DIRECTIONS) {
      const raw = sequences[direction];
      if (raw === undefined) continue;
      const anchor = parseSequence(raw);
      if (anchor === undefined) return this.rejectAnchor('invalid-resync-sequence', `invalid ${direction} resync sequence ${JSON.stringify(raw)}: a non-negative decimal string is required`);
      const rejection = this.checkAnchor(direction, anchor);
      if (rejection) return rejection;
      anchors[direction] = anchor;
    }
    if (anchors.downstream !== undefined) this.lastSequences.downstream = anchors.downstream;
    if (anchors.upstream !== undefined) this.lastSequences.upstream = anchors.upstream;
    this.globalUncertainty = undefined;
    this.directionUncertainty.downstream = undefined;
    this.directionUncertainty.upstream = undefined;
    this.degraded.clear();
    return { accepted: true };
  }

  /**
   * An anchor is strictly newer than the last accepted/fenced sequence. The one exception
   * is re-anchoring at the exact sequence that opened an active gap: that sequence was
   * fenced, never accepted, and is the observed recovery boundary.
   */
  private checkAnchor(direction: PipelineDirection, anchor: bigint): PipelineResyncResult | undefined {
    const last = this.lastSequences[direction];
    if (last === undefined || anchor > last) return undefined;
    if (anchor === last && this.directionUncertainty[direction] !== undefined) return undefined;
    return this.rejectAnchor('stale-resync-sequence', `${direction} resync sequence ${anchor} is not newer than ${last}`);
  }

  private rejectAnchor(reason: PipelineAnchorReason, detail: string): PipelineResyncResult {
    return { accepted: false, reason, detail, degradedDomains: this.degradedDomains };
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
    const scopeMismatch = this.scopeMismatch(input.scope);
    if (scopeMismatch) return this.reject('scope-mismatch', scopeMismatch);
    if (this.globalUncertainty) return this.reject('sticky-unknown', `global uncertainty: ${this.globalUncertainty.reason}`);
    const directionCause = this.directionUncertainty[input.direction];
    if (directionCause) return this.reject('sticky-unknown', `${input.direction} uncertainty: ${directionCause}`);
    const sequence = parseSequence(input.sequence);
    if (sequence === undefined) return this.reject('stale-sequence', `invalid sequence ${JSON.stringify(input.sequence)}`);
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
      scope: this.scopeValue === undefined ? null : { ...this.scopeValue },
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

  /** Bind the scope on first use; thereafter only start() may change an explicit new session's scope. */
  private scopeMismatch(scope: ProjectionScope): string | undefined {
    if (!scope || typeof scope !== 'object') return 'projection scope is required';
    if (this.scopeValue === undefined) {
      this.scopeValue = { ...scope };
      return undefined;
    }
    const differences: string[] = [];
    for (const key of SCOPE_KEYS) {
      const observed = readScopeField(scope, key);
      const bound = readScopeField(this.scopeValue, key);
      if (observed !== bound) differences.push(`${key} ${JSON.stringify(observed)} != bound ${JSON.stringify(bound)}`);
    }
    return differences.length === 0 ? undefined : `projection scope mismatch: ${differences.join('; ')}`;
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
