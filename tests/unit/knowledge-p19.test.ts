import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteStore } from '../../src/persistence/store.js';
import {
  KnowledgeService, detectKnowledgeConflicts, knowledgeToolDefinitions, validateKnowledgeRelease,
  type KnowledgeRelease, type KnowledgeFact, type KnowledgeSource,
} from '../../src/autonomous/knowledge.js';

const tempDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'furevercraft-knowledge-')), 'state.sqlite');
const source = (sourceId: string, version: string, verified: boolean, covers: string[], kind: KnowledgeSource['kind'] = verified ? 'verified-rules' : 'examples'): KnowledgeSource =>
  ({ sourceId, version, verified, covers, kind, origin: `fixture://${sourceId}`, registeredAt: '2026-01-01T00:00:00.000Z' });
const rule = (id: string, predicate: string, value: unknown, sourceId: string, sourceVersion: string, namespace: KnowledgeFact['namespace'] = 'rule', subject?: string): KnowledgeFact =>
  ({ id, namespace, predicate, ...(subject ? { subject } : {}), value, sourceId, sourceVersion });

function releaseOne(): KnowledgeRelease {
  return {
    releaseId: 'release-1', version: '1.0.0', createdAt: '2026-01-02T00:00:00.000Z',
    manifest: {
      manifestVersion: 'manifest-1', createdAt: '2026-01-02T00:00:00.000Z',
      sources: [
        source('wiki-fixture', 'fixture-1', true, ['block.hardness', 'craft.recipe.torch']),
        source('secondary-fixture', 'fixture-2', true, ['craft.recipe.torch']),
        source('research-notes', 'notes-1', false, ['craft.recipe.torch']),
      ],
    },
    rules: [
      rule('hardness-stone', 'block.hardness', 1.5, 'wiki-fixture', 'fixture-1', 'rule', 'stone'),
      rule('torch-a', 'craft.recipe.torch', { output: 4, input: ['coal', 'stick'] }, 'wiki-fixture', 'fixture-1', 'rule', 'torch'),
      rule('torch-b', 'craft.recipe.torch', { output: 1, input: ['coal', 'stick'] }, 'secondary-fixture', 'fixture-2', 'rule', 'torch'),
      rule('torch-example', 'craft.recipe.torch', { note: 'unverified example', output: 8 }, 'research-notes', 'notes-1', 'example', 'torch'),
    ],
  };
}

function releaseTwo(): KnowledgeRelease {
  return {
    releaseId: 'release-2', version: '2.0.0', createdAt: '2026-02-01T00:00:00.000Z',
    manifest: { manifestVersion: 'manifest-2', createdAt: '2026-02-01T00:00:00.000Z', sources: [source('wiki-fixture', 'fixture-2', true, ['block.hardness'])] },
    rules: [rule('hardness-stone-v2', 'block.hardness', 2, 'wiki-fixture', 'fixture-2', 'rule', 'stone')],
  };
}

describe('P19 knowledge releases', () => {
  it('publishes a versioned release and keeps verified rules separate from examples', () => {
    const knowledge = new KnowledgeService();
    knowledge.publish(releaseOne());
    const rules = knowledge.query({});
    expect(rules.releaseId).toBe('release-1');
    expect(rules.unknown).toBe(false);
    expect(rules.items.every(item => item.namespace === 'rule')).toBe(true);
    expect(rules.items.map(item => item.id)).toEqual(['torch-a', 'torch-b', 'hardness-stone'].sort((a, b) => a.localeCompare(b)));
    const examples = knowledge.query({ namespace: 'example' });
    expect(examples.items).toHaveLength(1);
    expect(examples.items[0]).toMatchObject({ id: 'torch-example', namespace: 'example' });
    // The unverified example can never appear in the rule namespace.
    expect(knowledge.query({ namespace: 'rule' }).items.some(item => item.id === 'torch-example')).toBe(false);
  });

  it('rejects source-version mismatch, namespace promotion and duplicate ids before publishing', () => {
    const badVersion = releaseOne();
    badVersion.rules[0]!.sourceVersion = 'stale-version';
    expect(() => validateKnowledgeRelease(badVersion)).toThrow('knowledge-source-version-mismatch');
    const promoted = releaseOne();
    promoted.rules.push(rule('promoted', 'block.hardness', 9, 'research-notes', 'notes-1', 'rule', 'stone'));
    expect(() => validateKnowledgeRelease(promoted)).toThrow('knowledge-unverified-source-namespace');
    const demoted = releaseOne();
    demoted.rules.push(rule('demoted', 'block.hardness', 9, 'wiki-fixture', 'fixture-1', 'example', 'stone'));
    expect(() => validateKnowledgeRelease(demoted)).toThrow('knowledge-verified-source-namespace');
    const duplicate = releaseOne();
    duplicate.rules.push(rule('hardness-stone', 'block.hardness', 3, 'wiki-fixture', 'fixture-1', 'rule', 'dirt'));
    expect(() => validateKnowledgeRelease(duplicate)).toThrow('knowledge-duplicate-rule');
    const missingSource = releaseOne();
    missingSource.rules.push(rule('orphan', 'block.hardness', 3, 'missing-source', '1', 'rule'));
    expect(() => validateKnowledgeRelease(missingSource)).toThrow('knowledge-source-missing');
  });

  it('queries a fixed release across an atomic active switch', () => {
    const knowledge = new KnowledgeService();
    knowledge.publish(releaseOne());
    knowledge.publish(releaseTwo(), false);
    expect(knowledge.activeReleaseId()).toBe('release-1');
    expect(knowledge.query({}).items[0]).toMatchObject({ id: 'hardness-stone', value: 1.5 });
    // A fixed release stays fixed even while another release is active.
    expect(knowledge.query({ releaseId: 'release-2' }).items).toMatchObject([{ id: 'hardness-stone-v2', value: 2, sourceVersion: 'fixture-2' }]);
    knowledge.activate('release-2');
    expect(knowledge.activeReleaseId()).toBe('release-2');
    expect(knowledge.query({}).items).toMatchObject([{ id: 'hardness-stone-v2', value: 2 }]);
    expect(knowledge.query({ releaseId: 'release-1' }).items.map(item => item.id)).toContain('hardness-stone');
    expect(() => knowledge.activate('missing-release')).toThrow('knowledge-release-missing');
    expect(knowledge.activeReleaseId()).toBe('release-2');
  });

  it('shows conflicts and marks only declared coverage, with missing sources reported unknown', () => {
    const knowledge = new KnowledgeService();
    knowledge.publish(releaseOne());
    const page = knowledge.query({ predicate: 'craft.recipe.torch' });
    expect(page.conflicts).toHaveLength(1);
    expect(page.conflicts[0]!.sourceIds).toEqual(['secondary-fixture', 'wiki-fixture']);
    expect(page.conflicts[0]!.values).toHaveLength(2);
    expect(page.items.every(item => item.conflict)).toBe(true);
    expect(knowledge.query({ predicate: 'unmapped.predicate' })).toMatchObject({ unknown: true, reason: 'missing-source', items: [] });
    const coverage = knowledge.coverage();
    expect(coverage).toMatchObject({ unknown: false, scope: 'declared-sources-only', sources: { verified: 2, unverified: 1, total: 3 }, namespaces: { rule: 3, example: 1 }, conflicts: 1 });
    expect(coverage.sourceVersions).toEqual({ 'wiki-fixture': 'fixture-1', 'secondary-fixture': 'fixture-2', 'research-notes': 'notes-1' });
    expect(coverage.predicates['craft.recipe.torch']).toMatchObject({ verifiedRules: 2, examples: 1 });
    expect(knowledge.sources()).toMatchObject({ unknown: false, releaseId: 'release-1' });
    expect(knowledge.sources().sources.find(item => item.sourceId === 'wiki-fixture')).toMatchObject({ version: 'fixture-1', verified: true });
  });

  it('bounds results and cursors instead of dumping the release', () => {
    const release = releaseOne();
    release.manifest.sources = [source('bulk', 'fixture-3', true, ['bulk.rule'])];
    release.rules = Array.from({ length: 25 }, (_, index) => rule(`bulk-${String(index).padStart(2, '0')}`, 'bulk.rule', { index }, 'bulk', 'fixture-3', 'rule', 'subject'));
    const knowledge = new KnowledgeService();
    knowledge.publish(release);
    const first = knowledge.query({ predicate: 'bulk.rule', limit: 100 });
    expect(first.items).toHaveLength(20);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe('20');
    const second = knowledge.query({ predicate: 'bulk.rule', cursor: first.nextCursor });
    expect(second.items).toHaveLength(5);
    expect(second.truncated).toBe(false);
    expect(() => knowledge.query({ cursor: '20000' })).toThrow('knowledge-cursor-limit');
    expect(() => knowledge.query({ cursor: 'not-a-number' })).toThrow('invalid-knowledge-cursor');
    expect(first.limits.maxItems).toBe(20);
  });

  it('survives a store restart with the same active release', () => {
    const file = tempDb();
    const first = new SQLiteStore(file);
    new KnowledgeService({ store: first }).publish(releaseOne());
    first.close();
    const second = new SQLiteStore(file);
    const knowledge = new KnowledgeService({ store: second });
    expect(knowledge.activeReleaseId()).toBe('release-1');
    expect(knowledge.query({ predicate: 'block.hardness' }).items).toMatchObject([{ id: 'hardness-stone', sourceVersion: 'fixture-1' }]);
    expect(knowledge.coverage().sourceVersions['wiki-fixture']).toBe('fixture-1');
    second.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('rolls back a conflicting release publish without changing the active release', () => {
    const store = new SQLiteStore(':memory:');
    const knowledge = new KnowledgeService({ store });
    knowledge.publish(releaseOne());
    const conflicting = releaseOne();
    conflicting.rules[0]!.value = 99;
    expect(() => knowledge.publish(conflicting)).toThrow('knowledge-release-conflict');
    expect(knowledge.activeReleaseId()).toBe('release-1');
    expect(knowledge.query({ predicate: 'block.hardness' }).items[0]).toMatchObject({ value: 1.5 });
    expect(() => validateKnowledgeRelease({ ...releaseOne(), rules: [{ ...releaseOne().rules[0]!, sourceVersion: 'nope' }] })).toThrow('knowledge-source-version-mismatch');
    store.close();
  });

  it('exposes minimal facts/sources/coverage tools with bounded argument validation', () => {
    const knowledge = new KnowledgeService();
    knowledge.publish(releaseOne());
    expect(knowledgeToolDefinitions.map(tool => tool.name)).toEqual(['query_knowledge_facts', 'query_knowledge_sources', 'query_knowledge_coverage']);
    expect(knowledge.invoke('query_knowledge_facts', { predicate: 'block.hardness', limit: 1 })).toMatchObject({ ok: true, result: { items: [{ id: 'hardness-stone' }] } });
    expect(knowledge.invoke('query_knowledge_facts', { limit: 999 })).toMatchObject({ ok: false });
    expect(knowledge.invoke('query_knowledge_sources', {})).toMatchObject({ ok: true });
    expect(knowledge.invoke('query_knowledge_coverage', {})).toMatchObject({ ok: true, result: { scope: 'declared-sources-only' } });
    expect(knowledge.invoke('nope' as never, {})).toEqual({ ok: false, error: 'unknown-knowledge-tool' });
  });

  it('detects conflicts only for distinct values of the same predicate/subject', () => {
    const rules = [rule('a', 'p', 1, 's1', '1', 'rule', 'x'), rule('b', 'p', 1, 's2', '1', 'rule', 'x'), rule('c', 'p', 2, 's3', '1', 'rule', 'x')];
    expect(detectKnowledgeConflicts(rules)).toMatchObject([{ predicate: 'p', subject: 'x', sourceIds: ['s1', 's2', 's3'], values: [1, 2] }]);
  });
});
