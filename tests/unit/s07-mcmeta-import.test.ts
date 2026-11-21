import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KnowledgeService } from '../../src/autonomous/knowledge.js';
import {
  importMcmetaDirectory, knowledgeReleaseFromImport, parseResearchManifest,
  type McmetaFileEntry,
} from '../../src/autonomous/mcmeta-import.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const commit = 'a'.repeat(40);
const target = { edition: 'java', version: '26.3', protocol: 777, data_version: 5023, data_pack: '121.0' };

function fixture(files: Record<string, unknown>): { root: string; manifest: unknown; recheck: unknown; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'furecraft-mcmeta-'));
  const samples: McmetaFileEntry[] = [];
  for (const [path, value] of Object.entries(files)) {
    const body = JSON.stringify(value);
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
    const branchKind = path.startsWith('item_components/') ? 'summary' : path.startsWith('item/') ? 'registries' : 'data';
    (samples as unknown as Array<Record<string, unknown>>).push({
      path, sha256: sha256(body), source: 'misode/mcmeta', source_version: '26.3', commit,
      branch_kind: branchKind, immutable_url: `https://example.invalid/${commit}/${path}`,
    });
  }
  const manifest = { schema_version: 'test', target, samples };
  const recheck = { results: (samples as unknown as Array<Record<string, unknown>>).map(sample => ({ ...sample, expected: sample.sha256, actual: sample.sha256, match: true })) };
  return { root, manifest, recheck, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const baseFiles = {
  'version.json': { id: '26.3', type: 'release', data_version: 5023, protocol_version: 777 },
  'data/minecraft/recipe/straw_bed.json': {
    type: 'minecraft:crafting_shaped', key: { X: 'minecraft:hay_block' }, pattern: ['XXX'], result: { count: 4, id: 'minecraft:straw_bed' },
  },
  'data/minecraft/recipe/baked_potato.json': {
    type: 'minecraft:smelting', category: 'food', cookingtime: 200, experience: 0.35, ingredient: 'minecraft:potato', result: { id: 'minecraft:baked_potato' },
  },
  'data/minecraft/tags/item/logs.json': { values: ['#minecraft:poplar_logs'] },
  'data/minecraft/tags/item/poplar_logs.json': { values: ['minecraft:poplar_log', 'minecraft:poplar_wood'] },
  'data/minecraft/tags/item/mushrooms.json': { values: ['minecraft:brown_mushroom', { id: 'minecraft:shelf_mushroom', required: true }] },
  'data/minecraft/loot_table/blocks/oak_leaves.json': {
    type: 'minecraft:block',
    pools: [{ entries: [{ type: 'minecraft:item', conditions: [{ condition: 'minecraft:any_of', terms: ['minecraft:tool/can_shear'] }], name: 'minecraft:oak_leaves' }] }],
  },
  'data/minecraft/predicate/tool/can_shear.json': { type: 'minecraft:match_tool', predicate: { items: 'minecraft:shears' } },
  'item_components/data.json': { baked_potato: { 'minecraft:food': { nutrition: 5, saturation: 6 }, 'minecraft:max_stack_size': 64 }, straw_bed: { 'minecraft:max_stack_size': 16 } },
  'item/data.json': ['baked_potato', 'straw_bed', 'poplar_log'],
};

describe('S07 mcmeta importer', () => {
  it('verifies every SHA-256 before parsing and emits global facts with coverage', () => {
    const { root, manifest, recheck, cleanup } = fixture(baseFiles);
    try {
      const result = importMcmetaDirectory({ rootDir: root, manifest, recheck, nowUtc: '2026-04-01T00:00:00.000Z' });
      expect(result.status).toBe('imported');
      expect(result.documentation).toMatchObject({ externalSampleImport: 'not-run' });
      expect(result.integrity).toMatchObject({ filesDiscovered: 10, filesChecked: 10, filesMissing: 0, filesMismatched: 0, tagCycles: 0 });
      expect(result.facts.every(fact => fact.scopeKind === 'global' && fact.namespace === 'rule')).toBe(true);
      expect(result.facts.every(fact => fact.provenance?.commit === commit && fact.provenance?.sourceVersion === '26.3')).toBe(true);
      const recipe = result.facts.find(fact => fact.predicate === 'recipe' && fact.subject === 'minecraft:straw_bed');
      expect(recipe?.value).toMatchObject({ type: 'minecraft:crafting_shaped', pattern: ['XXX'], result: { id: 'minecraft:straw_bed', count: 4 } });
      const smelting = result.facts.find(fact => fact.subject === 'minecraft:baked_potato' && fact.predicate === 'recipe');
      expect(smelting?.value).toMatchObject({ type: 'minecraft:smelting', cookingtime: 200, experience: 0.35 });
      expect(result.facts.filter(fact => fact.predicate === 'tag.item').map(fact => fact.subject).sort()).toEqual(['minecraft:logs', 'minecraft:mushrooms', 'minecraft:poplar_logs']);
      expect(result.facts.find(fact => fact.predicate === 'item.components' && fact.subject === 'minecraft:baked_potato')?.value).toMatchObject({ 'minecraft:food': { nutrition: 5 } });
      expect(result.facts.some(fact => fact.predicate === 'item.registry' && fact.subject === 'minecraft:poplar_log')).toBe(true);
      expect(result.coverage).toMatchObject({
        coverageStatus: 'imported',
        discovered: { recipeFiles: 2, tagFiles: 3, lootTableFiles: 1, predicateFiles: 1, itemRegistryItems: 3, itemComponentItems: 2 },
        imported: { recipes: 2, tags: 3, lootTables: 1, predicates: 1, items: 3, components: 2 },
        integrity: { missingRequiredReferences: 0, missingPredicateReferences: 0 },
      });
      expect(result.sources.every(source => source.integrity === 'verified' && source.evidence === 'file-verified')).toBe(true);
      const release = knowledgeReleaseFromImport(result, { releaseId: 'release-import-1' });
      const knowledge = new KnowledgeService();
      knowledge.publish(release);
      expect(knowledge.query({ predicate: 'recipe', subject: 'minecraft:straw_bed' })).toMatchObject({ status: 'found', items: [{ scopeKind: 'global' }] });
      expect(knowledge.query({ predicate: 'recipe' }).status).toBe('found');
    } finally { cleanup(); }
  });

  it('fails closed on a changed byte and on a missing file without emitting facts', () => {
    const changed = fixture(baseFiles);
    try {
      writeFileSync(join(changed.root, 'data/minecraft/recipe/straw_bed.json'), '{"tampered":true}');
      const result = importMcmetaDirectory({ rootDir: changed.root, manifest: changed.manifest });
      expect(result.status).toBe('failed');
      expect(result.facts).toEqual([]);
      expect(result.integrity).toMatchObject({ filesMismatched: 1 });
      expect(result.coverage.imported.recipes).toBeNull();
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'file-sha256-mismatch', path: 'data/minecraft/recipe/straw_bed.json' }));
    } finally { changed.cleanup(); }
    const missing = fixture(baseFiles);
    try {
      unlinkSync(join(missing.root, 'data/minecraft/predicate/tool/can_shear.json'));
      const result = importMcmetaDirectory({ rootDir: missing.root, manifest: missing.manifest });
      expect(result.status).toBe('failed');
      expect(result.facts).toEqual([]);
      expect(result.integrity.filesMissing).toBe(1);
      expect(result.coverage.imported.components).toBeNull();
    } finally { missing.cleanup(); }
  });

  it('detects tag cycles and missing required references', () => {
    const cyclic = fixture({
      ...baseFiles,
      'data/minecraft/tags/item/a.json': { values: ['#minecraft:b'] },
      'data/minecraft/tags/item/b.json': { values: ['#minecraft:a'] },
    });
    try {
      const result = importMcmetaDirectory({ rootDir: cyclic.root, manifest: cyclic.manifest });
      expect(result.status).toBe('failed');
      expect(result.error).toBe('tag-cycle');
      expect(result.integrity.tagCycles).toBeGreaterThan(0);
      expect(result.diagnostics.some(item => item.code === 'TAG_CYCLE')).toBe(true);
      expect(result.facts).toEqual([]);
    } finally { cyclic.cleanup(); }
    const missingRef = fixture({
      ...baseFiles,
      'data/minecraft/tags/item/broken.json': { values: ['#minecraft:not_imported'] },
    });
    try {
      const result = importMcmetaDirectory({ rootDir: missingRef.root, manifest: missingRef.manifest });
      expect(result.status).toBe('imported');
      expect(result.integrity.missingRequiredReferences).toBe(1);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_REQUIRED_REFERENCE' }));
      // Coverage explicitly records the unresolved closure; it is not claimed complete.
      expect(result.coverage.unknown).toContain('tag-reference-closure');
      expect(result.coverage.coverageStatus).toBe('imported');
    } finally { missingRef.cleanup(); }
  });

  it('fails closed when the recheck digest disagrees with the manifest', () => {
    const { root, manifest, cleanup } = fixture(baseFiles);
    try {
      const recheck = { results: [{ path: 'version.json', expected: sha256('expected'), actual: sha256('actual'), match: false }] };
      const result = importMcmetaDirectory({ rootDir: root, manifest, recheck });
      expect(result.status).toBe('failed');
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'recheck-mismatch' }));
      expect(result.coverage.imported.tags).toBeNull();
    } finally { cleanup(); }
  });

  it('documents the committed 18-sample manifest as not-run when raw samples are absent', () => {
    const manifest = JSON.parse(readFileSync('docs/research/26.3-evidence-manifest.json', 'utf8'));
    const recheck = JSON.parse(readFileSync('docs/research/26.3-evidence-recheck-2026-10-24.json', 'utf8'));
    const parsed = parseResearchManifest(manifest, recheck);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.info.entries).toHaveLength(18);
    expect(parsed.info.target).toMatchObject({ edition: 'java', version: '26.3', protocol: 777, dataVersion: 5023 });
    const empty = mkdtempSync(join(tmpdir(), 'furecraft-mcmeta-empty-'));
    try {
      const result = importMcmetaDirectory({ rootDir: empty, manifest, recheck });
      expect(result.status).toBe('failed');
      expect(result.integrity).toMatchObject({ filesDiscovered: 18, filesChecked: 0, filesMissing: 18 });
      expect(result.coverage.discovered).toMatchObject({ recipeFiles: 2042, tagFiles: 883, lootTableFiles: 1447, itemRegistryItems: 1658, itemComponentItems: 1658 });
      // Unknown import counts are null, never zero.
      expect(Object.values(result.coverage.imported).every(count => count === null)).toBe(true);
      expect(result.documentation.externalSampleImport).toBe('not-run');
      expect(result.facts).toEqual([]);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});
