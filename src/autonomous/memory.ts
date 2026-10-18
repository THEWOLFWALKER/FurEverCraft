import { readFileSync } from 'node:fs';
import type { SQLiteStore } from '../persistence/store.js';

export type MemoryScope = { serverProfileId: string; accountId?: string; worldGenerationId?: string; dimensionId?: string };
export type KnowledgeRule = { id: string; version: number; scope: MemoryScope; predicate: string; conclusion: unknown; provenance: string; observed: boolean; validFrom: string; revalidateAfter?: string };
export type MemoryPage<T> = { items: T[]; nextCursor?: string; truncated: boolean };

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

export class MemoryService {
  constructor(private readonly store: SQLiteStore, private readonly rules: KnowledgeRule[] = []) {}
  queryKnowledge(query: { scope?: MemoryScope; predicate?: string; version?: number; limit?: number; cursor?: string } = {}): MemoryPage<KnowledgeRule> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 20);
    const start = query.cursor ? Number(query.cursor) : 0;
    const items = this.rules.filter(rule => (!query.predicate || rule.predicate === query.predicate) && (!query.version || rule.version === query.version) && scopeMatches(rule.scope, query.scope)).sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
    const page = items.slice(start, start + limit);
    return { items: page, truncated: start + limit < items.length, ...(start + limit < items.length ? { nextCursor: String(start + limit) } : {}) };
  }
  querySpatial(options: { scope?: unknown; status?: string; limit?: number; cursor?: string } = {}): MemoryPage<ReturnType<SQLiteStore['getPlace']>> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 20); const start = Number(options.cursor ?? 0);
    const items = this.store.listPlaces(options.scope).filter(item => !options.status || item.status === options.status);
    const page = items.slice(start, start + limit);
    return { items: page, truncated: start + limit < items.length, ...(start + limit < items.length ? { nextCursor: String(start + limit) } : {}) };
  }
  queryEpisodic(options: { scope?: unknown; limit?: number; cursor?: string } = {}): MemoryPage<ReturnType<SQLiteStore['getEpisode']>> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 20); const start = Number(options.cursor ?? 0);
    const items = this.store.listEpisodes(options.scope); const page = items.slice(start, start + limit);
    return { items: page, truncated: start + limit < items.length, ...(start + limit < items.length ? { nextCursor: String(start + limit) } : {}) };
  }
  rememberPlace(place: { placeId: string; context: unknown; status?: string; payload: unknown; lastVerifiedAt?: string }) {
    this.store.savePlace({ ...place, status: place.status ?? 'known', lastVerifiedAt: place.lastVerifiedAt ?? new Date().toISOString() }); return this.store.getPlace(place.placeId);
  }
  /** Persist a structured episode summary when a goal/task completes or fails. */
  recordEpisode(episode: { episodeId: string; context: unknown; eventRefs: unknown; summary: unknown }) { this.store.saveEpisode(episode); return this.store.getEpisode(episode.episodeId); }
}
function scopeMatches(value: MemoryScope, wanted?: MemoryScope) { return !wanted || Object.entries(wanted).every(([key, item]) => item === undefined || value[key as keyof MemoryScope] === item); }
