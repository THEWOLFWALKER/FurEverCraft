import { readFileSync } from 'node:fs';
import type { SQLiteStore } from '../persistence/store.js';
import {
  canonicalScopeKey, resolveStableScope,
  type StableScope,
} from '../contracts/context.js';

export type MemoryScope = { serverProfileId: string; accountId?: string; worldGenerationId?: string; dimensionId?: string };
export type KnowledgeRule = { id: string; version: number; scope: MemoryScope; predicate: string; conclusion: unknown; provenance: string; observed: boolean; validFrom: string; revalidateAfter?: string };
export type MemoryPage<T> = { items: T[]; nextCursor?: string; truncated: boolean };
export type PlaceFreshness = 'current' | 'stale' | 'unknown' | 'invalid';
/** A model-authored place is `unverified`; only observation evidence may promote it. */
export type PlaceVerificationStatus = 'unverified' | 'verified' | 'legacy-unreviewed';
/** Persisted freshness may only use UTC. Legacy rows have no trustworthy clock domain. */
export type PlaceTimeBasis = 'utc' | 'unknown';
export type PlaceView = {
  placeId: string;
  scope: MemoryScope;
  context: MemoryScope;
  status: string;
  revision: number;
  lastVerifiedAt?: string;
  verificationStatus: PlaceVerificationStatus;
  timeBasis: PlaceTimeBasis;
  invalidatedReason?: string;
  provenance?: unknown;
  payload: unknown;
  freshness: PlaceFreshness;
  fresh: boolean;
  freshnessReason?: string;
};
export type ExecutionExperienceInput = {
  episodeId: string;
  scope: MemoryScope;
  skillId: string;
  goalId?: string;
  executionId?: string;
  outcome: 'confirmed' | 'partial' | 'ambiguous' | 'failed' | 'canceled';
  failureClass: string;
  premises: Array<{ name: string; value: unknown; source?: string; observedAt?: number }>;
  evidence: Array<{ kind: string; ref?: string; observedAt?: number; detail?: unknown }>;
  provenance?: unknown;
};
export type ExecutionExperienceView = {
  episodeId: string;
  scope: MemoryScope;
  kind: 'execution-experience';
  skillId: string;
  goalId?: string;
  executionId?: string;
  outcome: string;
  failureClass: string;
  premises: unknown;
  evidence: unknown;
  provenance?: unknown;
  /** Episodic history is evidence for reasoning; it is never an authorization to act. */
  authorizesAction: false;
  authorizesWorldRule: false;
};

/** Sources that are observations, not model proposals or predictions. */
const TRUSTED_OBSERVATION_SOURCES = new Set(['client-reported', 'server-observed', 'simulated']);
export type PlaceObservation = {
  /** Stable scope captured with the observation. When present it must equal the requested scope. */
  scope?: unknown;
  source: 'client-reported' | 'server-observed' | 'predicted' | 'historical' | 'model' | 'synthetic' | 'simulated';
  pose?: unknown;
  position?: unknown;
  x?: number;
  y?: number;
  z?: number;
  evidenceRef?: string | { id?: string };
  evidence?: string | { id?: string };
  fieldRevision?: string;
  /** Optional observation time. A trustworthy UTC timestamp is required when supplied. */
  observedAtUtc?: string;
  receivedUtc?: string;
};

/** Load versioned knowledge rules from a JSON file. Missing or malformed files fail closed. */
export function loadKnowledgeRules(path: string): KnowledgeRule[] {
  if (!path) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('invalid-knowledge-file');
  return raw.map((item, index) => {
    const rule = item as Partial<KnowledgeRule>;
    if (!rule || typeof rule.id !== 'string' || typeof rule.predicate !== 'string' || typeof rule.version !== 'number' || !rule.scope) throw new Error(`invalid-knowledge-rule:${index}`);
    return { ...rule, provenance: rule.provenance ?? path, observed: rule.observed ?? true, validFrom: rule.validFrom ?? new Date(0).toISOString() } as KnowledgeRule;
  });
}

export function normalizeMemoryScope(value: unknown): MemoryScope {
  if (!value || typeof value !== 'object') throw new Error('invalid-memory-scope');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.serverProfileId !== 'string' || !candidate.serverProfileId) throw new Error('invalid-memory-scope:serverProfileId');
  const scope: MemoryScope = { serverProfileId: candidate.serverProfileId };
  for (const key of ['accountId', 'worldGenerationId', 'dimensionId'] as const) if (typeof candidate[key] === 'string' && candidate[key]) scope[key] = candidate[key] as string;
  // `dimension` is the bridge's wire name; MemoryScope stores the domain name in `dimensionId`.
  if (!scope.dimensionId && typeof candidate.dimension === 'string' && candidate.dimension) scope.dimensionId = candidate.dimension;
  return scope;
}

/** Full stable identity for a memory scope, or undefined when any field is missing. */
export function memoryScopeToStableScope(value: unknown): StableScope | undefined {
  try {
    const scope = normalizeMemoryScope(value);
    const resolved = resolveStableScope({
      serverProfileId: scope.serverProfileId,
      ...(scope.accountId ? { accountId: scope.accountId } : {}),
      ...(scope.worldGenerationId ? { worldGenerationId: scope.worldGenerationId } : {}),
      ...(scope.dimensionId ? { dimension: scope.dimensionId } : {}),
    } as Record<string, unknown>);
    return resolved.status === 'resolved' ? resolved.scope : undefined;
  } catch {
    return undefined;
  }
}

/** Canonical key for a *resolved* scope; unresolved input has no key. */
export function memoryScopeKey(value: unknown): string | undefined {
  const stable = memoryScopeToStableScope(value);
  return stable ? canonicalScopeKey(stable) : undefined;
}

/** Sorted-JSON compatibility key used by legacy partial scopes. */
export function scopeKey(scope: MemoryScope): string {
  const stable = memoryScopeToStableScope(scope);
  if (stable) return canonicalScopeKey(stable);
  return JSON.stringify(Object.fromEntries(Object.entries(scope).sort(([a], [b]) => a.localeCompare(b))));
}
const sameScope = (left: MemoryScope, right: MemoryScope) => scopeKey(left) === scopeKey(right);
const cursorOf = (value: string | undefined) => {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) throw new Error('invalid-memory-cursor');
  const cursor = Number(value);
  if (cursor > 10_000) throw new Error('memory-cursor-limit');
  return cursor;
};
const pageLimit = (value: number | undefined) => Math.min(Math.max(Math.trunc(value ?? 20), 1), 20);

/**
 * Scope resolution computed from a live callback. Never cache the returned value across calls:
 * a world/account/dimension change must invalidate the previous resolution (FEC-49).
 */
export type MemoryScopeResolution =
  | { status: 'resolved'; scope: MemoryScope; scopeKey: string }
  | { status: 'unresolved'; missing: string[] };

export function resolveMemoryScope(value: unknown): MemoryScopeResolution {
  let candidate = value;
  // Accept a ContextProvider-shaped record or a `{ context }` envelope without trusting it.
  if (candidate && typeof candidate === 'object') {
    const record = candidate as Record<string, unknown>;
    if (record.status === 'resolved' && record.scope && typeof record.scope === 'object') candidate = record.scope;
    else if (record.status === 'unresolved') return { status: 'unresolved', missing: Array.isArray(record.missing) ? record.missing.map(String) : ['context'] };
    else if (record.context && typeof record.context === 'object') candidate = record.context;
  }
  const stable = memoryScopeToStableScope(candidate);
  if (!stable) {
    let partial: MemoryScope | undefined;
    try { partial = normalizeMemoryScope(candidate); } catch { /* unresolved below */ }
    const missing: string[] = [];
    if (!partial) missing.push('serverProfileId');
    else {
      if (!partial.accountId) missing.push('accountId');
      if (!partial.worldGenerationId) missing.push('worldGenerationId');
      if (!partial.dimensionId) missing.push('dimensionId');
    }
    return { status: 'unresolved', missing: missing.length ? missing : ['context'] };
  }
  return {
    status: 'resolved',
    scope: {
      serverProfileId: stable.serverProfileId,
      accountId: stable.accountId,
      worldGenerationId: stable.worldGenerationId,
      dimensionId: stable.dimensionId,
    },
    scopeKey: canonicalScopeKey(stable),
  };
}

export function createScopeResolver(source: () => unknown): () => MemoryScopeResolution {
  return () => resolveMemoryScope(source());
}

export type MemoryServiceOptions = {
  /** Monotonic process time. Never persisted and never used as UTC freshness. */
  nowMono?: () => number;
  /** TimeServices-like convenience: `clock.now()` is monotonic. */
  clock?: { now(): number };
  /** Legacy option name: treated as *monotonic*, never as Unix milliseconds. */
  now?: () => number;
  /** Wall-clock ISO source used for every persisted timestamp and freshness comparison. */
  utcNow?: () => string;
  clockDomainId?: string;
  freshnessMaxAgeMs?: number;
  /** A UTC timestamp slightly ahead of local wall clock is unknown, not fresh. */
  futureToleranceMs?: number;
};

export class MemoryService {
  private readonly nowMono: () => number;
  private readonly utcNow: () => string;
  private readonly clockDomainId: string;
  private readonly freshnessMaxAgeMs: number;
  private readonly futureToleranceMs: number;
  constructor(private readonly store: SQLiteStore, private readonly rules: KnowledgeRule[] = [], options: MemoryServiceOptions = {}) {
    // A legacy caller may still pass `now`, but it is monotonic. It is deliberately not used
    // for persisted timestamps or freshness; only utcNow may answer "is this UTC fresh?".
    this.nowMono = options.nowMono ?? options.clock?.now ?? options.now ?? (() => performance.now());
    this.utcNow = options.utcNow ?? (() => new Date().toISOString());
    this.clockDomainId = options.clockDomainId ?? 'default-utc';
    this.freshnessMaxAgeMs = Math.max(0, options.freshnessMaxAgeMs ?? 5 * 60_000);
    this.futureToleranceMs = Math.max(0, options.futureToleranceMs ?? 60_000);
  }

  /** Monotonic time is exposed only for in-process diagnostics, never for persisted freshness. */
  monotonicNow(): number { return this.nowMono(); }
  clockDomain(): string { return this.clockDomainId; }

  private utcNowIso(): string {
    const value = this.utcNow();
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('memory-invalid-utc');
    return value;
  }
  private safeUtcNow(): string | undefined {
    try { return this.utcNowIso(); } catch { return undefined; }
  }

  /** Legacy, explicitly scoped rule query. New knowledge uses KnowledgeService releases. */
  queryKnowledge(query: { scope?: MemoryScope; predicate?: string; version?: number; limit?: number; cursor?: string } = {}): MemoryPage<KnowledgeRule> {
    const limit = pageLimit(query.limit);
    const start = cursorOf(query.cursor);
    const items = this.rules.filter(rule => (!query.predicate || rule.predicate === query.predicate) && (!query.version || rule.version === query.version) && scopeMatches(rule.scope, query.scope)).sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
    const page = items.slice(start, start + limit);
    return { items: page, truncated: start + limit < items.length, ...(start + limit < items.length ? { nextCursor: String(start + limit) } : {}) };
  }

  /**
   * Persist a model-authored place. It is explicitly *unverified*: no freshness timestamp is
   * written and it can never be a return target until `verifyPlaceFromObservation` binds a fresh
   * observed pose (FEC-51).
   */
  rememberPlace(place: { placeId: string; context: unknown; status?: string; payload: unknown; lastVerifiedAt?: string; provenance?: unknown; expectedRevision?: number }): PlaceView {
    const scope = normalizeMemoryScope(place.context);
    const recordedAt = this.utcNowIso();
    const provenance = { ...(asRecord(place.provenance) ?? {}), recordedAt, source: asRecord(place.provenance)?.source ?? 'model' };
    this.store.savePlace({
      placeId: place.placeId, context: scope, status: place.status ?? 'known', payload: place.payload,
      provenance, expectedRevision: place.expectedRevision,
      // A caller-supplied lastVerifiedAt is not evidence. It is intentionally not persisted.
      timeBasis: 'unknown', verificationStatus: 'unverified',
    });
    const stored = this.store.findPlaceByScope(place.placeId, scope);
    if (!stored) throw new Error('place-not-found');
    return this.placeView(stored);
  }

  /**
   * Create (or re-bind) a place from a body observation the runtime actually witnessed. Unlike
   * `rememberPlace`, the coordinates come from a trusted observation, so the place is born
   * `verified` with a UTC freshness basis (FEC-51). A non-trusted source or a stale/unknown
   * observation fails closed; the model payload is never allowed to override the witnessed pose.
   */
  rememberPlaceFromObservation(place: {
    placeId: string;
    context: unknown;
    observation: PlaceObservation;
    /** Model-supplied payload retained for provenance only; a conflicting pose is rejected. */
    payload?: unknown;
    provenance?: unknown;
    expectedRevision?: number;
    observedAtUtc?: string;
  }): PlaceView {
    const scope = normalizeMemoryScope(place.context);
    if (!place.observation || typeof place.observation !== 'object') throw new Error('observation-required');
    if (!TRUSTED_OBSERVATION_SOURCES.has(place.observation.source)) throw new Error('observation-not-trusted');
    const evidenceRef = observationEvidenceRef(place.observation);
    if (!evidenceRef) throw new Error('observation-evidence-required');
    if (place.observation.scope !== undefined && !sameScope(normalizeMemoryScope(place.observation.scope), scope)) throw new Error('observation-scope-mismatch');
    const pose = observationPose(place.observation);
    this.assertObservationFresh(place.observation.observedAtUtc ?? place.observation.receivedUtc ?? place.observedAtUtc);
    // A place is a navigation *target*: the block the body occupies. The witnessed pose may be
    // fractional, so it is floored to its block cell exactly as `poseBlock` does elsewhere. The
    // model payload must agree with that cell; it never overrides the witnessed position.
    // A planar (2D) observation carries no z; it is floored on the z=0 layer, matching the
    // rest of the codebase's treatment of legacy/2D bodies.
    const cell = { x: Math.floor(pose.x), y: Math.floor(pose.y), z: Math.floor(pose.z ?? 0) };
    const payload = posePayload(place.payload, cell);
    const existing = this.store.findPlaceByScope(place.placeId, scope);
    const recordedAt = this.utcNowIso();
    const provenance = {
      ...(asRecord(existing?.provenance) ?? {}), ...(asRecord(place.provenance) ?? {}),
      recordedAt, source: place.observation.source, evidenceRef,
      ...(place.observation.fieldRevision ? { fieldRevision: place.observation.fieldRevision } : {}),
    };
    this.store.savePlace({
      placeId: place.placeId, context: scope, status: 'known', payload, lastVerifiedAt: recordedAt,
      timeBasis: 'utc', verificationStatus: 'verified', provenance, expectedRevision: place.expectedRevision,
    });
    const stored = this.store.findPlaceByScope(place.placeId, scope);
    if (!stored) throw new Error('place-not-found');
    return this.placeView(stored);
  }

  updatePlace(placeId: string, scopeValue: unknown, change: { status?: string; payload?: unknown; lastVerifiedAt?: string; provenance?: unknown; expectedRevision?: number }): PlaceView {
    const scope = normalizeMemoryScope(scopeValue);
    const existing = this.store.findPlaceByScope(placeId, scope);
    if (!existing) throw new Error('place-not-found');
    const existingVerified = (existing as { verificationStatus?: string }).verificationStatus === 'verified'
      && (existing as { timeBasis?: string }).timeBasis === 'utc';
    const provenance = change.provenance === undefined ? undefined : { ...(asRecord(change.provenance) ?? {}), recordedAt: this.utcNowIso() };
    this.store.updatePlace({
      placeId, context: scope, status: change.status, payload: change.payload,
      ...(existingVerified && change.lastVerifiedAt !== undefined ? { lastVerifiedAt: change.lastVerifiedAt } : {}),
      provenance, expectedRevision: change.expectedRevision,
    });
    const stored = this.store.findPlaceByScope(placeId, scope);
    if (!stored) throw new Error('place-not-found');
    return this.placeView(stored);
  }

  invalidatePlace(placeId: string, scopeValue: unknown, reason: string, expectedRevision?: number): PlaceView {
    const scope = normalizeMemoryScope(scopeValue);
    return this.placeView(this.store.invalidatePlace(placeId, scope, reason || 'invalidated', expectedRevision));
  }

  /**
   * Bind a fresh observation to an existing place. Only observation evidence can make a place
   * verified; model/predicted/historical coordinates stay unverified.
   */
  verifyPlaceFromObservation(placeId: string, scopeValue: unknown, observation: PlaceObservation, options: { expectedRevision?: number } = {}): PlaceView {
    const scope = normalizeMemoryScope(scopeValue);
    if (!observation || typeof observation !== 'object') throw new Error('observation-required');
    if (!TRUSTED_OBSERVATION_SOURCES.has(observation.source)) throw new Error('observation-not-trusted');
    const evidenceRef = observationEvidenceRef(observation);
    if (!evidenceRef) throw new Error('observation-evidence-required');
    if (observation.scope !== undefined && !sameScope(normalizeMemoryScope(observation.scope), scope)) throw new Error('observation-scope-mismatch');
    const existing = this.store.findPlaceByScope(placeId, scope);
    if (!existing) throw new Error('place-not-found');
    const pose = observationPose(observation);
    const now = this.utcNowIso();
    this.assertObservationFresh(observation.observedAtUtc ?? observation.receivedUtc, now);
    const provenance = {
      ...(asRecord((existing as { provenance?: unknown }).provenance) ?? {}),
      recordedAt: now, source: observation.source, evidenceRef,
      ...(observation.fieldRevision ? { fieldRevision: observation.fieldRevision } : {}),
    };
    this.store.savePlace({
      placeId, context: scope, status: 'known', payload: pose, lastVerifiedAt: now,
      timeBasis: 'utc', verificationStatus: 'verified', provenance, expectedRevision: options.expectedRevision,
    });
    const stored = this.store.findPlaceByScope(placeId, scope);
    if (!stored) throw new Error('place-not-found');
    return this.placeView(stored);
  }

  /**
   * A supplied observation timestamp must be a trustworthy UTC value: not in the future beyond the
   * skew tolerance, and not older than the freshness window. Absent timestamps are allowed (the
   * caller's `utcNow` becomes the basis); a supplied but unparsable one fails closed.
   */
  private assertObservationFresh(observedAt: string | undefined, now: string = this.utcNowIso()): void {
    if (observedAt === undefined) return;
    const observed = Date.parse(observedAt);
    const current = Date.parse(now);
    if (!Number.isFinite(observed)) throw new Error('observation-time-invalid');
    if (observed - current > this.futureToleranceMs) throw new Error('observation-clock-skew');
    if (current - observed > this.freshnessMaxAgeMs) throw new Error('observation-stale');
  }

  /** Exact-scope resolution; a place in another world/dimension/account is never returned. */
  resolvePlace(placeId: string, scopeValue: unknown): PlaceView | undefined {
    const scope = normalizeMemoryScope(scopeValue);
    const row = this.store.findPlaceByScope(placeId, scope);
    if (!row) return undefined;
    const view = this.placeView(row);
    return sameScope(view.scope, scope) ? view : undefined;
  }

  queryPlaces(options: { scope?: unknown; status?: string; limit?: number; cursor?: string } = {}): MemoryPage<PlaceView> {
    const scope = options.scope === undefined ? undefined : normalizeMemoryScope(options.scope);
    const page = this.store.listPlacesPageByScope(scope, { status: options.status, limit: pageLimit(options.limit), cursor: options.cursor === undefined ? undefined : String(cursorOf(options.cursor)) });
    return { items: page.items.map(row => this.placeView(row)), truncated: page.truncated, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }
  /** Existing router/tool name; returns annotated views with freshness. */
  querySpatial(options: { scope?: unknown; status?: string; limit?: number; cursor?: string } = {}): MemoryPage<PlaceView> { return this.queryPlaces(options); }

  /**
   * The only place-derived value return_to_place may use. A stale, invalid, unverified or
   * cross-scope place yields no target; execution history is never consulted as a substitute.
   */
  returnToPlaceTarget(placeId: string, scopeValue: unknown, options: { utcNow?: string; now?: number } = {}): { x: number; y: number; z?: number; placeId: string; revision: number; freshness: 'current'; scope: MemoryScope } | undefined {
    const view = this.resolvePlace(placeId, scopeValue);
    if (!view) return undefined;
    if (view.verificationStatus !== 'verified') return undefined;
    const freshness = this.freshnessOf(view, options.utcNow);
    if (freshness !== 'current') return undefined;
    const payload = view.payload as { x?: unknown; y?: unknown; z?: unknown } | undefined;
    if (!payload || typeof payload.x !== 'number' || typeof payload.y !== 'number' || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return undefined;
    // A stored z is used only when it is finite. Absence stays explicit and is
    // mapped by the caller's coordinate contract, never silently written as z=0.
    const z = typeof payload.z === 'number' && Number.isFinite(payload.z) ? payload.z : undefined;
    return { x: payload.x, y: payload.y, ...(z === undefined ? {} : { z }), placeId, revision: view.revision, freshness: 'current', scope: view.scope };
  }

  resolveReturnToPlace(placeId: string, scopeValue: unknown, options: { utcNow?: string; now?: number } = {}): { ok: true; target: NonNullable<ReturnType<MemoryService['returnToPlaceTarget']>> } | { ok: false; reason: string } {
    const view = this.resolvePlace(placeId, scopeValue);
    if (!view) return { ok: false, reason: 'unknown-place' };
    if (view.status === 'invalid') return { ok: false, reason: 'place-invalid' };
    if (view.verificationStatus !== 'verified') return { ok: false, reason: 'place-unverified' };
    const freshness = this.freshnessOf(view, options.utcNow);
    if (freshness === 'invalid') return { ok: false, reason: 'place-invalid' };
    if (view.timeBasis !== 'utc') return { ok: false, reason: 'place-time-unknown' };
    if (freshness === 'stale' || freshness === 'unknown') return { ok: false, reason: `place-${freshness}` };
    const target = this.returnToPlaceTarget(placeId, scopeValue, options);
    return target ? { ok: true, target } : { ok: false, reason: 'place-position-missing' };
  }

  recordExecutionExperience(input: ExecutionExperienceInput): ExecutionExperienceView {
    if (!input || !Array.isArray(input.premises) || input.premises.length === 0) throw new Error('experience-premises-required');
    if (typeof input.failureClass !== 'string' || !input.failureClass) throw new Error('experience-failure-class-required');
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) throw new Error('experience-evidence-required');
    if (input.premises.some(premise => !premise || typeof premise.name !== 'string' || !premise.name || !('value' in premise))) throw new Error('experience-premise-invalid');
    if (input.evidence.some(item => !item || typeof item.kind !== 'string' || !item.kind)) throw new Error('experience-evidence-invalid');
    // A confirmed execution has no failure class; a failure must name one. This prevents a
    // success from being stored as a reusable "rule" about a failure or vice versa.
    if (input.outcome === 'confirmed' && input.failureClass !== 'none') throw new Error('experience-failure-class-conflict');
    if (input.outcome !== 'confirmed' && input.failureClass === 'none') throw new Error('experience-failure-class-required');
    const scope = normalizeMemoryScope(input.scope);
    const summary = {
      kind: 'execution-experience', skillId: input.skillId, goalId: input.goalId, executionId: input.executionId,
      outcome: input.outcome, failureClass: input.failureClass, premises: input.premises, evidence: input.evidence,
      // A single execution is evidence about that execution only. It never becomes a world rule.
      authorizesWorldRule: false, authorizesAction: false,
    };
    const row = this.store.saveEpisode({
      episodeId: input.episodeId, context: scope, eventRefs: input.evidence.map(item => item.ref).filter(Boolean),
      summary, provenance: input.provenance ?? { source: 'execution', recordedAt: this.utcNowIso() },
    });
    void row;
    const stored = this.store.getEpisode(input.episodeId, scope);
    if (!stored) throw new Error('episode-not-found');
    return this.experienceView(stored);
  }

  queryExperiences(options: { scope?: unknown; limit?: number; cursor?: string } = {}): MemoryPage<ExecutionExperienceView> {
    const scope = options.scope === undefined ? undefined : normalizeMemoryScope(options.scope);
    const page = this.store.listEpisodesPage(scope, { kind: 'execution-experience', limit: pageLimit(options.limit), cursor: options.cursor === undefined ? undefined : String(cursorOf(options.cursor)) });
    return { items: page.items.map(row => this.experienceView(row)), truncated: page.truncated, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  queryEpisodic(options: { scope?: unknown; limit?: number; cursor?: string } = {}): MemoryPage<(ReturnType<SQLiteStore['getEpisode']> & { authorizesAction: false })> {
    const scope = options.scope === undefined ? undefined : normalizeMemoryScope(options.scope);
    const page = this.store.listEpisodesPage(scope, { limit: pageLimit(options.limit), cursor: options.cursor === undefined ? undefined : String(cursorOf(options.cursor)) });
    return { items: page.items.map(row => ({ ...row, authorizesAction: false as const })), truncated: page.truncated, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  recordEpisode(episode: { episodeId: string; context: unknown; eventRefs: unknown; summary: unknown }) {
    this.store.saveEpisode({ ...episode, context: normalizeMemoryScope(episode.context) });
    return this.store.getEpisode(episode.episodeId, normalizeMemoryScope(episode.context));
  }

  private placeView(row: NonNullable<ReturnType<SQLiteStore['getPlace']>>): PlaceView {
    const scope = safeScope(row.context);
    const verificationStatus = normalizeVerificationStatus((row as { verificationStatus?: string }).verificationStatus);
    const timeBasis = normalizeTimeBasis((row as { timeBasis?: string }).timeBasis);
    const freshness = this.freshnessOf({ status: row.status, lastVerifiedAt: row.lastVerifiedAt ?? undefined, verificationStatus, timeBasis }, undefined);
    return {
      placeId: row.place_id, scope, context: scope, status: row.status, revision: Number((row as { revision?: number }).revision ?? 0),
      lastVerifiedAt: row.lastVerifiedAt ?? undefined,
      verificationStatus, timeBasis,
      invalidatedReason: (row as { invalidatedReason?: string }).invalidatedReason,
      provenance: (row as { provenance?: unknown }).provenance,
      payload: row.payload, freshness, fresh: freshness === 'current',
      ...(freshness !== 'current' ? { freshnessReason: freshness } : {}),
    };
  }

  private experienceView(row: NonNullable<ReturnType<SQLiteStore['getEpisode']>>): ExecutionExperienceView {
    const summary = row.summary as Record<string, unknown>;
    return {
      episodeId: row.episode_id, scope: safeScope(row.context), kind: 'execution-experience',
      skillId: String(summary.skillId ?? ''), goalId: summary.goalId ? String(summary.goalId) : undefined,
      executionId: summary.executionId ? String(summary.executionId) : undefined,
      outcome: String(summary.outcome ?? 'unknown'), failureClass: String(summary.failureClass ?? 'unknown'),
      premises: summary.premises, evidence: summary.evidence, provenance: (row as { provenance?: unknown }).provenance,
      authorizesAction: false, authorizesWorldRule: false,
    };
  }

  private freshnessOf(view: { status: string; lastVerifiedAt?: string; verificationStatus?: PlaceVerificationStatus; timeBasis?: PlaceTimeBasis }, utcNowOverride: string | undefined): PlaceFreshness {
    if (view.status === 'invalid') return 'invalid';
    if (view.status === 'stale') return 'stale';
    // Legacy rows without a recorded clock domain are unknown. They are never guessed
    // as current (or stale) from the local wall clock.
    if (view.verificationStatus !== 'verified') return 'unknown';
    if (view.timeBasis !== 'utc') return 'unknown';
    if (!view.lastVerifiedAt) return 'unknown';
    const verified = Date.parse(view.lastVerifiedAt);
    if (!Number.isFinite(verified)) return 'unknown';
    const nowText = utcNowOverride ?? this.safeUtcNow();
    if (!nowText) return 'unknown';
    const now = Date.parse(nowText);
    if (!Number.isFinite(now)) return 'unknown';
    if (verified - now > this.futureToleranceMs) return 'unknown';
    return now - verified > this.freshnessMaxAgeMs ? 'stale' : 'current';
  }
}
function scopeMatches(value: MemoryScope, wanted?: MemoryScope) { return !wanted || Object.entries(wanted).every(([key, item]) => item === undefined || value[key as keyof MemoryScope] === item); }
/**
 * Adapter for navigation's return_to_place. The navigation stream should call this instead of
 * bridge.findPlace, so stale/invalid/unverified/cross-scope places never become navigation targets.
 */
export function createPlaceResolver(memory: MemoryService, scope: unknown, options: { utcNow?: string; now?: number } = {}) {
  return (placeId: string): { x: number; y: number; z?: number } | undefined => {
    const target = memory.returnToPlaceTarget(placeId, scope, options);
    return target ? { x: target.x, y: target.y, ...(target.z === undefined ? {} : { z: target.z }) } : undefined;
  };
}
/**
 * Scope is resolved on every call from `scopeSource` (FEC-49). A callback returning an
 * unresolved scope never produces a target and never falls back to a frozen scope.
 */
export function createDynamicPlaceResolver(memory: MemoryService, scopeSource: () => unknown, options: { utcNow?: string | (() => string); now?: number } = {}) {
  return (placeId: string): { x: number; y: number; z?: number } | undefined => {
    const resolution = resolveMemoryScope(scopeSource());
    if (resolution.status !== 'resolved') return undefined;
    const utcNow = typeof options.utcNow === 'function' ? options.utcNow() : options.utcNow;
    const target = memory.returnToPlaceTarget(placeId, resolution.scope, { ...(utcNow ? { utcNow } : {}), ...(options.now !== undefined ? { now: options.now } : {}) });
    return target ? { x: target.x, y: target.y, ...(target.z === undefined ? {} : { z: target.z }) } : undefined;
  };
}
/** Alias used by callers that describe the resolver by its scope source. */
export const createScopedPlaceResolver = createDynamicPlaceResolver;
/** Legacy fixtures stored a plain string context; read them without weakening new write validation. */
function safeScope(value: unknown): MemoryScope {
  if (value && typeof value === 'object') return normalizeMemoryScope(value);
  return { serverProfileId: String(value ?? 'unknown') };
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/**
 * Reconcile a model-supplied place payload with the witnessed pose. The observed pose is
 * authoritative: when the caller also supplied coordinates they must agree, otherwise the model
 * would be silently overriding what the body actually saw (rejected as `place-payload-mismatch`).
 */
function posePayload(payload: unknown, pose: { x: number; y: number; z?: number }): { x: number; y: number; z?: number } {
  const record = asRecord(payload);
  if (!record) return pose;
  const x = record.x, y = record.y, z = record.z;
  if (x !== undefined && (typeof x !== 'number' || x !== pose.x)) throw new Error('place-payload-mismatch');
  if (y !== undefined && (typeof y !== 'number' || y !== pose.y)) throw new Error('place-payload-mismatch');
  if (z !== undefined && (typeof z !== 'number' || z !== pose.z)) throw new Error('place-payload-mismatch');
  return pose;
}
function normalizeVerificationStatus(value: string | undefined): PlaceVerificationStatus {
  return value === 'verified' || value === 'unverified' || value === 'legacy-unreviewed' ? value : 'legacy-unreviewed';
}
function normalizeTimeBasis(value: string | undefined): PlaceTimeBasis {
  return value === 'utc' ? 'utc' : 'unknown';
}
function observationEvidenceRef(observation: PlaceObservation): string | undefined {
  const candidate = observation.evidenceRef ?? observation.evidence;
  if (typeof candidate === 'string' && candidate) return candidate;
  if (candidate && typeof candidate === 'object' && typeof candidate.id === 'string' && candidate.id) return candidate.id;
  return undefined;
}
function observationPose(observation: PlaceObservation): { x: number; y: number; z?: number } {
  const source = observation.pose ?? observation.position ?? observation;
  if (!source || typeof source !== 'object') throw new Error('observation-pose-required');
  const record = source as Record<string, unknown>;
  if (typeof record.x !== 'number' || typeof record.y !== 'number' || !Number.isFinite(record.x) || !Number.isFinite(record.y)) throw new Error('observation-pose-required');
  const z = typeof record.z === 'number' && Number.isFinite(record.z) ? record.z : undefined;
  return { x: record.x, y: record.y, ...(z === undefined ? {} : { z }) };
}
