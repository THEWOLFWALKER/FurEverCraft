import { z } from 'zod';
import type { SQLiteStore } from '../persistence/store.js';
import { canonicalScopeKey, resolveStableScope, type StableScope } from '../contracts/context.js';

export type KnowledgeNamespace = 'rule' | 'example';
export type KnowledgeScope = { serverProfileId?: string; accountId?: string; worldGenerationId?: string; dimensionId?: string };
/** Global facts are explicitly vanilla/world-independent; server facts bind one full scope. */
export type KnowledgeScopeKind = 'global' | 'server';
export type KnowledgeCompleteness = 'complete' | 'partial' | 'unknown';
export type KnowledgeEvidence = 'file-verified' | 'candidate-inherited-unverified' | 'synthetic-contract' | 'none';
/** Structured coverage. A declared predicate is not proof about every subject. */
export type KnowledgeCoverageEntry = {
  predicate: string;
  /** Absent means the completeness applies to the whole predicate. */
  subjects?: string[];
  completeness: KnowledgeCompleteness;
};
export type KnowledgeFactProvenance = {
  repository?: string;
  commit?: string;
  path?: string;
  sourceVersion?: string;
  immutableUrl?: string;
  branchKind?: string;
  inherited?: boolean;
  importedAtUtc?: string;
  transformerVersion?: string;
  [key: string]: unknown;
};
export type KnowledgeSource = {
  sourceId: string;
  version: string;
  kind: 'verified-rules' | 'examples' | 'reference' | 'fixture';
  origin: string;
  verified: boolean;
  /** Legacy predicate list. Treated as partial/unknown coverage, never as complete. */
  covers: string[];
  /** Preferred structured declaration with a complete/partial/unknown state. */
  coverage?: KnowledgeCoverageEntry[];
  sha256?: string;
  /** Source repository commit / path for immutable provenance. */
  commit?: string;
  path?: string;
  inherited?: boolean;
  evidence?: KnowledgeEvidence;
  integrity?: 'verified' | 'failed';
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
  /**
   * Explicit scope kind for every new fact. Facts without it are legacy/unscoped: they remain
   * readable as release history but never match any query (FEC-45).
   */
  scopeKind?: KnowledgeScopeKind;
  scope?: KnowledgeScope;
  validFrom?: string;
  validUntil?: string;
  attributes?: Record<string, unknown>;
  provenance?: KnowledgeFactProvenance;
};
export type KnowledgeRelease = {
  releaseId: string;
  version: string;
  manifest: KnowledgeSourceManifest;
  rules: KnowledgeFact[];
  createdAt: string;
  notes?: string;
  /** A release may carry its own integrity verdict; a failed release is not queryable as facts. */
  integrity?: 'verified' | 'failed';
};
export type KnowledgeReleaseRef = { releaseId: string; version: string; createdAt: string };
export type KnowledgeQuery = {
  releaseId?: string;
  namespace?: KnowledgeNamespace;
  predicate?: string;
  subject?: string;
  /** Trusted scope injected by the service call. Model-facing tools cannot supply it. */
  scope?: KnowledgeScope;
  limit?: number;
  cursor?: string;
};
export type KnowledgeConflict = { predicate: string; subject?: string; sourceIds: string[]; values: unknown[] };
export type KnowledgeRuleHit = KnowledgeFact & { conflict?: boolean };
/**
 * Exhaustive result status. A verified negative is distinct from incomplete coverage and from
 * unavailable/integrity/candidate data (FEC-52).
 */
export type KnowledgeQueryStatus =
  | 'found'
  | 'not_found_in_verified_dataset'
  | 'unknown_due_to_incomplete_coverage'
  | 'source_unavailable'
  | 'integrity-failed'
  | 'candidate-inherited-unverified';
export type KnowledgeQueryResult = {
  releaseId?: string;
  releaseVersion?: string;
  namespace: KnowledgeNamespace;
  status: KnowledgeQueryStatus;
  items: KnowledgeRuleHit[];
  nextCursor?: string;
  truncated: boolean;
  /** Compatibility boolean derived from `status`; never an independent judgement. */
  unknown: boolean;
  reason?: string;
  scopeStatus: 'resolved' | 'unresolved' | 'not-requested';
  coverage?: { predicate?: string; completeness: KnowledgeCompleteness; subjectCovered?: boolean };
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
  predicates: Record<string, { sources: string[]; verifiedRules: number; examples: number; completeness: KnowledgeCompleteness }>;
  /** Structured declarations that distinguish complete from partial/unknown. */
  entries: Array<KnowledgeCoverageEntry & { sources: string[] }>;
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
const queryBody = {
  releaseId: z.string().min(1).optional(), namespace: z.enum(['rule', 'example']).optional(),
  predicate: z.string().min(1).optional(), subject: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(), cursor: z.string().optional(),
};
/** Direct service API: scope may be supplied by a trusted caller. */
export const KnowledgeQuerySchema = z.object({ ...queryBody, scope: scopeSchema.optional() }).strict();
/** Model-facing tool schema: scope is deliberately absent, so a model can never choose it. */
export const KnowledgeToolQuerySchema = z.object(queryBody).strict();
export const KnowledgeSourcesQuerySchema = z.object({ releaseId: z.string().min(1).optional() }).strict();
export const KnowledgeCoverageQuerySchema = z.object({ releaseId: z.string().min(1).optional() }).strict();

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
function fail(code: string, detail?: string): never { throw new Error(detail ? `${code}:${detail}` : code); }

/** Convert a knowledge scope to a full stable scope. Partial identity has no key. */
export function knowledgeScopeToStableScope(scope: KnowledgeScope | undefined): StableScope | undefined {
  if (!scope) return undefined;
  const source = scope as KnowledgeScope & { dimension?: unknown };
  const resolved = resolveStableScope({
    serverProfileId: source.serverProfileId,
    accountId: source.accountId,
    worldGenerationId: source.worldGenerationId,
    dimension: source.dimensionId ?? (typeof source.dimension === 'string' ? source.dimension : undefined),
  } as Record<string, unknown>);
  return resolved.status === 'resolved' ? resolved.scope : undefined;
}
export type KnowledgeScopeResolution =
  | { status: 'resolved'; scope: StableScope; scopeKey: string }
  | { status: 'unresolved'; missing: string[] };
export function resolveKnowledgeScope(value: unknown): KnowledgeScopeResolution {
  let candidate = value;
  if (candidate && typeof candidate === 'object') {
    const record = candidate as Record<string, unknown>;
    if (record.status === 'resolved' && record.scope && typeof record.scope === 'object') candidate = record.scope;
    else if (record.status === 'unresolved') return { status: 'unresolved', missing: Array.isArray(record.missing) ? record.missing.map(String) : ['context'] };
    else if (record.context && typeof record.context === 'object') candidate = record.context;
  }
  const partial = (candidate && typeof candidate === 'object' ? candidate : {}) as KnowledgeScope & { dimension?: unknown };
  const stableScope = knowledgeScopeToStableScope(partial);
  if (!stableScope) {
    const missing: string[] = [];
    if (!partial.serverProfileId) missing.push('serverProfileId');
    if (!partial.accountId) missing.push('accountId');
    if (!partial.worldGenerationId) missing.push('worldGenerationId');
    if (!partial.dimensionId && !partial.dimension) missing.push('dimensionId');
    return { status: 'unresolved', missing: missing.length ? missing : ['context'] };
  }
  return { status: 'resolved', scope: stableScope, scopeKey: canonicalScopeKey(stableScope) };
}

/** Strict fact/scope binding. A legacy unscoped fact never matches. */
export function knowledgeFactMatchesScope(fact: Pick<KnowledgeFact, 'scopeKind' | 'scope'>, requested: StableScope | undefined): boolean {
  if (fact.scopeKind === 'global') return true;
  if (fact.scopeKind !== 'server' || !requested) return false;
  const factScope = knowledgeScopeToStableScope(fact.scope);
  return Boolean(factScope && canonicalScopeKey(factScope) === canonicalScopeKey(requested));
}

function candidateSource(source: KnowledgeSource): boolean {
  return source.inherited === true || source.evidence === 'candidate-inherited-unverified';
}

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
    if (source.coverage !== undefined) {
      if (!Array.isArray(source.coverage)) fail('knowledge-source-coverage-invalid', source.sourceId);
      for (const entry of source.coverage) {
        if (!entry || typeof entry.predicate !== 'string' || !entry.predicate) fail('knowledge-source-coverage-invalid', source.sourceId);
        if (!['complete', 'partial', 'unknown'].includes(entry.completeness)) fail('knowledge-source-coverage-invalid', source.sourceId);
        if (entry.subjects !== undefined && (!Array.isArray(entry.subjects) || entry.subjects.some(item => typeof item !== 'string' || !item))) fail('knowledge-source-coverage-invalid', source.sourceId);
      }
    }
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
    // Legacy facts (no scopeKind) remain historical records but are explicitly unresolved.
    if (rule.scopeKind !== undefined && rule.scopeKind !== 'global' && rule.scopeKind !== 'server') fail('knowledge-invalid-scope-kind', rule.id);
    if (rule.scopeKind === 'global' && rule.scope && Object.keys(rule.scope).length > 0) fail('knowledge-global-scope-invalid', rule.id);
    if (rule.scopeKind === 'server' && !rule.scope?.serverProfileId) fail('knowledge-server-scope-missing', rule.id);
  }
}

const keyOf = (rule: KnowledgeFact) => `${rule.predicate} ${rule.subject ?? ''}`;

export function detectKnowledgeConflicts(rules: readonly KnowledgeFact[]): KnowledgeConflict[] {
  const groups = new Map<string, KnowledgeFact[]>();
  for (const rule of rules) { const key = keyOf(rule); groups.set(key, [...(groups.get(key) ?? []), rule]); }
  const conflicts: KnowledgeConflict[] = [];
  for (const group of groups.values()) {
    const values = new Map<string, { value: unknown; sourceIds: Set<string> }>();
    for (const rule of group) { const hash = stable(rule.value); const entry = values.get(hash) ?? { value: rule.value, sourceIds: new Set<string>() }; entry.sourceIds.add(rule.sourceId); values.set(hash, entry); }
    if (values.size > 1) conflicts.push({ predicate: group[0]!.predicate, ...(group[0]!.subject ? { subject: group[0]!.subject } : {}), sourceIds: [...new Set(group.map(rule => rule.sourceId))].sort(), values: [...values.values()].map(item => item.value) });
  }
  return conflicts.sort((a, b) => `${a.predicate} ${a.subject ?? ''}`.localeCompare(`${b.predicate} ${b.subject ?? ''}`));
}

type PredicateCoverage = {
  declared: boolean;
  completeAll: boolean;
  completeSubjects: Set<string>;
  partial: boolean;
  unknown: boolean;
  sources: Set<string>;
};
function coverageIndex(release: KnowledgeRelease): Map<string, PredicateCoverage> {
  const index = new Map<string, PredicateCoverage>();
  const merge = (predicate: string, sourceId: string, completeness: KnowledgeCompleteness, subjects?: string[]) => {
    const entry = index.get(predicate) ?? { declared: false, completeAll: false, completeSubjects: new Set<string>(), partial: false, unknown: false, sources: new Set<string>() };
    entry.declared = true;
    entry.sources.add(sourceId);
    if (completeness === 'complete') {
      if (!subjects || subjects.length === 0) entry.completeAll = true;
      else for (const subject of subjects) entry.completeSubjects.add(subject);
    } else if (completeness === 'partial') entry.partial = true;
    else entry.unknown = true;
    index.set(predicate, entry);
  };
  for (const source of release.manifest.sources) {
    for (const predicate of source.covers) merge(predicate, source.sourceId, 'unknown');
    for (const entry of source.coverage ?? []) merge(entry.predicate, source.sourceId, entry.completeness, entry.subjects);
  }
  return index;
}
function coverageState(entry: PredicateCoverage | undefined, subject: string | undefined): { completeness: KnowledgeCompleteness; subjectCovered?: boolean; verifiedNegative: boolean } {
  if (!entry) return { completeness: 'unknown', verifiedNegative: false };
  const subjectCovered = subject === undefined ? undefined : entry.completeAll || entry.completeSubjects.has(subject);
  const verifiedNegative = entry.completeAll || subjectCovered === true;
  const completeness: KnowledgeCompleteness = verifiedNegative ? 'complete' : entry.unknown && !entry.partial ? 'unknown' : entry.unknown ? 'unknown' : 'partial';
  return { completeness, ...(subjectCovered === undefined ? {} : { subjectCovered }), verifiedNegative };
}

const UNKNOWN_STATUSES: ReadonlySet<KnowledgeQueryStatus> = new Set(['unknown_due_to_incomplete_coverage', 'source_unavailable', 'integrity-failed', 'candidate-inherited-unverified']);
const unknownStatus = (status: KnowledgeQueryStatus) => UNKNOWN_STATUSES.has(status);

export type KnowledgeServiceOptions = {
  now?: () => number;
  store?: SQLiteStore;
  /** Current trusted scope, resolved per call. Model tool arguments never reach this. */
  scopeProvider?: () => unknown;
  trustedScope?: unknown;
};
/** Bounded queries over one fixed knowledge release. Rules and examples are separate namespaces. */
export class KnowledgeService {
  private readonly memoryReleases = new Map<string, KnowledgeRelease>();
  private activeId?: string;
  private readonly now: () => number;
  private readonly store?: SQLiteStore;
  private readonly scopeProvider?: () => unknown;
  private readonly fixedScope?: unknown;
  constructor(options: KnowledgeServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.store = options.store;
    this.scopeProvider = options.scopeProvider;
    this.fixedScope = options.trustedScope;
  }

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
  /** Trusted scope is resolved per call; a model-facing tool never provides it. */
  private trustedScope(): unknown {
    if (this.fixedScope !== undefined) return this.fixedScope;
    return this.scopeProvider?.();
  }

  query(input: KnowledgeQuery = {}, options: { scope?: unknown } = {}): KnowledgeQueryResult {
    const parsed = KnowledgeQuerySchema.parse(input);
    const namespace = parsed.namespace ?? 'rule';
    const suppliedScope = options.scope !== undefined ? options.scope : parsed.scope !== undefined ? parsed.scope : this.trustedScope();
    const scopeResolution = suppliedScope === undefined ? undefined : resolveKnowledgeScope(suppliedScope);
    const scopeStatus: KnowledgeQueryResult['scopeStatus'] = suppliedScope === undefined ? 'not-requested' : scopeResolution?.status === 'resolved' ? 'resolved' : 'unresolved';
    const requestedScope = scopeResolution?.status === 'resolved' ? scopeResolution.scope : undefined;
    const base = { namespace, conflicts: [] as KnowledgeConflict[], sourceVersions: {} as Record<string, string>, limits: { maxItems: MAX_KNOWLEDGE_ITEMS, maxCursor: MAX_KNOWLEDGE_CURSOR }, scopeStatus };
    const release = this.resolve(parsed.releaseId);
    if (!release) return finish({ ...base, status: 'source_unavailable', items: [], truncated: false, unknown: true, reason: 'release-missing' });
    if (release.integrity === 'failed') return finish({ ...base, status: 'integrity-failed', items: [], truncated: false, unknown: true, reason: 'release-integrity-failed', releaseId: release.releaseId, releaseVersion: release.version });
    const limit = Math.min(parsed.limit ?? MAX_KNOWLEDGE_ITEMS, MAX_KNOWLEDGE_ITEMS);
    const start = parsed.cursor === undefined ? 0 : Number(parsed.cursor);
    if (!Number.isInteger(start) || start < 0) fail('invalid-knowledge-cursor', String(parsed.cursor));
    if (start > MAX_KNOWLEDGE_CURSOR) fail('knowledge-cursor-limit', String(start));
    const filtered = release.rules
      .filter(rule => rule.namespace === namespace)
      .filter(rule => !parsed.predicate || rule.predicate === parsed.predicate)
      .filter(rule => !parsed.subject || rule.subject === parsed.subject)
      // Strict: legacy facts without scopeKind match nothing. Global only matches explicit global.
      .filter(rule => knowledgeFactMatchesScope(rule, requestedScope))
      .sort((a, b) => `${a.predicate} ${a.subject ?? ''} ${a.id}`.localeCompare(`${b.predicate} ${b.subject ?? ''} ${b.id}`));
    const conflicts = detectKnowledgeConflicts(filtered);
    const conflictKeys = new Set(conflicts.map(conflict => `${conflict.predicate} ${conflict.subject ?? ''}`));
    const items: KnowledgeRuleHit[] = filtered.slice(start, start + limit).map(rule => ({ ...rule, ...(conflictKeys.has(keyOf(rule)) ? { conflict: true } : {}) }));
    const coverage = coverageIndex(release);
    const coverageEntry = parsed.predicate ? coverage.get(parsed.predicate) : undefined;
    const coverageStateResult = parsed.predicate ? coverageState(coverageEntry, parsed.subject) : undefined;
    const sourceMap = new Map(release.manifest.sources.map(source => [source.sourceId, source]));
    const integrityFailed = release.manifest.sources.some(source => source.integrity === 'failed' && filtered.some(rule => rule.sourceId === source.sourceId));
    let status: KnowledgeQueryStatus;
    let reason: string | undefined;
    if (integrityFailed) { status = 'integrity-failed'; reason = 'source-integrity-failed'; }
    else if (items.length > 0) {
      const matchedSources = [...new Set(filtered.map(rule => sourceMap.get(rule.sourceId)).filter((source): source is KnowledgeSource => Boolean(source)))];
      status = matchedSources.length > 0 && matchedSources.every(candidateSource) ? 'candidate-inherited-unverified' : 'found';
      if (status === 'candidate-inherited-unverified') reason = 'candidate-inherited-unverified';
    } else if (suppliedScope !== undefined && scopeStatus === 'unresolved') {
      status = 'unknown_due_to_incomplete_coverage'; reason = 'scope-unresolved';
    } else if (scopeStatus === 'not-requested' && release.rules.some(rule =>
      rule.namespace === namespace && rule.scopeKind === 'server'
      && (!parsed.predicate || rule.predicate === parsed.predicate)
      && (!parsed.subject || rule.subject === parsed.subject))) {
      // Server-scoped facts cannot be disproved without a trusted full scope.
      status = 'unknown_due_to_incomplete_coverage'; reason = 'scope-required';
    } else if (!parsed.predicate) {
      status = 'unknown_due_to_incomplete_coverage'; reason = 'coverage-unknown';
    } else if (!coverageEntry) {
      status = 'source_unavailable'; reason = 'missing-source';
    } else if (coverageStateResult?.verifiedNegative) {
      status = 'not_found_in_verified_dataset';
    } else {
      status = 'unknown_due_to_incomplete_coverage';
      reason = coverageStateResult?.completeness === 'partial' ? 'coverage-partial' : 'coverage-unknown';
    }
    return finish({
      ...base,
      releaseId: release.releaseId, releaseVersion: release.version,
      status, items,
      ...(start + limit < filtered.length ? { nextCursor: String(start + limit) } : {}),
      truncated: start + limit < filtered.length,
      unknown: unknownStatus(status), ...(reason ? { reason } : {}),
      ...(coverageStateResult ? { coverage: { ...(parsed.predicate ? { predicate: parsed.predicate } : {}), completeness: coverageStateResult.completeness, ...(coverageStateResult.subjectCovered === undefined ? {} : { subjectCovered: coverageStateResult.subjectCovered }) } } : {}),
      conflicts,
      sourceVersions: Object.fromEntries(release.manifest.sources.map(source => [source.sourceId, source.version])),
    });
  }

  sources(releaseId?: string): KnowledgeSourcesResult {
    const release = this.resolve(releaseId);
    if (!release) return { unknown: true, reason: 'release-missing', sources: [] };
    return { releaseId: release.releaseId, releaseVersion: release.version, unknown: false, sources: structuredClone(release.manifest.sources) };
  }

  coverage(releaseId?: string): KnowledgeCoverage {
    const release = this.resolve(releaseId);
    if (!release) return { unknown: true, reason: 'release-missing', sourceVersions: {}, sources: { verified: 0, unverified: 0, total: 0 }, namespaces: { rule: 0, example: 0 }, predicates: {}, entries: [], conflicts: 0, scope: 'declared-sources-only' };
    const predicates: KnowledgeCoverage['predicates'] = {};
    const index = coverageIndex(release);
    for (const [predicate, entry] of index) {
      const state = coverageState(entry, undefined);
      predicates[predicate] = { sources: [...entry.sources].sort(), verifiedRules: 0, examples: 0, completeness: state.completeness };
    }
    for (const rule of release.rules) {
      const entry = predicates[rule.predicate] ?? { sources: [], verifiedRules: 0, examples: 0, completeness: 'unknown' as const };
      if (rule.namespace === 'rule') entry.verifiedRules++; else entry.examples++;
      predicates[rule.predicate] = entry;
    }
    const entries: KnowledgeCoverage['entries'] = [];
    for (const source of release.manifest.sources) {
      for (const entry of source.coverage ?? []) entries.push({ predicate: entry.predicate, ...(entry.subjects ? { subjects: [...entry.subjects] } : {}), completeness: entry.completeness, sources: [source.sourceId] });
      for (const predicate of source.covers) if (!source.coverage?.some(item => item.predicate === predicate)) entries.push({ predicate, completeness: 'unknown', sources: [source.sourceId] });
    }
    entries.sort((a, b) => a.predicate.localeCompare(b.predicate));
    return {
      releaseId: release.releaseId, releaseVersion: release.version, unknown: false,
      sourceVersions: Object.fromEntries(release.manifest.sources.map(source => [source.sourceId, source.version])),
      sources: { verified: release.manifest.sources.filter(source => source.verified).length, unverified: release.manifest.sources.filter(source => !source.verified).length, total: release.manifest.sources.length },
      namespaces: { rule: release.rules.filter(rule => rule.namespace === 'rule').length, example: release.rules.filter(rule => rule.namespace === 'example').length },
      predicates,
      entries,
      conflicts: detectKnowledgeConflicts(release.rules).length,
      scope: 'declared-sources-only',
    };
  }

  /** Small tool surface for the agent router: facts, sources and coverage. */
  invoke(tool: 'query_knowledge' | 'query_knowledge_facts' | 'query_knowledge_sources' | 'query_knowledge_coverage', args: unknown): { ok: boolean; result?: unknown; error?: string } {
    try {
      // The model-facing schema has no scope field; the service injects the trusted scope.
      if (tool === 'query_knowledge' || tool === 'query_knowledge_facts') return { ok: true, result: this.query(KnowledgeToolQuerySchema.parse(args ?? {})) };
      if (tool === 'query_knowledge_sources') return { ok: true, result: this.sources(KnowledgeSourcesQuerySchema.parse(args ?? {}).releaseId) };
      if (tool === 'query_knowledge_coverage') return { ok: true, result: this.coverage(KnowledgeCoverageQuerySchema.parse(args ?? {}).releaseId) };
      return { ok: false, error: 'unknown-knowledge-tool' };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}

function finish(result: Omit<KnowledgeQueryResult, 'unknown'> & { unknown?: boolean }): KnowledgeQueryResult {
  return { ...result, unknown: result.unknown ?? unknownStatus(result.status) };
}

export const knowledgeToolDefinitions = [
  { name: 'query_knowledge_facts', description: 'Query verified rules or unverified examples from one fixed knowledge release in the trusted current scope', parameters: { type: 'object', properties: { releaseId: { type: 'string' }, namespace: { type: 'string', enum: ['rule', 'example'] }, predicate: { type: 'string' }, subject: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 }, cursor: { type: 'string' } }, additionalProperties: false } },
  { name: 'query_knowledge_sources', description: 'List source ids, actual source versions and verification status for a release', parameters: { type: 'object', properties: { releaseId: { type: 'string' } }, additionalProperties: false } },
  { name: 'query_knowledge_coverage', description: 'Show declared predicate coverage and boundaries for a release', parameters: { type: 'object', properties: { releaseId: { type: 'string' } }, additionalProperties: false } },
] as const;
