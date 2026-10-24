import { readFileSync } from 'node:fs';
import type { SQLiteStore } from '../persistence/store.js';

export type MemoryScope = { serverProfileId: string; accountId?: string; worldGenerationId?: string; dimensionId?: string };
export type KnowledgeRule = { id: string; version: number; scope: MemoryScope; predicate: string; conclusion: unknown; provenance: string; observed: boolean; validFrom: string; revalidateAfter?: string };
export type MemoryPage<T> = { items: T[]; nextCursor?: string; truncated: boolean };
export type PlaceFreshness = 'current' | 'stale' | 'unknown' | 'invalid';
export type PlaceView = {
  placeId: string;
  scope: MemoryScope;
  context: MemoryScope;
  status: string;
  revision: number;
  lastVerifiedAt?: string;
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
  return scope;
}
export function scopeKey(scope: MemoryScope): string {
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

export class MemoryService {
  private readonly now: () => number;
  private readonly freshnessMaxAgeMs: number;
  constructor(private readonly store: SQLiteStore, private readonly rules: KnowledgeRule[] = [], options: { now?: () => number; freshnessMaxAgeMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.freshnessMaxAgeMs = Math.max(0, options.freshnessMaxAgeMs ?? 5 * 60_000);
  }

  /** Legacy, explicitly scoped rule query. New knowledge uses KnowledgeService releases. */
  queryKnowledge(query: { scope?: MemoryScope; predicate?: string; version?: number; limit?: number; cursor?: string } = {}): MemoryPage<KnowledgeRule> {
    const limit = pageLimit(query.limit);
    const start = cursorOf(query.cursor);
    const items = this.rules.filter(rule => (!query.predicate || rule.predicate === query.predicate) && (!query.version || rule.version === query.version) && scopeMatches(rule.scope, query.scope)).sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
    const page = items.slice(start, start + limit);
    return { items: page, truncated: start + limit < items.length, ...(start + limit < items.length ? { nextCursor: String(start + limit) } : {}) };
  }

  rememberPlace(place: { placeId: string; context: unknown; status?: string; payload: unknown; lastVerifiedAt?: string; provenance?: unknown; expectedRevision?: number }): PlaceView {
    normalizeMemoryScope(place.context);
    const lastVerifiedAt = place.lastVerifiedAt ?? new Date(this.now()).toISOString();
    this.store.savePlace({ placeId: place.placeId, context: place.context, status: place.status ?? 'known', lastVerifiedAt, payload: place.payload, provenance: place.provenance, expectedRevision: place.expectedRevision });
    const stored = this.store.findPlaceByScope(place.placeId, place.context);
    if (!stored) throw new Error('place-not-found');
    return this.placeView(stored);
  }

  updatePlace(placeId: string, scopeValue: unknown, change: { status?: string; payload?: unknown; lastVerifiedAt?: string; provenance?: unknown; expectedRevision?: number }): PlaceView {
    normalizeMemoryScope(scopeValue);
    this.store.updatePlace({ placeId, context: scopeValue, status: change.status, payload: change.payload, lastVerifiedAt: change.lastVerifiedAt, provenance: change.provenance, expectedRevision: change.expectedRevision });
    const stored = this.store.findPlaceByScope(placeId, scopeValue);
    if (!stored) throw new Error('place-not-found');
    return this.placeView(stored);
  }

  invalidatePlace(placeId: string, scopeValue: unknown, reason: string, expectedRevision?: number): PlaceView {
    normalizeMemoryScope(scopeValue);
    return this.placeView(this.store.invalidatePlace(placeId, scopeValue, reason || 'invalidated', expectedRevision));
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
   * The only place-derived value return_to_place may use. A stale, invalid or cross-scope place
   * yields no target; execution history is never consulted as a substitute.
   */
  returnToPlaceTarget(placeId: string, scopeValue: unknown, options: { now?: number } = {}): { x: number; y: number; placeId: string; revision: number; freshness: 'current'; scope: MemoryScope } | undefined {
    const view = this.resolvePlace(placeId, scopeValue);
    if (!view) return undefined;
    const freshness = this.freshnessOf(view, options.now);
    if (freshness !== 'current') return undefined;
    const payload = view.payload as { x?: unknown; y?: unknown } | undefined;
    if (!payload || typeof payload.x !== 'number' || typeof payload.y !== 'number' || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return undefined;
    return { x: payload.x, y: payload.y, placeId, revision: view.revision, freshness: 'current', scope: view.scope };
  }

  resolveReturnToPlace(placeId: string, scopeValue: unknown, options: { now?: number } = {}): { ok: true; target: NonNullable<ReturnType<MemoryService['returnToPlaceTarget']>> } | { ok: false; reason: string } {
    const view = this.resolvePlace(placeId, scopeValue);
    if (!view) return { ok: false, reason: 'unknown-place' };
    const freshness = this.freshnessOf(view, options.now);
    if (freshness === 'invalid' || view.status === 'invalid') return { ok: false, reason: 'place-invalid' };
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
      summary, provenance: input.provenance ?? { source: 'execution', recordedAt: new Date(this.now()).toISOString() },
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
    const freshness = this.freshnessOf({ status: row.status, lastVerifiedAt: row.lastVerifiedAt }, undefined);
    return {
      placeId: row.place_id, scope, context: scope, status: row.status, revision: Number((row as { revision?: number }).revision ?? 0),
      lastVerifiedAt: row.lastVerifiedAt ?? undefined,
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

  private freshnessOf(view: { status: string; lastVerifiedAt?: string }, nowOverride: number | undefined): PlaceFreshness {
    if (view.status === 'invalid') return 'invalid';
    if (view.status === 'stale') return 'stale';
    if (!view.lastVerifiedAt) return 'unknown';
    const verified = Date.parse(view.lastVerifiedAt);
    if (!Number.isFinite(verified)) return 'unknown';
    return (nowOverride ?? this.now()) - verified > this.freshnessMaxAgeMs ? 'stale' : 'current';
  }
}
function scopeMatches(value: MemoryScope, wanted?: MemoryScope) { return !wanted || Object.entries(wanted).every(([key, item]) => item === undefined || value[key as keyof MemoryScope] === item); }
/**
 * Adapter for navigation's return_to_place. The navigation stream should call this instead of
 * bridge.findPlace, so stale/invalid/cross-scope places never become navigation targets.
 */
export function createPlaceResolver(memory: MemoryService, scope: unknown, options: { now?: number } = {}) {
  return (placeId: string): { x: number; y: number } | undefined => {
    const target = memory.returnToPlaceTarget(placeId, scope, options);
    return target ? { x: target.x, y: target.y } : undefined;
  };
}
/** Legacy fixtures stored a plain string context; read them without weakening new write validation. */
function safeScope(value: unknown): MemoryScope {
  if (value && typeof value === 'object') return normalizeMemoryScope(value);
  return { serverProfileId: String(value ?? 'unknown') };
}
