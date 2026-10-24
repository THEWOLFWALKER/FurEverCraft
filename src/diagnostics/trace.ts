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
  /** True when replay reduced this entry to stay within the record-byte bound. */
  truncated?: boolean;
};

export type TraceEffectState = {
  effectId: string;
  executionId: string;
  status: string;
  intent: unknown;
  evidence?: unknown;
  context?: unknown;
  observedAt: number;
  /** True when replay reduced this entry to stay within the record-byte bound. */
  truncated?: boolean;
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

/** Redaction/serialisation must never let a crafted value escape as an uncontrolled throw. */
function redactSafely(value: unknown): unknown {
  try { return redact(value); } catch { return '[UNAVAILABLE]'; }
}

function serializeSafely(value: unknown): { text: string; bytes: number; serializable: boolean } {
  try {
    const text = JSON.stringify(value) ?? 'null';
    return { text, bytes: Buffer.byteLength(text, 'utf8'), serializable: true };
  } catch {
    // Circular, BigInt or otherwise non-JSON values are bounded to a marker instead.
    const text = JSON.stringify({ truncated: true, serialization: 'unavailable' })!;
    return { text, bytes: Buffer.byteLength(text, 'utf8'), serializable: false };
  }
}

function safeJsonBytes(value: unknown): number { return serializeSafely(value).bytes; }

/** Replace values JSON cannot represent so a bounded display entry stays serialisable. */
function sanitizeJson<T>(value: T): T {
  try { JSON.stringify(value); return value; } catch { /* fall through to per-field repair */ }
  if (Array.isArray(value)) return value.map(item => sanitizeJson(item)) as T;
  if (value && typeof value === 'object') {
    const repaired: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      try { JSON.stringify(nested); repaired[key] = nested; }
      catch { repaired[key] = sanitizeJson(nested); }
    }
    return repaired as T;
  }
  return (typeof value === 'bigint' ? value.toString() : '[UNAVAILABLE]') as T;
}

/** Clone a value without allowing a non-cloneable crafted payload to abort replay. */
function cloneSafely<T>(value: T): T {
  try { return structuredClone(value); } catch { try { return JSON.parse(JSON.stringify(value)) as T; } catch { return { truncated: true } as T; } }
}

/**
 * Bound one payload to `maxBytes`. Any secret was already removed by `redact`
 * before serialisation, so even the preview cannot carry credentials.
 */
function boundPayload(value: unknown, maxBytes: number): { payload: unknown; truncated: boolean } {
  const redacted = redactSafely(value);
  const serialized = serializeSafely(redacted);
  if (!serialized.serializable) return { payload: { truncated: true, serialization: 'unavailable' }, truncated: true };
  if (serialized.bytes <= maxBytes) return { payload: redacted, truncated: false };
  // Reserve room for the wrapper fields; the preview is just a string slice.
  const keep = Math.max(0, maxBytes - 256);
  return {
    payload: { truncated: true, originalBytes: serialized.bytes, preview: serialized.text.slice(0, keep) },
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

export type ReplayTruncationReason = 'records' | 'record-bytes' | 'total-bytes' | 'input-intents' | 'effects' | 'gaps';
/**
 * Explicit evidence that replay applied the same boundary policy as capture.
 * `omitted` counts document entries that were not delivered/rendered.
 */
export type ReplayTruncation = {
  reasons: ReplayTruncationReason[];
  omitted: { records: number; inputIntents: number; effects: number; gaps: number };
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
  /** True when the document itself or the replay was bounded/truncated. */
  truncated: boolean;
  /** True when replay had to omit input because it exceeded DEFAULT_TRACE_POLICY. */
  replayTruncated: boolean;
  /** Present only when replay was bounded; explains what was omitted. */
  truncation?: ReplayTruncation;
  /** Policy limits replay enforces regardless of what a crafted document declares. */
  bounds: ReplayPolicyBounds;
  retentionGap?: ReplayRetentionGap;
  categories: { event: number; inputIntent: number; effectState: number };
  inputIntents: number;
  effects: { count: number; byStatus: Record<string, number>; records: Array<{ effectId: string; status: string }> };
  /** Full recorded effect state for rendering; never used to dispatch. */
  effectStates: TraceEffectState[];
  faults: ReplayFault[];
  boundaries: ReplayBoundaries;
};

export type ReplayPolicyBounds = {
  maxRecords: number;
  maxRecordBytes: number;
  maxBytes: number;
};

const REPLAY_BOUNDS: ReplayPolicyBounds = {
  maxRecords: DEFAULT_TRACE_POLICY.maxRecords,
  maxRecordBytes: DEFAULT_TRACE_POLICY.maxRecordBytes,
  maxBytes: DEFAULT_TRACE_POLICY.maxBytes,
};
/** One gap can be produced per record, so the record bound also bounds the gap list. */
const MAX_REPLAY_GAPS = DEFAULT_TRACE_POLICY.maxRecords;
/** Guards BigInt parsing and keeps identity fields from dominating a record. */
const MAX_SEQUENCE_DIGITS = 64;

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
 * Reduce one record to the per-record byte bound while preserving its identity
 * (seq/kind/category) so gap detection and fault classification still work.
 */
function boundReplayRecord(record: TraceRecord, maxBytes: number): { value: TraceRecord; reduced: boolean } {
  const base: TraceRecord = {
    seq: record.seq,
    eventId: typeof record.eventId === 'string' ? record.eventId : String(record.eventId ?? ''),
    kind: typeof record.kind === 'string' ? record.kind : String(record.kind ?? ''),
    payload: redactSafely(record.payload),
    durable: record.durable === true,
    ...(typeof record.observedAt === 'number' && Number.isFinite(record.observedAt) ? { observedAt: record.observedAt } : {}),
    ...(record.category === 'event' || record.category === 'input-intent' || record.category === 'effect-state' ? { category: record.category } : {}),
    ...(record.context === undefined ? {} : { context: redactSafely(record.context) }),
    ...(record.truncated === true ? { truncated: true } : {}),
  };
  const baseSerialized = serializeSafely(base);
  if (baseSerialized.serializable && baseSerialized.bytes <= maxBytes) return { value: base, reduced: false };
  const reduced: TraceRecord = {
    ...base,
    eventId: base.eventId.length > 256 ? `${base.eventId.slice(0, 256)}…` : base.eventId,
    kind: base.kind.length > 256 ? `${base.kind.slice(0, 256)}…` : base.kind,
    payload: boundPayload(base.payload, Math.max(256, Math.floor(maxBytes / 2))).payload,
    ...(base.context === undefined ? {} : { context: boundPayload(base.context, Math.max(256, Math.floor(maxBytes / 4))).payload }),
    truncated: true,
  };
  if (safeJsonBytes(reduced) <= maxBytes) return { value: reduced, reduced: true };
  // Identity fields themselves are oversized: keep a minimal renderable record.
  return {
    value: {
      seq: base.seq.slice(0, MAX_SEQUENCE_DIGITS),
      eventId: `truncated-${base.eventId.length}`,
      kind: base.kind.slice(0, 64),
      payload: { truncated: true, serialization: 'record-too-large' },
      durable: base.durable,
      ...(base.observedAt === undefined ? {} : { observedAt: base.observedAt }),
      ...(base.category === undefined ? {} : { category: base.category }),
      truncated: true,
    },
    reduced: true,
  };
}

/** Apply the per-entry byte bound to recorded input intents / effect states. */
function boundReplayAux<T>(entry: T, maxBytes: number): { value: T; reduced: boolean } {
  const redacted = sanitizeJson(redactSafely(entry)) as T;
  const serialized = serializeSafely(redacted);
  if (serialized.serializable && serialized.bytes <= maxBytes) return { value: redacted, reduced: false };
  const small = { ...(redacted as unknown as Record<string, unknown>) };
  for (const key of ['intent', 'evidence', 'context']) {
    if (key in small) small[key] = boundPayload(small[key], Math.max(256, Math.floor(maxBytes / 4))).payload;
  }
  for (const [key, current] of Object.entries(small)) {
    if (typeof current === 'string' && current.length > 256) small[key] = `${current.slice(0, 256)}…`;
  }
  small.truncated = true;
  if (safeJsonBytes(small) > maxBytes) { small.evidence = undefined; small.context = undefined; }
  return { value: small as T, reduced: true };
}

/**
 * Replay a trace for diagnostics only.
 *
 * This function has no input sink, transport, provider or store. Historical
 * effects are rendered from their recorded state and are never re-dispatched.
 * Gaps in the event cursor are reported explicitly in `gaps` rather than hidden
 * by renumbering the remaining records.
 *
 * Replay enforces the same DEFAULT_TRACE_POLICY bounds as capture: a crafted or
 * stale document cannot make it materialise unbounded records, oversized
 * payloads, effect states or gap entries. When a bound is hit the result is
 * returned with `replayTruncated`/`truncation` instead of growing without limit;
 * structurally invalid documents are rejected with a controlled error.
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
  if (cursor !== undefined && (!/^\d+$/.test(cursor) || cursor.length > MAX_SEQUENCE_DIGITS)) throw new Error('invalid-trace-cursor');
  const start = cursor === undefined ? undefined : BigInt(cursor);

  const truncation: ReplayTruncation = { reasons: [], omitted: { records: 0, inputIntents: 0, effects: 0, gaps: 0 } };
  const mark = (reason: ReplayTruncationReason) => { if (!truncation.reasons.includes(reason)) truncation.reasons.push(reason); };

  const gaps: ReplayGap[] = [];
  let previous: bigint | undefined = start;
  let expectedNext = start === undefined ? undefined : start + 1n;
  let firstSeq: string | undefined;
  let lastSeq: string | undefined;
  let eventCount = 0;
  let inputCategoryCount = 0;
  let effectCategoryCount = 0;
  let totalBytes = 0;
  const byStatus: Record<string, number> = {};
  const deliveredRecords: TraceRecord[] = [];
  const effectRecords: Array<{ effectId: string; status: string }> = [];

  const pushGap = (gap: ReplayGap) => {
    if (gaps.length < MAX_REPLAY_GAPS) { gaps.push(gap); return; }
    truncation.omitted.gaps += 1;
    mark('gaps');
  };

  for (let index = 0; index < document.records.length; index += 1) {
    const record: unknown = document.records[index];
    if (!record || typeof record !== 'object' || typeof (record as TraceRecord).seq !== 'string' || !/^\d+$/.test((record as TraceRecord).seq) || (record as TraceRecord).seq.length > MAX_SEQUENCE_DIGITS) throw new Error('invalid-trace-sequence');
    const typed = record as TraceRecord;
    const sequence = BigInt(typed.seq);
    if (start !== undefined && sequence <= start) continue;
    if (deliveredRecords.length >= REPLAY_BOUNDS.maxRecords) {
      mark('records');
      truncation.omitted.records = document.records.length - index;
      break;
    }
    const bounded = boundReplayRecord(typed, REPLAY_BOUNDS.maxRecordBytes);
    if (bounded.reduced) mark('record-bytes');
    const bytes = safeJsonBytes(bounded.value);
    if (deliveredRecords.length > 0 && totalBytes + bytes > REPLAY_BOUNDS.maxBytes) {
      mark('total-bytes');
      truncation.omitted.records = document.records.length - index;
      break;
    }
    totalBytes += bytes;
    firstSeq ??= bounded.value.seq;
    lastSeq = bounded.value.seq;
    eventCount += 1;
    if (bounded.value.category === 'input-intent') inputCategoryCount += 1;
    if (bounded.value.category === 'effect-state') effectCategoryCount += 1;
    if (previous !== undefined && sequence <= previous) {
      // A non-monotonic stream is reported as a gap (missing=0) instead of being reordered.
      pushGap({ after: previous.toString(), before: typed.seq, missing: 0 });
    } else if (expectedNext !== undefined && sequence !== expectedNext) {
      pushGap({ after: previous!.toString(), before: typed.seq, missing: Number(sequence - expectedNext) });
    }
    previous = sequence;
    expectedNext = sequence + 1n;
    deliveredRecords.push(cloneSafely(bounded.value));
    options.onRecord?.(cloneSafely(bounded.value));
  }

  const inputIntents = Array.isArray(document.inputIntents) ? document.inputIntents : [];
  const deliveredInputs: TraceInputIntent[] = [];
  for (let index = 0; index < inputIntents.length; index += 1) {
    const input = inputIntents[index];
    if (!input || typeof input !== 'object') continue;
    if (deliveredInputs.length >= REPLAY_BOUNDS.maxRecords) {
      mark('input-intents');
      truncation.omitted.inputIntents = inputIntents.length - index;
      break;
    }
    const bounded = boundReplayAux(input, REPLAY_BOUNDS.maxRecordBytes);
    if (bounded.reduced) mark('record-bytes');
    const bytes = safeJsonBytes(bounded.value);
    if (deliveredInputs.length > 0 && totalBytes + bytes > REPLAY_BOUNDS.maxBytes) {
      mark('total-bytes');
      truncation.omitted.inputIntents = inputIntents.length - index;
      break;
    }
    totalBytes += bytes;
    deliveredInputs.push(cloneSafely(bounded.value));
    options.onInputIntent?.(cloneSafely(bounded.value));
  }

  const effects = Array.isArray(document.effects) ? document.effects : [];
  const deliveredEffects: TraceEffectState[] = [];
  for (let index = 0; index < effects.length; index += 1) {
    const effect = effects[index];
    if (!effect || typeof effect !== 'object') continue;
    if (deliveredEffects.length >= REPLAY_BOUNDS.maxRecords) {
      mark('effects');
      truncation.omitted.effects = effects.length - index;
      break;
    }
    const bounded = boundReplayAux(effect, REPLAY_BOUNDS.maxRecordBytes);
    if (bounded.reduced) mark('record-bytes');
    const bytes = safeJsonBytes(bounded.value);
    if (deliveredEffects.length > 0 && totalBytes + bytes > REPLAY_BOUNDS.maxBytes) {
      mark('total-bytes');
      truncation.omitted.effects = effects.length - index;
      break;
    }
    totalBytes += bytes;
    const status = String(bounded.value.status);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    effectRecords.push({ effectId: String(bounded.value.effectId), status });
    deliveredEffects.push(cloneSafely(bounded.value));
    options.onEffectState?.(cloneSafely(bounded.value));
  }

  const dropped = Number.isInteger(document.dropped) && (document.dropped ?? 0) > 0 ? document.dropped! : 0;
  const retentionGap: ReplayRetentionGap | undefined = dropped > 0 ? { dropped, ...(firstSeq ? { firstSeq } : {}) } : undefined;
  const replayTruncated = truncation.reasons.length > 0;
  const result: ReplayResult = {
    records: eventCount,
    ...(firstSeq === undefined ? {} : { firstSeq, lastSeq }),
    contiguous: gaps.length === 0 && dropped === 0 && !replayTruncated,
    gap: gaps.length > 0,
    gaps,
    dropped,
    truncated: document.truncated === true || replayTruncated,
    replayTruncated,
    ...(replayTruncated ? { truncation } : {}),
    bounds: { ...REPLAY_BOUNDS },
    ...(retentionGap ? { retentionGap } : {}),
    categories: { event: eventCount - inputCategoryCount - effectCategoryCount, inputIntent: inputCategoryCount + deliveredInputs.length, effectState: effectCategoryCount + deliveredEffects.length },
    inputIntents: deliveredInputs.length,
    effects: { count: deliveredEffects.length, byStatus, records: effectRecords },
    effectStates: deliveredEffects.map(effect => cloneSafely(effect)),
    faults: detectFaults(deliveredRecords),
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
  /** Stable world/account/dimension scope; omitted means the whole store (store-level export). */
  scope?: unknown;
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
    const page = store.getCriticalEvents(cursor, Math.min(250, remaining), undefined, options.scope) as Event[];
    if (!page.length) break;
    for (const event of page) recorder.append(event);
    readCount += page.length;
    const last = page[page.length - 1]!.seq;
    if (last === cursor) break;
    cursor = last;
    if (page.length < Math.min(250, remaining)) break;
  }
  const maxEffects = Math.max(0, Math.floor(options.maxEffects ?? capacity));
  // The store applies LIMIT/scope in SQL. A whole-table read followed by slice() would
  // materialise every effect of every world before discarding all but `maxEffects`.
  const effects = maxEffects === 0
    ? []
    : store.listEffectsForScope(options.scope, { limit: maxEffects }).items;
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
