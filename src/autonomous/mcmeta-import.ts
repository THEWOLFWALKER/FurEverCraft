import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  KnowledgeCoverageEntry, KnowledgeFact, KnowledgeRelease, KnowledgeSource,
} from './knowledge.js';
import { validateKnowledgeRelease } from './knowledge.js';

/**
 * mcmeta importer (S07 data groundwork).
 *
 * Input is a local directory plus the committed research manifest (or its recheck file). Every
 * file is SHA-256 verified *before* any JSON is parsed. Missing/mismatched files, parse failures
 * and tag cycles fail closed: no release/facts are emitted. Raw upstream samples are not vendored
 * in this repository, so the real 18-sample import is deliberately reported as `not-run`.
 */

export type McmetaTarget = {
  edition: string;
  version: string;
  protocol: number | null;
  dataVersion: number | null;
  dataPack: string | null;
  resourcePack: string | null;
};
export type McmetaFileEntry = {
  path: string;
  sha256: string;
  source: string;
  sourceVersion: string;
  commit: string;
  branchKind: string;
  immutableUrl?: string;
  bytes?: number;
  inherited?: boolean;
  verification?: string;
};
export type ResearchManifestInfo = {
  target: McmetaTarget;
  entries: McmetaFileEntry[];
  observations?: Record<string, unknown>;
  candidate?: Record<string, unknown>;
};
export type McmetaDiagnostic = { code: string; path?: string; detail?: unknown };
export type McmetaCoverage = {
  target: McmetaTarget;
  sourceCommit?: string;
  discovered: {
    recipeFiles: number | null;
    tagFiles: number | null;
    lootTableFiles: number | null;
    predicateFiles: number | null;
    itemRegistryItems: number | null;
    itemComponentItems: number | null;
    otherFiles: number | null;
  };
  imported: {
    recipes: number | null;
    tags: number | null;
    lootTables: number | null;
    predicates: number | null;
    items: number | null;
    components: number | null;
  };
  integrity: {
    filesDiscovered: number;
    filesChecked: number;
    filesMissing: number;
    filesMismatched: number;
    parseFailures: number;
    tagCycles: number;
    missingRequiredReferences: number;
    unsupportedRecipeTypes: number;
    missingPredicateReferences: number;
  };
  coverageStatus: 'imported' | 'failed' | 'not-run';
  /** Names of categories whose state is unknown. Unknown is represented as `null`, never zero. */
  unknown: string[];
};
export type McmetaImportResult = {
  status: 'imported' | 'failed';
  error?: string;
  target: McmetaTarget;
  sourceCommit?: string;
  facts: KnowledgeFact[];
  sources: KnowledgeSource[];
  diagnostics: McmetaDiagnostic[];
  integrity: McmetaCoverage['integrity'];
  coverage: McmetaCoverage;
  documentation: { externalSampleImport: 'not-run'; reason: string };
};

const UNKNOWN_TARGET: McmetaTarget = { edition: 'java', version: 'unknown', protocol: null, dataVersion: null, dataPack: null, resourcePack: null };
const nowIso = () => new Date().toISOString();

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

function normalizeTarget(raw: unknown): McmetaTarget {
  if (!raw || typeof raw !== 'object') return UNKNOWN_TARGET;
  const value = raw as Record<string, unknown>;
  const numberOrNull = (input: unknown) => typeof input === 'number' && Number.isFinite(input) ? input : null;
  return {
    edition: String(value.edition ?? 'java').toLowerCase() === 'java' ? 'java' : String(value.edition ?? 'unknown'),
    version: String(value.version ?? 'unknown'),
    protocol: numberOrNull(value.protocol ?? value.protocol_version),
    dataVersion: numberOrNull(value.data_version ?? value.dataVersion),
    dataPack: value.data_pack !== undefined ? String(value.data_pack) : value.data_pack_version !== undefined ? String(value.data_pack_version) : null,
    resourcePack: value.resource_pack !== undefined ? String(value.resource_pack) : value.resource_pack_version !== undefined ? String(value.resource_pack_version) : null,
  };
}

/** Accept the committed evidence manifest and/or the recheck JSON. */
export function parseResearchManifest(manifest: unknown, recheck?: unknown): { ok: true; info: ResearchManifestInfo } | { ok: false; errors: McmetaDiagnostic[] } {
  const errors: McmetaDiagnostic[] = [];
  const root = manifest && typeof manifest === 'object' ? manifest as Record<string, unknown> : undefined;
  if (!root) return { ok: false, errors: [{ code: 'manifest-invalid', detail: 'manifest-not-object' }] };
  const target = normalizeTarget(root.target);
  const observations = root.mcmeta_directory_tree_observations && typeof root.mcmeta_directory_tree_observations === 'object'
    ? root.mcmeta_directory_tree_observations as Record<string, unknown>
    : undefined;
  const candidate = root.minecraft_data && typeof root.minecraft_data === 'object' ? root.minecraft_data as Record<string, unknown> : undefined;
  const entries: McmetaFileEntry[] = [];
  const samples = Array.isArray(root.samples) ? root.samples : [];
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') { errors.push({ code: 'manifest-sample-invalid' }); continue; }
    const record = sample as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path.replace(/\\/g, '/') : '';
    const sha256 = typeof record.sha256 === 'string' ? record.sha256 : '';
    if (!path) { errors.push({ code: 'manifest-sample-path-missing' }); continue; }
    if (!/^[a-f0-9]{64}$/.test(sha256)) { errors.push({ code: 'manifest-sample-sha256-invalid', path }); continue; }
    entries.push({
      path, sha256,
      source: String(record.source ?? 'misode/mcmeta'),
      sourceVersion: String(record.source_version ?? target.version),
      commit: String(record.commit ?? ''),
      branchKind: String(record.branch_kind ?? 'data'),
      ...(typeof record.immutable_url === 'string' ? { immutableUrl: record.immutable_url } : {}),
      ...(typeof record.bytes === 'number' ? { bytes: record.bytes } : {}),
      ...(record.inherited === true ? { inherited: true } : {}),
      ...(typeof record.verification === 'string' ? { verification: record.verification } : {}),
    });
  }
  // Recheck results are an independent verification record. A mismatch is fatal.
  const results = recheck && typeof recheck === 'object' && Array.isArray((recheck as Record<string, unknown>).results)
    ? (recheck as Record<string, unknown>).results as unknown[]
    : [];
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  for (const result of results) {
    if (!result || typeof result !== 'object') { errors.push({ code: 'recheck-result-invalid' }); continue; }
    const record = result as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path.replace(/\\/g, '/') : '';
    const expected = typeof record.expected === 'string' ? record.expected : undefined;
    const actual = typeof record.actual === 'string' ? record.actual : undefined;
    if (record.match === false || (expected && actual && expected !== actual)) {
      errors.push({ code: 'recheck-mismatch', path, detail: { expected, actual } });
      continue;
    }
    if (path && !byPath.has(path) && expected) {
      entries.push({
        path, sha256: expected,
        source: String(record.source ?? 'misode/mcmeta'),
        sourceVersion: String(record.source_version ?? target.version),
        commit: String(record.commit ?? ''),
        branchKind: String((record as { branch_kind?: unknown }).branch_kind ?? 'data'),
        ...(typeof record.immutable_url === 'string' ? { immutableUrl: record.immutable_url } : {}),
        ...(typeof record.bytes === 'number' ? { bytes: record.bytes } : {}),
      });
    }
  }
  if (entries.length === 0) errors.push({ code: 'manifest-empty' });
  if (errors.length) return { ok: false, errors };
  return { ok: true, info: { target, entries, ...(observations ? { observations } : {}), ...(candidate ? { candidate } : {}) } };
}

export function loadResearchManifestFiles(input: { manifestPath?: string; recheckPath?: string }): { manifest?: unknown; recheck?: unknown; errors: McmetaDiagnostic[] } {
  const errors: McmetaDiagnostic[] = [];
  const read = (path: string | undefined): unknown => {
    if (!path) return undefined;
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { errors.push({ code: 'manifest-read-failed', path, detail: error instanceof Error ? error.message : String(error) }); return undefined; }
  };
  return { manifest: read(input.manifestPath), recheck: read(input.recheckPath), errors };
}

function resolveSamplePath(rootDir: string, entry: McmetaFileEntry): string | undefined {
  const candidates = [
    join(rootDir, entry.path),
    join(rootDir, `mcmeta-${entry.branchKind}-${entry.commit}`, entry.path),
    join(rootDir, entry.branchKind, entry.path),
    join(rootDir, `26.3-${entry.branchKind}`, entry.path),
    join(rootDir, entry.path.split('/').pop()!),
  ];
  return candidates.find(candidate => existsSync(candidate));
}

type ParsedFile = { entry: McmetaFileEntry; json: unknown };
type Category = 'version' | 'pack' | 'recipe' | 'tag' | 'loot' | 'predicate' | 'components' | 'registry' | 'other';

function classify(path: string): { category: Category; namespace?: string; rest?: string; tagKind?: string; registry?: string } {
  if (path === 'version.json') return { category: 'version' };
  if (path === 'pack.mcmeta') return { category: 'pack' };
  let match = /^data\/([^/]+)\/recipe\/(.+)\.json$/.exec(path);
  if (match) return { category: 'recipe', namespace: match[1], rest: match[2] };
  match = /^data\/([^/]+)\/tags\/([^/]+)\/(.+)\.json$/.exec(path);
  if (match) return { category: 'tag', namespace: match[1], tagKind: match[2], rest: match[3] };
  match = /^data\/([^/]+)\/loot_table\/(.+)\.json$/.exec(path);
  if (match) return { category: 'loot', namespace: match[1], rest: match[2] };
  match = /^data\/([^/]+)\/predicate\/(.+)\.json$/.exec(path);
  if (match) return { category: 'predicate', namespace: match[1], rest: match[2] };
  if (/^item_components\/data\.json$/.test(path)) return { category: 'components' };
  match = /^([^/]+)\/data\.json$/.exec(path);
  if (match) return { category: 'registry', registry: match[1] };
  return { category: 'other' };
}
const normalizeId = (value: string, defaultNamespace = 'minecraft') => value.includes(':') ? value : `${defaultNamespace}:${value}`;

function normalizeIngredient(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith('#') ? { tag: normalizeId(value.slice(1)) } : { item: normalizeId(value) };
  if (Array.isArray(value)) return value.map(normalizeIngredient);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.item === 'string') return { item: normalizeId(record.item) };
    if (typeof record.tag === 'string') return { tag: normalizeId(record.tag) };
  }
  return { unsupported: value };
}

function recipeValue(json: unknown): { value: unknown; unsupported?: string } {
  if (!json || typeof json !== 'object') return { value: json, unsupported: 'recipe-not-object' };
  const record = json as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'unknown';
  const result = record.result && typeof record.result === 'object'
    ? { id: normalizeId(String((record.result as Record<string, unknown>).id ?? '')), count: Number((record.result as Record<string, unknown>).count ?? 1) }
    : undefined;
  if (type.endsWith('crafting_shaped')) {
    const pattern = Array.isArray(record.pattern) ? record.pattern.map(String) : [];
    const key = record.key && typeof record.key === 'object' ? Object.fromEntries(Object.entries(record.key as Record<string, unknown>).map(([symbol, ingredient]) => [symbol, normalizeIngredient(ingredient)])) : {};
    const width = pattern.reduce((max, row) => Math.max(max, row.length), 0);
    const emptySlots = pattern.reduce((count, row) => count + (width - row.length) + [...row].filter(char => char === ' ').length, 0);
    return { value: { type, pattern, width, height: pattern.length, emptySlots, key, result, raw: record } };
  }
  if (type.endsWith('crafting_shapeless')) {
    const ingredients = Array.isArray(record.ingredients) ? record.ingredients.map(normalizeIngredient) : [];
    return { value: { type, ingredients, ingredientCount: ingredients.length, result, raw: record } };
  }
  if (type.endsWith('smelting') || type.endsWith('blasting') || type.endsWith('smoking') || type.endsWith('campfire_cooking')) {
    return { value: { type, ingredient: normalizeIngredient(record.ingredient), cookingtime: record.cookingtime ?? null, experience: record.experience ?? null, category: record.category, result, raw: record } };
  }
  return { value: { type, unsupported: true, raw: record }, unsupported: type };
}

function tagValues(json: unknown): Array<{ id: string; required: boolean }> {
  const values = json && typeof json === 'object' && Array.isArray((json as Record<string, unknown>).values) ? (json as Record<string, unknown>).values as unknown[] : [];
  return values.flatMap(value => {
    if (typeof value === 'string') return [{ id: value, required: true }];
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.id === 'string') return [{ id: record.id, required: record.required !== false }];
    }
    return [];
  });
}

function collectStrings(value: unknown, output: Set<string>) {
  if (typeof value === 'string') { output.add(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, output); return; }
  if (value && typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, output);
}

function detectTagCycles(edges: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string) => {
    const mark = state.get(node) ?? 0;
    if (mark === 1) {
      const start = stack.indexOf(node);
      cycles.push(stack.slice(start >= 0 ? start : 0).concat(node));
      return;
    }
    if (mark === 2) return;
    state.set(node, 1); stack.push(node);
    for (const next of edges.get(node) ?? []) if (edges.has(next)) visit(next);
    stack.pop(); state.set(node, 2);
  };
  for (const node of edges.keys()) visit(node);
  return cycles;
}

export type McmetaImportOptions = {
  rootDir: string;
  manifest?: unknown;
  recheck?: unknown;
  manifestPath?: string;
  recheckPath?: string;
  nowUtc?: string;
  transformerVersion?: string;
};
type Counts = { recipe: number; tag: number; loot: number; predicate: number; registryItems: number; componentItems: number; other: number };
const emptyCounts = (): Counts => ({ recipe: 0, tag: 0, loot: 0, predicate: 0, registryItems: 0, componentItems: 0, other: 0 });

export function importMcmetaDirectory(options: McmetaImportOptions): McmetaImportResult {
  const documentation = { externalSampleImport: 'not-run' as const, reason: 'raw mcmeta samples are not vendored; import synthetic fixtures or an operator-supplied local directory' };
  const diagnostics: McmetaDiagnostic[] = [];
  let manifest = options.manifest;
  let recheck = options.recheck;
  if (options.manifestPath || options.recheckPath) {
    const loaded = loadResearchManifestFiles({ manifestPath: options.manifestPath, recheckPath: options.recheckPath });
    diagnostics.push(...loaded.errors);
    manifest = manifest ?? loaded.manifest;
    recheck = recheck ?? loaded.recheck;
  }
  const parsedManifest = parseResearchManifest(manifest, recheck);
  if (!parsedManifest.ok) {
    const integrity = emptyIntegrity(0);
    return failedResult(UNKNOWN_TARGET, undefined, [...diagnostics, ...parsedManifest.errors], integrity, emptyCounts(), undefined);
  }
  const info = parsedManifest.info;
  const counts = countCategories(info.entries);
  const nowUtc = options.nowUtc ?? nowIso();
  const transformerVersion = options.transformerVersion ?? 'furecraft-mcmeta-importer@0.3.0';
  const discovered = discoveredCoverage(info, counts);

  // 1. Verify every file *before* parsing anything.
  const resolved: Array<{ entry: McmetaFileEntry; bytes: Uint8Array }> = [];
  let missing = 0; let mismatched = 0; let checked = 0;
  for (const entry of info.entries) {
    const path = resolveSamplePath(options.rootDir, entry);
    if (!path) { missing++; diagnostics.push({ code: 'file-missing', path: entry.path }); continue; }
    let bytes: Buffer;
    try { bytes = readFileSync(path); }
    catch (error) { missing++; diagnostics.push({ code: 'file-missing', path: entry.path, detail: error instanceof Error ? error.message : String(error) }); continue; }
    checked++;
    const actual = digest(bytes);
    if (actual !== entry.sha256) { mismatched++; diagnostics.push({ code: 'file-sha256-mismatch', path: entry.path, detail: { expected: entry.sha256, actual } }); continue; }
    resolved.push({ entry, bytes });
  }
  const integrity = {
    filesDiscovered: info.entries.length, filesChecked: checked, filesMissing: missing, filesMismatched: mismatched,
    parseFailures: 0, tagCycles: 0, missingRequiredReferences: 0, unsupportedRecipeTypes: 0, missingPredicateReferences: 0,
  };
  if (missing || mismatched) return failedResult(info.target, sourceCommitOf(info), diagnostics, integrity, counts, discovered);

  // 2. Parse only after integrity passed.
  const parsedFiles: ParsedFile[] = [];
  for (const { entry, bytes } of resolved) {
    try { parsedFiles.push({ entry, json: JSON.parse(Buffer.from(bytes).toString('utf8')) }); }
    catch (error) { integrity.parseFailures++; diagnostics.push({ code: 'parse-failed', path: entry.path, detail: error instanceof Error ? error.message : String(error) }); }
  }
  if (integrity.parseFailures) return failedResult(info.target, sourceCommitOf(info), diagnostics, integrity, counts, discovered);
  refineDiscovered(discovered, parsedFiles);

  const facts: KnowledgeFact[] = [];
  const tagKeys = new Set<string>();
  const tagEdges = new Map<string, string[]>();
  const tagRequiredRefs: Array<{ from: string; to: string; entry: McmetaFileEntry }> = [];
  const predicatesImported = new Set<string>();
  const imported = { recipes: 0, tags: 0, lootTables: 0, predicates: 0, items: 0, components: 0 };
  const lootRefs: Array<{ from: string; reference: string; entry: McmetaFileEntry }> = [];
  const tagFileSet = new Set(parsedFiles.filter(file => classify(file.entry.path).category === 'tag').map(file => file.entry.path));
  // First pass: tag IDs are needed to classify nested references.
  for (const file of parsedFiles) {
    const classified = classify(file.entry.path);
    if (classified.category !== 'tag') continue;
    const key = `${classified.tagKind}:${normalizeId(`${classified.namespace}:${classified.rest}`)}`;
    tagKeys.add(key);
  }

  for (const file of parsedFiles) {
    const { entry, json } = file;
    const classified = classify(entry.path);
    const sourceId = `mcmeta:${entry.branchKind}:${entry.path}:${entry.sha256.slice(0, 8)}`;
    const baseAttributes = {
      sourcePath: entry.path, sourceCommit: entry.commit, branchKind: entry.branchKind,
      sourceVersion: entry.sourceVersion, sha256: entry.sha256, inherited: entry.inherited === true,
    };
    const provenance = {
      repository: entry.source,
      commit: entry.commit,
      path: entry.path,
      sourceVersion: entry.sourceVersion,
      ...(entry.immutableUrl ? { immutableUrl: entry.immutableUrl } : {}),
      branchKind: entry.branchKind,
      inherited: entry.inherited === true,
      importedAtUtc: nowUtc,
      transformerVersion,
    };
    const covers: string[] = [];
    const push = (predicate: string, subject: string | undefined, value: unknown) => {
      facts.push({
        id: `mcmeta:${entry.branchKind}:${entry.path}:${predicate}:${subject ?? ''}`,
        namespace: 'rule', predicate, ...(subject ? { subject } : {}), value,
        sourceId, sourceVersion: entry.sourceVersion, scopeKind: 'global',
        validFrom: nowUtc, attributes: baseAttributes, provenance,
      });
      if (!covers.includes(predicate)) covers.push(predicate);
    };
    if (classified.category === 'version') {
      push('version.identity', info.target.version, { ...info.target, raw: json });
      continue;
    }
    if (classified.category === 'pack') {
      push('pack.format', undefined, json);
      continue;
    }
    if (classified.category === 'recipe') {
      const normalized = recipeValue(json);
      if (normalized.unsupported) { integrity.unsupportedRecipeTypes++; diagnostics.push({ code: 'UNSUPPORTED_RECIPE_TYPE', path: entry.path, detail: normalized.unsupported }); }
      push('recipe', `${classified.namespace}:${classified.rest}`, normalized.value);
      imported.recipes++;
      continue;
    }
    if (classified.category === 'tag') {
      const kind = classified.tagKind!;
      const subject = `${classified.namespace}:${classified.rest}`;
      const key = `${kind}:${normalizeId(subject)}`;
      const values = tagValues(json);
      const edges: string[] = [];
      for (const value of values) {
        if (value.id.startsWith('#')) {
          const target = `${kind}:${normalizeId(value.id.slice(1))}`;
          edges.push(target);
          if (value.required && !tagKeys.has(target)) {
            integrity.missingRequiredReferences++;
            tagRequiredRefs.push({ from: key, to: target, entry });
          }
        }
      }
      tagEdges.set(key, edges);
      push(`tag.${kind}`, subject, { kind, values, raw: json });
      imported.tags++;
      continue;
    }
    if (classified.category === 'loot') {
      const strings = new Set<string>(); collectStrings(json, strings);
      for (const reference of strings) if (/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(reference) && (reference.includes('tool/') || reference.includes('predicate/'))) lootRefs.push({ from: `${classified.namespace}:${classified.rest}`, reference, entry });
      push('loot_table', `${classified.namespace}:${classified.rest}`, json);
      imported.lootTables++;
      continue;
    }
    if (classified.category === 'predicate') {
      predicatesImported.add(`${classified.namespace}:${classified.rest}`);
      push('predicate', `${classified.namespace}:${classified.rest}`, json);
      imported.predicates++;
      continue;
    }
    if (classified.category === 'components') {
      if (!json || typeof json !== 'object' || Array.isArray(json)) { diagnostics.push({ code: 'COMPONENT_PARSE_FAILED', path: entry.path }); continue; }
      for (const [item, components] of Object.entries(json as Record<string, unknown>)) {
        push('item.components', normalizeId(item), components);
        imported.components++;
      }
      continue;
    }
    if (classified.category === 'registry') {
      if (!Array.isArray(json)) { diagnostics.push({ code: 'REGISTRY_PARSE_FAILED', path: entry.path }); continue; }
      for (const item of json) {
        if (typeof item !== 'string') continue;
        const id = normalizeId(item);
        push(classified.registry === 'item' ? 'item.registry' : `${classified.registry}.registry`, id, { id });
        if (classified.registry === 'item') imported.items++;
      }
      continue;
    }
    push('source.file', entry.path, json);
  }

  // 3. Tag cycle + reference diagnostics.
  const cycles = detectTagCycles(tagEdges);
  integrity.tagCycles = cycles.length;
  for (const cycle of cycles) diagnostics.push({ code: 'TAG_CYCLE', detail: cycle });
  for (const reference of tagRequiredRefs) diagnostics.push({ code: 'MISSING_REQUIRED_REFERENCE', path: reference.entry.path, detail: { from: reference.from, to: reference.to } });
  for (const reference of lootRefs) {
    if (predicatesImported.has(reference.reference) || tagFileSet.has(`data/minecraft/predicate/${reference.reference.split(':')[1]}.json`)) continue;
    // The sample set is not a full predicate closure; record it rather than guessing.
    integrity.missingPredicateReferences++;
    diagnostics.push({ code: 'MISSING_PREDICATE', path: reference.entry.path, detail: reference.reference });
  }

  // One immutable source record per verified file. `covers` is partial: it does not claim that
  // every subject of a predicate was imported.
  const sourcesById = new Map<string, KnowledgeSource>();
  for (const file of parsedFiles) {
    const classified = classify(file.entry.path);
    const sourceId = `mcmeta:${file.entry.branchKind}:${file.entry.path}:${file.entry.sha256.slice(0, 8)}`;
    const factPredicates = [...new Set(facts.filter(fact => fact.sourceId === sourceId).map(fact => fact.predicate))];
    const coverage: KnowledgeCoverageEntry[] = factPredicates.map(predicate => ({ predicate, completeness: 'partial' }));
    const source: KnowledgeSource = {
      sourceId,
      version: file.entry.sourceVersion,
      kind: 'verified-rules',
      origin: file.entry.immutableUrl ?? `${file.entry.source}@${file.entry.commit}:${file.entry.path}`,
      verified: true,
      covers: factPredicates,
      coverage,
      sha256: file.entry.sha256,
      commit: file.entry.commit,
      path: file.entry.path,
      inherited: file.entry.inherited === true,
      evidence: file.entry.inherited === true ? 'candidate-inherited-unverified' : 'file-verified',
      integrity: 'verified',
      registeredAt: nowUtc,
    };
    sourcesById.set(sourceId, source);
    void classified;
  }
  const sources = [...sourcesById.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const sourceCommit = sourceCommitOf(info);
  const coverage: McmetaCoverage = {
    target: info.target,
    ...(sourceCommit ? { sourceCommit } : {}),
    discovered,
    imported: { ...imported, ...(integrity.tagCycles > 0 ? { tags: null } : {}) },
    integrity,
    coverageStatus: integrity.tagCycles > 0 ? 'failed' : 'imported',
    unknown: [
      ...(info.observations ? [] : ['directory-tree-observations-not-in-manifest']),
      ...(integrity.tagCycles ? ['tag-coverage'] : []),
      ...(integrity.unsupportedRecipeTypes ? ['unsupported-recipe-types'] : []),
      ...(integrity.missingRequiredReferences ? ['tag-reference-closure'] : []),
      ...(integrity.missingPredicateReferences ? ['predicate-reference-closure'] : []),
    ],
  };
  if (integrity.tagCycles > 0) {
    return {
      status: 'failed', error: 'tag-cycle', target: info.target, ...(sourceCommit ? { sourceCommit } : {}),
      facts: [], sources: [], diagnostics, integrity, coverage, documentation,
    };
  }
  return {
    status: 'imported', target: info.target, ...(sourceCommit ? { sourceCommit } : {}),
    facts, sources, diagnostics, integrity, coverage, documentation,
  };
}

function sourceCommitOf(info: ResearchManifestInfo): string | undefined {
  return info.entries.find(entry => entry.branchKind === 'data' && entry.path === 'version.json')?.commit
    ?? info.entries[0]?.commit;
}
function emptyIntegrity(discovered: number): McmetaCoverage['integrity'] {
  return { filesDiscovered: discovered, filesChecked: 0, filesMissing: 0, filesMismatched: 0, parseFailures: 0, tagCycles: 0, missingRequiredReferences: 0, unsupportedRecipeTypes: 0, missingPredicateReferences: 0 };
}
function countCategories(entries: McmetaFileEntry[]): Counts {
  const counts = emptyCounts();
  for (const entry of entries) {
    const category = classify(entry.path).category;
    if (category === 'recipe') counts.recipe++;
    else if (category === 'tag') counts.tag++;
    else if (category === 'loot') counts.loot++;
    else if (category === 'predicate') counts.predicate++;
    else if (category === 'registry') counts.registryItems++;
    else if (category === 'components') counts.componentItems++;
    else counts.other++;
  }
  return counts;
}
function discoveredCoverage(info: ResearchManifestInfo, counts: Counts): McmetaCoverage['discovered'] {
  const obs = info.observations ?? {};
  const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const observation = (key: string) => num(obs[key]);
  return {
    recipeFiles: observation('recipe_json_count') ?? counts.recipe,
    tagFiles: observation('tags_json_count') ?? counts.tag,
    lootTableFiles: observation('loot_table_json_count') ?? counts.loot,
    predicateFiles: counts.predicate,
    itemRegistryItems: observation('registry_item_count') ?? null,
    itemComponentItems: observation('default_components_item_count') ?? null,
    otherFiles: counts.other,
  };
}
/** After parsing, record-level counts (registry ids, component keys) are known exactly. */
function refineDiscovered(discovered: McmetaCoverage['discovered'], parsedFiles: ParsedFile[]) {
  if (discovered.itemRegistryItems === null) {
    for (const file of parsedFiles) {
      if (classify(file.entry.path).category !== 'registry') continue;
      if (Array.isArray(file.json)) discovered.itemRegistryItems = file.json.filter(item => typeof item === 'string').length;
    }
  }
  if (discovered.itemComponentItems === null) {
    for (const file of parsedFiles) {
      if (classify(file.entry.path).category !== 'components') continue;
      if (file.json && typeof file.json === 'object' && !Array.isArray(file.json)) discovered.itemComponentItems = Object.keys(file.json as Record<string, unknown>).length;
    }
  }
}
function failedResult(target: McmetaTarget, sourceCommit: string | undefined, diagnostics: McmetaDiagnostic[], integrity: McmetaCoverage['integrity'], counts: Counts, discovered: McmetaCoverage['discovered'] | undefined): McmetaImportResult {
  const coverage: McmetaCoverage = {
    target,
    ...(sourceCommit ? { sourceCommit } : {}),
    discovered: discovered ?? {
      recipeFiles: counts.recipe, tagFiles: counts.tag, lootTableFiles: counts.loot,
      predicateFiles: counts.predicate, itemRegistryItems: counts.registryItems || null,
      itemComponentItems: counts.componentItems || null, otherFiles: counts.other,
    },
    // Imported is unknown, not zero: nothing was successfully imported.
    imported: { recipes: null, tags: null, lootTables: null, predicates: null, items: null, components: null },
    integrity,
    coverageStatus: 'failed',
    unknown: ['imported-counts', 'recipes', 'tags', 'loot-tables', 'predicates', 'items', 'components'],
  };
  return {
    status: 'failed', error: diagnostics[0]?.code ?? 'import-failed', target, ...(sourceCommit ? { sourceCommit } : {}),
    facts: [], sources: [], diagnostics, integrity, coverage,
    documentation: { externalSampleImport: 'not-run', reason: 'raw mcmeta samples are not vendored; import synthetic fixtures or an operator-supplied local directory' },
  };
}

/**
 * Turn a successful import into an immutable knowledge release. A failed import cannot be
 * published. The release keeps per-file provenance and partial coverage.
 */
export function knowledgeReleaseFromImport(result: McmetaImportResult, options: { releaseId?: string; createdAt?: string } = {}): KnowledgeRelease {
  if (result.status !== 'imported') throw new Error('mcmeta-import-not-successful');
  const createdAt = options.createdAt ?? nowIso();
  const releaseId = options.releaseId ?? createHash('sha256').update(canonical({
    target: result.target, sourceCommit: result.sourceCommit,
    files: result.sources.map(source => `${source.path}:${source.sha256}`).sort(),
    transformer: 'furecraft-mcmeta-importer@0.3.0', schema: 'knowledge-release-v1',
  })).digest('hex');
  const release: KnowledgeRelease = {
    releaseId, version: result.target.version, createdAt,
    manifest: { manifestVersion: 'mcmeta-import-v1', createdAt, sources: result.sources },
    rules: result.facts,
    notes: 'Imported from SHA-256 verified local files. Coverage is per declared source, not a complete game knowledge claim.',
    integrity: 'verified',
  };
  validateKnowledgeRelease(release);
  return release;
}
