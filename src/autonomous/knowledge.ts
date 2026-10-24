import { z } from 'zod';
import type { SQLiteStore } from '../persistence/store.js';

export type KnowledgeNamespace = 'rule' | 'example';
export type KnowledgeScope = { serverProfileId?: string; accountId?: string; worldGenerationId?: string; dimensionId?: string };
export type KnowledgeSource = {
  sourceId: string;
  version: string;
  kind: 'verified-rules' | 'examples' | 'reference' | 'fixture';
  origin: string;
  verified: boolean;
  /** Predicates this source is declared to cover. Absence of a source is reported as unknown. */
  covers: string[];
  sha256?: string;
  registeredAt: string;
};
export type KnowledgeSourceManifest = { manifestVersion: string; createdAt: string; sources: KnowledgeSource[] };
export type KnowledgeFact = {
  id: string;
  namespace: KnowledgeNamespace;
  predicate: string;
  subject?: string;
  value: unknown;
  sourceId: string;
  /** The exact source version the rule was extracted from. Must equal the manifest source version. */
  sourceVersion: string;
  scope?: KnowledgeScope;
  validFrom?: string;
  validUntil?: string;
  attributes?: Record<string, unknown>;
};
export type KnowledgeRelease = {
  releaseId: string;
  version: string;
  manifest: KnowledgeSourceManifest;
  rules: KnowledgeFact[];
  createdAt: string;
  notes?: string;
};
export type KnowledgeReleaseRef = { releaseId: string; version: string; createdAt: string };
export type KnowledgeQuery = {
  releaseId?: string;
  namespace?: KnowledgeNamespace;
  predicate?: string;
  subject?: string;
  scope?: KnowledgeScope;
  limit?: number;
  cursor?: string;
};
export type KnowledgeConflict = { predicate: string; subject?: string; sourceIds: string[]; values: unknown[] };
export type KnowledgeRuleHit = KnowledgeFact & { conflict?: boolean };
export type KnowledgeQueryResult = {
  releaseId?: string;
  releaseVersion?: string;
  namespace: KnowledgeNamespace;
  items: KnowledgeRuleHit[];
  nextCursor?: string;
  truncated: boolean;
  unknown: boolean;
  reason?: string;
  conflicts: KnowledgeConflict[];
  sourceVersions: Record<string, string>;
  limits: { maxItems: number; maxCursor: number };
};
export type KnowledgeCoverage = {
  releaseId?: string;
  releaseVersion?: string;
  unknown: boolean;
  reason?: string;
  sourceVersions: Record<string, string>;
  sources: { verified: number; unverified: number; total: number };
  namespaces: Record<KnowledgeNamespace, number>;
  predicates: Record<string, { sources: string[]; verifiedRules: number; examples: number }>;
  conflicts: number;
  /** Coverage only describes declared sources; it is never a claim about the full game knowledge base. */
  scope: 'declared-sources-only';
};
export type KnowledgeSourcesResult = {
  releaseId?: string; releaseVersion?: string; unknown: boolean; reason?: string;
  sources: KnowledgeSource[];
};

export const MAX_KNOWLEDGE_ITEMS = 20;
export const MAX_KNOWLEDGE_CURSOR = 10_000;

const scopeSchema = z.object({ serverProfileId: z.string().optional(), accountId: z.string().optional(), worldGenerationId: z.string().optional(), dimensionId: z.string().optional() }).strict();
export const KnowledgeQuerySchema = z.object({
  releaseId: z.string().min(1).optional(), namespace: z.enum(['rule', 'example']).optional(),
  predicate: z.string().min(1).optional(), subject: z.string().min(1).optional(), scope: scopeSchema.optional(),
  limit: z.number().int().positive().max(100).optional(), cursor: z.string().optional(),
}).strict();
export const KnowledgeSourcesQuerySchema = z.object({ releaseId: z.string().min(1).optional() }).strict();
export const KnowledgeCoverageQuerySchema = z.object({ releaseId: z.string().min(1).optional() }).strict();

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
const scopeCompatible = (ruleScope: KnowledgeScope | undefined, requested: KnowledgeScope | undefined): boolean => {
  if (!requested) return true;
  if (!ruleScope) return true;
  return Object.entries(ruleScope).every(([key, value]) => value === undefined || requested[key as keyof KnowledgeScope] === value);
};
const validityOf = (rule: KnowledgeFact, now: number): 'current' | 'future' | 'expired' => {
  const from = rule.validFrom === undefined ? undefined : Date.parse(rule.validFrom);
  if (from !== undefined && (!Number.isFinite(from) || now < from)) return 'future';
  const until = rule.validUntil === undefined ? undefined : Date.parse(rule.validUntil);
  if (until !== undefined && (!Number.isFinite(until) || now > until)) return 'expired';
  return 'current';
};
const currentAt = (rule: KnowledgeFact, now: number) => validityOf(rule, now) === 'current';
function fail(code: string, detail?: string): never { throw new Error(detail ? `${code}:${detail}` : code); }

/** Validate a release before it can become visible to any query. */
export function validateKnowledgeRelease(release: KnowledgeRelease): void {
  if (!release || typeof release.releaseId !== 'string' || !release.releaseId) fail('knowledge-invalid', 'release-id');
  if (typeof release.version !== 'string' || !release.version) fail('knowledge-invalid', 'release-version');
  if (typeof release.manifest?.manifestVersion !== 'string' || !release.manifest.manifestVersion) fail('knowledge-invalid', 'manifest-version');
  if (!Array.isArray(release.manifest.sources) || release.manifest.sources.length === 0) fail('knowledge-invalid', 'sources-empty');
  if (!Array.isArray(release.rules)) fail('knowledge-invalid', 'rules');
  const sources = new Map<string, KnowledgeSource>();
  for (const source of release.manifest.sources) {
    if (!source || typeof source.sourceId !== 'string' || !source.sourceId) fail('knowledge-invalid', 'source-id');
    if (sources.has(source.sourceId)) fail('knowledge-duplicate-source', source.sourceId);
    if (typeof source.version !== 'string' || !source.version) fail('knowledge-source-version-missing', source.sourceId);
    if (typeof source.verified !== 'boolean') fail('knowledge-source-verification-missing', source.sourceId);
    if (!Array.isArray(source.covers) || source.covers.some(item => typeof item !== 'string' || !item)) fail('knowledge-source-coverage-invalid', source.sourceId);
    sources.set(source.sourceId, source);
  }
  const ids = new Set<string>();
  for (const rule of release.rules) {
    if (!rule || typeof rule.id !== 'string' || !rule.id) fail('knowledge-invalid', 'rule-id');
    if (ids.has(rule.id)) fail('knowledge-duplicate-rule', rule.id);
    ids.add(rule.id);
    if (rule.namespace !== 'rule' && rule.namespace !== 'example') fail('knowledge-invalid-namespace', rule.id);
    if (typeof rule.predicate !== 'string' || !rule.predicate) fail('knowledge-invalid', `predicate:${rule.id}`);
    const source = sources.get(rule.sourceId);
    if (!source) fail('knowledge-source-missing', rule.sourceId);
    // The actual source version is part of the fact; a mismatch makes it unqueryable rather than silently accepted.
    if (rule.sourceVersion !== source.version) fail('knowledge-source-version-mismatch', `${rule.id}:${rule.sourceVersion}!=${source.version}`);
    if (source.verified && rule.namespace !== 'rule') fail('knowledge-verified-source-namespace', rule.id);
    if (!source.verified && rule.namespace !== 'example') fail('knowledge-unverified-source-namespace', rule.id);
    // Validity windows are wall-clock facts. Reject malformed or inverted windows at publish
    // so no query has to guess which end is authoritative.
    const from = validateValidityTimestamp(rule.validFrom, rule.id, 'validFrom');
    const until = validateValidityTimestamp(rule.validUntil, rule.id, 'validUntil');
    if (from !== undefined && until !== undefined && from > until) fail('knowledge-validity-inverted', rule.id);
  }
}

function validateValidityTimestamp(value: unknown, ruleId: string, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) fail('knowledge-validity-invalid', `${ruleId}:${field}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('knowledge-validity-invalid', `${ruleId}:${field}`);
  return parsed;
}

const keyOf = (rule: KnowledgeFact) => `${rule.predicate}\u0000${rule.subject ?? ''}`;

export function detectKnowledgeConflicts(rules: readonly KnowledgeFact[], scope?: KnowledgeScope): KnowledgeConflict[] {
  // Scope is part of the conflict domain: facts that cannot apply to the requested body scope
  // must not create a false conflict there.
  const considered = scope ? rules.filter(rule => scopeCompatible(rule.scope, scope)) : rules;
  const groups = new Map<string, KnowledgeFact[]>();
  for (const rule of considered) { const key = keyOf(rule); groups.set(key, [...(groups.get(key) ?? []), rule]); }
  const conflicts: KnowledgeConflict[] = [];
  for (const group of groups.values()) {
    const values = new Map<string, { value: unknown; sourceIds: Set<string> }>();
    for (const rule of group) { const hash = stable(rule.value); const entry = values.get(hash) ?? { value: rule.value, sourceIds: new Set<string>() }; entry.sourceIds.add(rule.sourceId); values.set(hash, entry); }
    if (values.size > 1) conflicts.push({ predicate: group[0]!.predicate, ...(group[0]!.subject ? { subject: group[0]!.subject } : {}), sourceIds: [...new Set(group.map(rule => rule.sourceId))].sort(), values: [...values.values()].map(item => item.value) });
  }
  return conflicts.sort((a, b) => `${a.predicate}\u0000${a.subject ?? ''}`.localeCompare(`${b.predicate}\u0000${b.subject ?? ''}`));
}

export type KnowledgeServiceOptions = { now?: () => number; store?: SQLiteStore };
/** Bounded queries over one fixed knowledge release. Rules and examples are separate namespaces. */
export class KnowledgeService {
  private readonly memoryReleases = new Map<string, KnowledgeRelease>();
  private activeId?: string;
  private readonly now: () => number;
  private readonly store?: SQLiteStore;
  constructor(options: KnowledgeServiceOptions = {}) { this.now = options.now ?? (() => Date.now()); this.store = options.store; }

  publish(release: KnowledgeRelease, activate = true): KnowledgeReleaseRef {
    validateKnowledgeRelease(release);
    if (this.store) {
      const stored = this.store.publishKnowledgeRelease({ releaseId: release.releaseId, version: release.version, payload: release, createdAt: release.createdAt }, activate);
      return { releaseId: stored.releaseId, version: stored.version, createdAt: stored.createdAt };
    }
    const existing = this.memoryReleases.get(release.releaseId);
    if (existing) {
      if (existing.version !== release.version || stable(existing) !== stable(release)) fail('knowledge-release-conflict', release.releaseId);
      if (activate) this.activeId = release.releaseId;
    } else {
      this.memoryReleases.set(release.releaseId, structuredClone(release));
      if (activate) this.activeId = release.releaseId;
    }
    return { releaseId: release.releaseId, version: release.version, createdAt: release.createdAt };
  }
  activate(releaseId: string): KnowledgeReleaseRef {
    if (this.store) { const stored = this.store.activateKnowledgeRelease(releaseId); return { releaseId: stored.releaseId, version: stored.version, createdAt: stored.createdAt }; }
    const release = this.memoryReleases.get(releaseId);
    if (!release) fail('knowledge-release-missing', releaseId);
    this.activeId = releaseId;
    return { releaseId, version: release.version, createdAt: release.createdAt };
  }
  activeReleaseId(): string | undefined { return this.store?.getActiveKnowledgeRelease()?.releaseId ?? this.activeId; }
  getRelease(releaseId: string): KnowledgeRelease | undefined {
    if (this.store) return this.store.getKnowledgeRelease(releaseId)?.payload as KnowledgeRelease | undefined;
    const release = this.memoryReleases.get(releaseId);
    return release ? structuredClone(release) : undefined;
  }
  listReleases(): KnowledgeReleaseRef[] {
    if (this.store) return this.store.listKnowledgeReleases().map(item => ({ releaseId: item.releaseId, version: item.version, createdAt: item.createdAt }));
    return [...this.memoryReleases.values()].map(item => ({ releaseId: item.releaseId, version: item.version, createdAt: item.createdAt })).sort((a, b) => a.releaseId.localeCompare(b.releaseId));
  }
  private resolve(releaseId?: string): KnowledgeRelease | undefined { return this.getRelease(releaseId ?? this.activeReleaseId() ?? ''); }

  query(input: KnowledgeQuery = {}): KnowledgeQueryResult {
    const parsed = KnowledgeQuerySchema.parse(input);
    const namespace = parsed.namespace ?? 'rule';
    const release = this.resolve(parsed.releaseId);
    if (!release) return { namespace, items: [], truncated: false, unknown: true, reason: 'release-missing', conflicts: [], sourceVersions: {}, limits: { maxItems: MAX_KNOWLEDGE_ITEMS, maxCursor: MAX_KNOWLEDGE_CURSOR } };
    const limit = Math.min(parsed.limit ?? MAX_KNOWLEDGE_ITEMS, MAX_KNOWLEDGE_ITEMS);
    const start = parsed.cursor === undefined ? 0 : Number(parsed.cursor);
    if (!Number.isInteger(start) || start < 0) fail('invalid-knowledge-cursor', String(parsed.cursor));
    if (start > MAX_KNOWLEDGE_CURSOR) fail('knowledge-cursor-limit', String(start));
    const now = this.now();
    const filtered = release.rules
      .filter(rule => rule.namespace === namespace)
      .filter(rule => !parsed.predicate || rule.predicate === parsed.predicate)
      .filter(rule => !parsed.subject || rule.subject === parsed.subject)
      .filter(rule => scopeCompatible(rule.scope, parsed.scope))
      // A query answers for the current wall clock. Expired and not-yet-valid facts are not
      // returned as current knowledge; the release itself remains the historical record.
      .filter(rule => currentAt(rule, now))
      .sort((a, b) => `${a.predicate}\u0000${a.subject ?? ''}\u0000${a.id}`.localeCompare(`${b.predicate}\u0000${b.subject ?? ''}\u0000${b.id}`));
    const conflicts = detectKnowledgeConflicts(filtered, parsed.scope);
    const conflictKeys = new Set(conflicts.map(conflict => `${conflict.predicate}\u0000${conflict.subject ?? ''}`));
    const items: KnowledgeRuleHit[] = filtered.slice(start, start + limit).map(rule => ({ ...rule, ...(conflictKeys.has(keyOf(rule)) ? { conflict: true } : {}) }));
    const covered = !parsed.predicate || release.manifest.sources.some(source => source.covers.includes(parsed.predicate!));
    const unknown = Boolean(parsed.predicate) && filtered.length === 0 && !covered;
    return {
      releaseId: release.releaseId, releaseVersion: release.version, namespace, items,
      ...(start + limit < filtered.length ? { nextCursor: String(start + limit) } : {}),
      truncated: start + limit < filtered.length,
      unknown, ...(unknown ? { reason: 'missing-source' } : {}),
      conflicts,
      sourceVersions: Object.fromEntries(release.manifest.sources.map(source => [source.sourceId, source.version])),
      limits: { maxItems: MAX_KNOWLEDGE_ITEMS, maxCursor: MAX_KNOWLEDGE_CURSOR },
    };
  }

  sources(releaseId?: string): KnowledgeSourcesResult {
    const release = this.resolve(releaseId);
    if (!release) return { unknown: true, reason: 'release-missing', sources: [] };
    return { releaseId: release.releaseId, releaseVersion: release.version, unknown: false, sources: structuredClone(release.manifest.sources) };
  }

  coverage(releaseId?: string): KnowledgeCoverage {
    const release = this.resolve(releaseId);
    if (!release) return { unknown: true, reason: 'release-missing', sourceVersions: {}, sources: { verified: 0, unverified: 0, total: 0 }, namespaces: { rule: 0, example: 0 }, predicates: {}, conflicts: 0, scope: 'declared-sources-only' };
    const predicates: KnowledgeCoverage['predicates'] = {};
    for (const source of release.manifest.sources) for (const predicate of source.covers) {
      const entry = predicates[predicate] ?? { sources: [], verifiedRules: 0, examples: 0 };
      entry.sources.push(source.sourceId);
      predicates[predicate] = entry;
    }
    for (const rule of release.rules) {
      const entry = predicates[rule.predicate] ?? { sources: [], verifiedRules: 0, examples: 0 };
      if (rule.namespace === 'rule') entry.verifiedRules++; else entry.examples++;
      predicates[rule.predicate] = entry;
    }
    return {
      releaseId: release.releaseId, releaseVersion: release.version, unknown: false,
      sourceVersions: Object.fromEntries(release.manifest.sources.map(source => [source.sourceId, source.version])),
      sources: { verified: release.manifest.sources.filter(source => source.verified).length, unverified: release.manifest.sources.filter(source => !source.verified).length, total: release.manifest.sources.length },
      namespaces: { rule: release.rules.filter(rule => rule.namespace === 'rule').length, example: release.rules.filter(rule => rule.namespace === 'example').length },
      predicates,
      conflicts: detectKnowledgeConflicts(release.rules).length,
      scope: 'declared-sources-only',
    };
  }

  /**
   * Small tool surface for the agent router: facts, sources and coverage. `scope` is injected
   * by the runtime for fact queries; it overrides any scope present in the model arguments so
   * a caller cannot read another world/account's scoped rules.
   */
  invoke(tool: 'query_knowledge' | 'query_knowledge_facts' | 'query_knowledge_sources' | 'query_knowledge_coverage', args: unknown, options: { scope?: KnowledgeScope } = {}): { ok: boolean; result?: unknown; error?: string } {
    try {
      if (tool === 'query_knowledge' || tool === 'query_knowledge_facts') {
        const parsed = KnowledgeQuerySchema.parse(args ?? {});
        return { ok: true, result: this.query({ ...parsed, ...(options.scope ? { scope: options.scope } : {}) }) };
      }
      if (tool === 'query_knowledge_sources') return { ok: true, result: this.sources(KnowledgeSourcesQuerySchema.parse(args ?? {}).releaseId) };
      if (tool === 'query_knowledge_coverage') return { ok: true, result: this.coverage(KnowledgeCoverageQuerySchema.parse(args ?? {}).releaseId) };
      return { ok: false, error: 'unknown-knowledge-tool' };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

export const knowledgeToolDefinitions = [
  { name: 'query_knowledge_facts', description: 'Query verified rules or unverified examples from one fixed knowledge release', parameters: { type: 'object', properties: { releaseId: { type: 'string' }, namespace: { type: 'string', enum: ['rule', 'example'] }, predicate: { type: 'string' }, subject: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 }, cursor: { type: 'string' } }, additionalProperties: false } },
  { name: 'query_knowledge_sources', description: 'List source ids, actual source versions and verification status for a release', parameters: { type: 'object', properties: { releaseId: { type: 'string' } }, additionalProperties: false } },
  { name: 'query_knowledge_coverage', description: 'Show declared predicate coverage and boundaries for a release', parameters: { type: 'object', properties: { releaseId: { type: 'string' } }, additionalProperties: false } },
] as const;
