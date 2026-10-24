import { redact } from './redaction.js';
import type { Event, EventRead } from './events.js';
import type { SQLiteStore } from '../persistence/store.js';

/**
 * Diagnostic trace capture.
 *
 * The recorder is a bounded ring over three kinds of diagnostic evidence:
 *  - `records`: the EventHub event stream (numeric cursors; the only stream that
 *    may report cursor continuity/gaps),
 *  - `inputIntents`: recorded input/write intents (rendered, never executed),
 *  - `effects`: recorded effect states (rendered, never re-dispatched).
 *
 * Every payload that leaves the recorder is redacted. A trace is a diagnostic
 * document: replaying it only reads it back. It has no transport, body input,
 * provider or store handle, so a replay cannot re-send a historical side effect.
 */

export type TraceCategory = 'event' | 'input-intent' | 'effect-state';

export type TraceRecord = {
  seq: string;
  eventId: string;
  kind: string;
  payload: unknown;
  context?: unknown;
  durable: boolean;
  /** Capture time (injected clock). Used only for retention, not event ordering. */
  observedAt?: number;
  category?: TraceCategory;
  /** True when the payload was replaced by a bounded preview. */
  truncated?: boolean;
};

export type TraceInputIntent = {
  recordId: string;
  kind: string;
  intent: unknown;
  context?: unknown;
  observedAt: number;
  source?: string;
};

export type TraceEffectState = {
  effectId: string;
  executionId: string;
  status: string;
  intent: unknown;
  evidence?: unknown;
  context?: unknown;
  observedAt: number;
};

export type TracePolicy = {
  maxRecords: number;
  maxRecordBytes: number;
  maxBytes: number;
  retentionMs: number;
};

export type TraceDocument = {
  /**
   * Version 1 documents are the original {seq,eventId,kind,payload,durable}
   * shape. New fields are additive so old readers can still consume them.
   */
  version: 1 | 2;
  source: 'offline-fixture' | 'runtime';
  createdAt?: number;
  policy?: TracePolicy;
  records: TraceRecord[];
  inputIntents?: TraceInputIntent[];
  effects?: TraceEffectState[];
  /** Records evicted by capacity/retention/size bounds (explicit history gap). */
  dropped?: number;
  /** Cursor the capture started from; replay uses it to report a leading gap. */
  startCursor?: string;
  /** True when at least one payload was reduced to a bounded preview. */
  truncated?: boolean;
  extensions?: string[];
};

export const DEFAULT_TRACE_POLICY: TracePolicy = {
  maxRecords: 4096,
  maxRecordBytes: 16 * 1024,
  maxBytes: 4 * 1024 * 1024,
  retentionMs: 24 * 60 * 60 * 1000,
};

export type TraceRecorderOptions = {
  capacity?: number;
  /** Alias for capacity (the policy field name). */
  maxRecords?: number;
  maxRecordBytes?: number;
  maxBytes?: number;
  retentionMs?: number;
  now?: () => number;
  source?: TraceDocument['source'];
  startCursor?: string;
};

type Entry<T> = { value: T; bytes: number; at: number };

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
const clone = <T>(value: T): T => structuredClone(value);

/**
 * Bound one payload to `maxBytes`. Any secret was already removed by `redact`
 * before serialisation, so even the preview cannot carry credentials.
 */
function boundPayload(value: unknown, maxBytes: number): { payload: unknown; truncated: boolean } {
  const redacted = redact(value);
  const text = JSON.stringify(redacted) ?? 'null';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { payload: redacted, truncated: false };
  // Reserve room for the wrapper fields; the preview is just a string slice.
  const keep = Math.max(0, maxBytes - 256);
  return {
    payload: { truncated: true, originalBytes: Buffer.byteLength(text, 'utf8'), preview: text.slice(0, keep) },
    truncated: true,
  };
}

function categoryOf(kind: string): TraceCategory {
  if (kind.startsWith('effect.')) return 'effect-state';
  if (kind.startsWith('input.') || kind.startsWith('intent.') || kind.startsWith('motor.')) return 'input-intent';
  return 'event';
}

export class TraceRecorder {
  private readonly capacity: number;
  private readonly maxRecordBytes: number;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly source: TraceDocument['source'];
  private readonly startCursor?: string;
  private readonly recordEntries: Entry<TraceRecord>[] = [];
  private readonly inputEntries: Entry<TraceInputIntent>[] = [];
  private readonly effectEntries: Entry<TraceEffectState>[] = [];
  private dropped = 0;
  private truncated = false;
  private aux = 0;

  /** Accepts the historical numeric capacity as well as an options object. */
  constructor(capacityOrOptions: number | TraceRecorderOptions = {}) {
    const options: TraceRecorderOptions = typeof capacityOrOptions === 'number' ? { capacity: capacityOrOptions } : capacityOrOptions;
    this.capacity = Math.max(1, Math.floor(options.capacity ?? options.maxRecords ?? DEFAULT_TRACE_POLICY.maxRecords));
    this.maxRecordBytes = Math.max(256, Math.floor(options.maxRecordBytes ?? DEFAULT_TRACE_POLICY.maxRecordBytes));
    this.maxBytes = Math.max(this.maxRecordBytes, Math.floor(options.maxBytes ?? DEFAULT_TRACE_POLICY.maxBytes));
    this.retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_TRACE_POLICY.retentionMs));
    this.now = options.now ?? Date.now;
    this.source = options.source ?? 'offline-fixture';
    this.startCursor = options.startCursor;
  }

  append(event: Event): TraceRecord {
    const now = this.now();
    this.prune(now);
    const bounded = boundPayload(event.payload, this.maxRecordBytes);
    const record: TraceRecord = {
      seq: String(event.seq),
      eventId: event.eventId,
      kind: event.kind,
      payload: bounded.payload,
      context: redact(event.context),
      durable: Boolean(event.durable),
      observedAt: now,
      category: categoryOf(event.kind),
      ...(bounded.truncated ? { truncated: true } : {}),
    };
    this.truncated = this.truncated || bounded.truncated;
    this.push(this.recordEntries, record, now);
    return clone(record);
  }

  appendRead(read: EventRead): void {
    for (const event of read.events) this.append(event);
  }

  /** Record one write/input intent. This is evidence for replay, not an action. */
  appendInputIntent(input: { recordId?: string; kind: string; intent: unknown; context?: unknown; source?: string }): TraceInputIntent {
    const now = this.now();
    this.prune(now);
    const bounded = boundPayload(input.intent, this.maxRecordBytes);
    this.truncated = this.truncated || bounded.truncated;
    const entry: TraceInputIntent = {
      recordId: input.recordId ?? `trace-intent-${++this.aux}`,
      kind: input.kind,
      intent: bounded.payload,
      context: redact(input.context),
      observedAt: now,
      ...(input.source ? { source: input.source } : {}),
    };
    this.push(this.inputEntries, entry, now);
    return clone(entry);
  }

  /** Record the state of an effect. Replay displays this state; it never dispatches. */
  appendEffect(effect: { effectId: string; executionId: string; status: string; intent: unknown; evidence?: unknown; context?: unknown }): TraceEffectState {
    const now = this.now();
    this.prune(now);
    const bounded = boundPayload(effect.intent, this.maxRecordBytes);
    this.truncated = this.truncated || bounded.truncated;
    const entry: TraceEffectState = {
      effectId: effect.effectId,
      executionId: effect.executionId,
      status: effect.status,
      intent: bounded.payload,
      ...(effect.evidence === undefined ? {} : { evidence: redact(effect.evidence) }),
      ...(effect.context === undefined ? {} : { context: redact(effect.context) }),
      observedAt: now,
    };
    this.push(this.effectEntries, entry, now);
    return clone(entry);
  }

  /** Explicit aliases make call sites read truthfully. */
  recordInputIntent(input: Parameters<TraceRecorder['appendInputIntent']>[0]) { return this.appendInputIntent(input); }
  recordEffectState(effect: Parameters<TraceRecorder['appendEffect']>[0]) { return this.appendEffect(effect); }

  export(): TraceDocument {
    const now = this.now();
    this.prune(now);
    return {
      version: 1,
      source: this.source,
      createdAt: now,
      policy: this.policy(),
      records: this.recordEntries.map(entry => clone(entry.value)),
      inputIntents: this.inputEntries.map(entry => clone(entry.value)),
      effects: this.effectEntries.map(entry => clone(entry.value)),
      dropped: this.dropped,
      truncated: this.truncated,
      ...(this.startCursor ? { startCursor: this.startCursor } : {}),
      extensions: ['input-intents', 'effect-states', 'bounded-retention'],
    };
  }

  policy(): TracePolicy {
    return { maxRecords: this.capacity, maxRecordBytes: this.maxRecordBytes, maxBytes: this.maxBytes, retentionMs: this.retentionMs };
  }

  private prune(now: number): void {
    if (this.retentionMs > 0) {
      const cutoff = now - this.retentionMs;
      for (const list of [this.recordEntries, this.inputEntries, this.effectEntries]) {
        while (list.length && list[0]!.at < cutoff) { list.shift(); this.dropped += 1; }
      }
    }
  }

  private totalBytes(): number {
    let total = 0;
    for (const list of [this.recordEntries, this.inputEntries, this.effectEntries]) for (const entry of list) total += entry.bytes;
    return total;
  }

  private push<T>(list: Entry<T>[], value: T, at: number): void {
    const bytes = jsonBytes(value);
    list.push({ value, bytes, at });
    while (list.length > this.capacity) { list.shift(); this.dropped += 1; }
    // Evict the oldest entry across streams until both the count and byte bounds hold.
    while (this.totalBytes() > this.maxBytes) {
      const oldest = this.oldest();
      if (!oldest) break;
      oldest.shift();
      this.dropped += 1;
    }
  }

  private oldest(): Entry<unknown>[] | undefined {
    const candidates: Array<{ list: Entry<unknown>[]; at: number }> = [];
    if (this.recordEntries.length) candidates.push({ list: this.recordEntries, at: this.recordEntries[0]!.at });
    if (this.inputEntries.length) candidates.push({ list: this.inputEntries, at: this.inputEntries[0]!.at });
    if (this.effectEntries.length) candidates.push({ list: this.effectEntries, at: this.effectEntries[0]!.at });
    candidates.sort((left, right) => left.at - right.at);
    return candidates[0]?.list;
  }
}

export type ReplayGap = { after: string; before: string; missing: number };
export type ReplayRetentionGap = { dropped: number; firstSeq?: string };
export type ReplayFaultKind = 'recovery-exhausted' | 'recovery-failed' | 'runtime-stopped' | 'session-failed' | 'owner-lost' | 'bridge-control-revoked';
export type ReplayFault = { kind: ReplayFaultKind; seq?: string; reason: string; detail?: string };

/** Replay never offers a dispatch surface; this is reported, not merely asserted. */
export type ReplayBoundaries = {
  mode: 'diagnostic-only';
  input: 'disabled';
  network: 'disabled';
  paidApis: 'disabled';
  sideEffects: 'not-resent';
};

export type ReplayResult = {
  records: number;
  firstSeq?: string;
  lastSeq?: string;
  contiguous: boolean;
  /** Alias for `gaps.length > 0`, matching EventRead terminology. */
  gap: boolean;
  gaps: ReplayGap[];
  dropped: number;
  truncated: boolean;
  retentionGap?: ReplayRetentionGap;
  categories: { event: number; inputIntent: number; effectState: number };
  inputIntents: number;
  effects: { count: number; byStatus: Record<string, number>; records: Array<{ effectId: string; status: string }> };
  /** Full recorded effect state for rendering; never used to dispatch. */
  effectStates: TraceEffectState[];
  faults: ReplayFault[];
  boundaries: ReplayBoundaries;
};

export type ReplayOptions = {
  /** Start replaying after this event cursor; a missing range is reported as a gap. */
  cursor?: string;
  onRecord?: (record: TraceRecord) => void;
  onInputIntent?: (input: TraceInputIntent) => void;
  /** Receives the recorded state only. No effect is executed by this callback. */
  onEffectState?: (effect: TraceEffectState) => void;
};

const boundaries: ReplayBoundaries = { mode: 'diagnostic-only', input: 'disabled', network: 'disabled', paidApis: 'disabled', sideEffects: 'not-resent' };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function detectFaults(records: TraceRecord[]): ReplayFault[] {
  const faults: ReplayFault[] = [];
  for (const record of records) {
    const payload = asRecord(record.payload);
    if (record.kind === 'runtime.recovery_failed') {
      const attempts = Number(payload.attempts ?? 0);
      const budget = Number(payload.budget ?? 0);
      const exhausted = payload.suspended === true || (budget > 0 && attempts >= budget);
      faults.push({
        kind: exhausted ? 'recovery-exhausted' : 'recovery-failed',
        seq: record.seq,
        reason: exhausted ? 'recovery-budget-exhausted' : String(payload.error ?? 'recovery-failed'),
        ...(exhausted ? { detail: `attempts=${attempts} budget=${budget}` } : {}),
      });
    } else if (record.kind === 'runtime.stopping') {
      const reason = String(payload.reason ?? 'stop');
      faults.push({ kind: /owner|heartbeat|lost/i.test(reason) ? 'owner-lost' : 'runtime-stopped', seq: record.seq, reason });
    } else if (record.kind === 'session.stopped' || record.kind === 'session.failed') {
      const reason = String(payload.reason ?? record.kind);
      faults.push({ kind: /owner|heartbeat|lost/i.test(reason) ? 'owner-lost' : 'session-failed', seq: record.seq, reason });
    } else if (record.kind === 'runtime.fatal' || record.kind === 'bridge.fatal') {
      const reason = String(payload.reason ?? record.kind);
      faults.push({ kind: /owner|heartbeat|lost/i.test(reason) ? 'owner-lost' : 'runtime-stopped', seq: record.seq, reason });
    } else if (record.kind === 'bridge.control-revoked' || record.kind === 'bridge.owner-lost' || record.kind === 'control-revoked') {
      const reason = String(payload.reason ?? record.kind);
      faults.push({ kind: /owner|heartbeat|lost/i.test(reason) ? 'owner-lost' : 'bridge-control-revoked', seq: record.seq, reason });
    }
  }
  return faults;
}

/**
 * Replay a trace for diagnostics only.
 *
 * This function has no input sink, transport, provider or store. Historical
 * effects are rendered from their recorded state and are never re-dispatched.
 * Gaps in the event cursor are reported explicitly in `gaps` rather than hidden
 * by renumbering the remaining records.
 */
export function replayTrace(
  document: TraceDocument,
  onRecordOrOptions?: ((record: TraceRecord) => void) | ReplayOptions,
): ReplayResult {
  if (!document || (document.version !== 1 && document.version !== 2)) throw new Error('unsupported-trace');
  if (document.source !== 'offline-fixture' && document.source !== 'runtime') throw new Error('unsupported-trace-source');
  if (!Array.isArray(document.records)) throw new Error('invalid-trace-records');
  const options: ReplayOptions = typeof onRecordOrOptions === 'function' ? { onRecord: onRecordOrOptions } : onRecordOrOptions ?? {};
  const cursor = options.cursor ?? document.startCursor;
  if (cursor !== undefined && !/^\d+$/.test(cursor)) throw new Error('invalid-trace-cursor');
  const start = cursor === undefined ? undefined : BigInt(cursor);

  const gaps: ReplayGap[] = [];
  let previous: bigint | undefined = start;
  let expectedNext = start === undefined ? undefined : start + 1n;
  let firstSeq: string | undefined;
  let lastSeq: string | undefined;
  let eventCount = 0;
  let inputCategoryCount = 0;
  let effectCategoryCount = 0;
  const byStatus: Record<string, number> = {};
  const effectRecords: Array<{ effectId: string; status: string }> = [];

  for (const record of document.records) {
    if (!record || typeof record.seq !== 'string' || !/^\d+$/.test(record.seq)) throw new Error('invalid-trace-sequence');
    const sequence = BigInt(record.seq);
    if (start !== undefined && sequence <= start) continue;
    firstSeq ??= record.seq;
    lastSeq = record.seq;
    eventCount += 1;
    if (record.category === 'input-intent') inputCategoryCount += 1;
    if (record.category === 'effect-state') effectCategoryCount += 1;
    if (previous !== undefined && sequence <= previous) {
      // A non-monotonic stream is reported as a gap (missing=0) instead of being reordered.
      gaps.push({ after: previous.toString(), before: record.seq, missing: 0 });
    } else if (expectedNext !== undefined && sequence !== expectedNext) {
      gaps.push({ after: previous!.toString(), before: record.seq, missing: Number(sequence - expectedNext) });
    }
    previous = sequence;
    expectedNext = sequence + 1n;
    options.onRecord?.(clone(record));
  }

  const inputIntents = Array.isArray(document.inputIntents) ? document.inputIntents : [];
  for (const input of inputIntents) options.onInputIntent?.(clone(input));

  const effects = Array.isArray(document.effects) ? document.effects : [];
  for (const effect of effects) {
    byStatus[effect.status] = (byStatus[effect.status] ?? 0) + 1;
    effectRecords.push({ effectId: effect.effectId, status: effect.status });
    options.onEffectState?.(clone(effect));
  }

  const dropped = Number.isInteger(document.dropped) && (document.dropped ?? 0) > 0 ? document.dropped! : 0;
  const retentionGap: ReplayRetentionGap | undefined = dropped > 0 ? { dropped, ...(firstSeq ? { firstSeq } : {}) } : undefined;
  const result: ReplayResult = {
    records: eventCount,
    ...(firstSeq === undefined ? {} : { firstSeq, lastSeq }),
    contiguous: gaps.length === 0 && dropped === 0,
    gap: gaps.length > 0,
    gaps,
    dropped,
    truncated: document.truncated === true,
    ...(retentionGap ? { retentionGap } : {}),
    categories: { event: eventCount - inputCategoryCount - effectCategoryCount, inputIntent: inputCategoryCount + inputIntents.length, effectState: effectCategoryCount + effects.length },
    inputIntents: inputIntents.length,
    effects: { count: effects.length, byStatus, records: effectRecords },
    effectStates: effects.map(effect => clone(effect)),
    faults: detectFaults(document.records.filter(record => start === undefined || BigInt(record.seq) > start)),
    boundaries,
  };
  return result;
}

export type StoreTraceExportOptions = {
  cursor?: string;
  maxRecords?: number;
  maxRecordBytes?: number;
  maxBytes?: number;
  retentionMs?: number;
  now?: () => number;
  source?: TraceDocument['source'];
  /** Maximum effect rows copied into the trace (bounded independently of records). */
  maxEffects?: number;
};

/**
 * Export a replayable trace from the durable Runtime store without opening a
 * Runtime (and therefore without taking the ownership lock).
 */
export function exportTraceFromStore(store: SQLiteStore, options: StoreTraceExportOptions = {}): TraceDocument {
  const capacity = Math.max(1, Math.floor(options.maxRecords ?? DEFAULT_TRACE_POLICY.maxRecords));
  const recorder = new TraceRecorder({
    capacity,
    maxRecordBytes: options.maxRecordBytes,
    maxBytes: options.maxBytes,
    retentionMs: options.retentionMs,
    source: options.source ?? 'runtime',
    ...(options.cursor ? { startCursor: options.cursor } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let cursor = options.cursor ?? '0';
  let readCount = 0;
  for (;;) {
    const remaining = capacity - readCount;
    if (remaining <= 0) break;
    const page = store.getCriticalEvents(cursor, Math.min(250, remaining)) as Event[];
    if (!page.length) break;
    for (const event of page) recorder.append(event);
    readCount += page.length;
    const last = page[page.length - 1]!.seq;
    if (last === cursor) break;
    cursor = last;
    if (page.length < Math.min(250, remaining)) break;
  }
  const maxEffects = Math.max(0, Math.floor(options.maxEffects ?? capacity));
  const effects = store.listEffects().slice(0, maxEffects);
  for (const effect of effects) {
    const normalized = effect as unknown as {
      effectId?: string; effect_id?: string; executionId?: string; execution_id?: string;
      status: string; intent: unknown; evidence?: unknown; context?: unknown;
    };
    const effectId = normalized.effectId ?? normalized.effect_id ?? 'unknown';
    const executionId = normalized.executionId ?? normalized.execution_id ?? 'unknown';
    recorder.appendEffect({
      effectId, executionId, status: String(normalized.status), intent: normalized.intent,
      ...(normalized.evidence === undefined ? {} : { evidence: normalized.evidence }),
      ...(normalized.context === undefined ? {} : { context: normalized.context }),
    });
    // The durable effect intent is also the recorded write intent for this effect.
    const intent = asRecord(normalized.intent);
    recorder.appendInputIntent({
      recordId: `effect-intent:${effectId}`,
      kind: typeof intent.kind === 'string' ? intent.kind : 'write-intent',
      intent: normalized.intent,
      ...(normalized.context === undefined ? {} : { context: normalized.context }),
      source: `effect:${effectId}`,
    });
  }
  return recorder.export();
}
