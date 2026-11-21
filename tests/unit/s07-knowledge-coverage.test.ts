import { describe, expect, it } from 'vitest';
import {
  KnowledgeService, validateKnowledgeRelease,
  type KnowledgeFact, type KnowledgeRelease, type KnowledgeSource,
} from '../../src/autonomous/knowledge.js';

const scope = { serverProfileId: 'server-a', accountId: 'account-a', worldGenerationId: 'world-1', dimensionId: 'overworld' };
const otherWorld = { ...scope, worldGenerationId: 'world-2' };

const source = (sourceId: string, covers: string[], extra: Partial<KnowledgeSource> = {}): KnowledgeSource => ({
  sourceId, version: '1.0.0', kind: 'verified-rules', origin: `fixture://${sourceId}`, verified: true,
  covers, registeredAt: '2026-01-01T00:00:00.000Z', ...extra,
});
const fact = (id: string, predicate: string, subject: string | undefined, value: unknown, sourceId: string, extra: Partial<KnowledgeFact> = {}): KnowledgeFact => ({
  id, namespace: 'rule', predicate, ...(subject ? { subject } : {}), value, sourceId, sourceVersion: '1.0.0', scopeKind: 'global', ...extra,
});

function scopedRelease(): KnowledgeRelease {
  return {
    releaseId: 'release-scope', version: '1.0.0', createdAt: '2026-01-01T00:00:00.000Z',
    manifest: {
      manifestVersion: 'm1', createdAt: '2026-01-01T00:00:00.000Z',
      sources: [
        source('global-source', ['block.hardness'], { coverage: [{ predicate: 'block.hardness', completeness: 'complete' }] }),
        source('server-source', ['server.chest'], { coverage: [{ predicate: 'server.chest', completeness: 'complete', subjects: ['chest-a'] }] }),
        source('partial-source', [], { coverage: [{ predicate: 'loot.table', completeness: 'partial' }] }),
        source('unknown-source', [], { coverage: [{ predicate: 'tag.item', completeness: 'unknown' }] }),
        source('candidate-source', ['legacy.recipe'], { coverage: [{ predicate: 'legacy.recipe', completeness: 'complete' }], inherited: true, evidence: 'candidate-inherited-unverified' }),
      ],
    },
    rules: [
      fact('hardness-stone', 'block.hardness', 'stone', 1.5, 'global-source'),
      fact('server-chest-a', 'server.chest', 'chest-a', { x: 1, y: 2, z: 3 }, 'server-source', { scopeKind: 'server', scope }),
      fact('server-chest-b', 'server.chest', 'chest-a', { x: 40, y: 50, z: 60 }, 'server-source', { scopeKind: 'server', scope: otherWorld }),
      fact('loot-a', 'loot.table', 'living', { drops: ['bone'] }, 'partial-source'),
      fact('legacy-unscoped', 'legacy.rule', 'stone', 99, 'global-source', { scopeKind: undefined }),
      fact('candidate-recipe', 'legacy.recipe', 'poplar_planks', { result: 4 }, 'candidate-source'),
    ],
  };
}

describe('S07 FEC-45 strict knowledge scope', () => {
  it('returns only explicit global facts without a trusted scope and never legacy/unscoped facts', () => {
    const knowledge = new KnowledgeService();
    knowledge.publish(scopedRelease());
    const global = knowledge.query({ predicate: 'block.hardness' });
    expect(global).toMatchObject({ status: 'found', scopeStatus: 'not-requested', items: [{ id: 'hardness-stone', scopeKind: 'global' }] });
    expect(global.unknown).toBe(false);
    // A legacy unscoped fact is not match-all.
    expect(knowledge.query({ predicate: 'legacy.rule' }).items).toEqual([]);
    // A server predicate requires a full trusted scope; absent scope is unknown, not a negative.
    expect(knowledge.query({ predicate: 'server.chest' })).toMatchObject({ status: 'unknown_due_to_incomplete_coverage', reason: 'scope-required', items: [] });
  });

  it('matches server facts only in the exact full scope', () => {
    const knowledge = new KnowledgeService();
    knowledge.publish(scopedRelease());
    expect(knowledge.query({ predicate: 'server.chest', scope })).toMatchObject({
      status: 'found', scopeStatus: 'resolved', items: [{ id: 'server-chest-a', value: { x: 1, y: 2, z: 3 } }],
    });
    expect(knowledge.query({ predicate: 'server.chest', scope: otherWorld })).toMatchObject({ items: [{ id: 'server-chest-b' }] });
    expect(knowledge.query({ scope: otherWorld }).items.some(item => item.id === 'server-chest-a')).toBe(false);
    // Partial identity is unresolved: server facts are excluded, global facts remain safe.
    const partial = knowledge.query({ scope: { serverProfileId: 'server-a' } });
    expect(partial.scopeStatus).toBe('unresolved');
    expect(partial.items.some(item => item.id === 'hardness-stone')).toBe(true);
    expect(partial.items.some(item => item.scopeKind === 'server')).toBe(false);
    expect(partial.status).toBe('found');
    expect(knowledge.query({ predicate: 'server.chest', scope: { serverProfileId: 'server-a' } })).toMatchObject({
      status: 'unknown_due_to_incomplete_coverage', reason: 'scope-unresolved', items: [],
    });
  });

  it('rejects invalid scope kinds at publish time and strips model-supplied scope from tools', () => {
    const missingServerScope = scopedRelease();
    missingServerScope.rules[1] = { ...missingServerScope.rules[1]!, scope: undefined };
    expect(() => validateKnowledgeRelease(missingServerScope)).toThrow('knowledge-server-scope-missing');
    const globalWithScope = scopedRelease();
    globalWithScope.rules[0] = { ...globalWithScope.rules[0]!, scope };
    expect(() => validateKnowledgeRelease(globalWithScope)).toThrow('knowledge-global-scope-invalid');
    const knowledge = new KnowledgeService();
    knowledge.publish(scopedRelease());
    // A model cannot smuggle a scope through a tool argument.
    const injected = knowledge.invoke('query_knowledge_facts', { predicate: 'server.chest', scope });
    expect(injected.ok).toBe(false);
    expect(injected.error).toContain('Unrecognized key');
    // The service's trusted scope is the only source used by tools.
    const trusted = new KnowledgeService({ trustedScope: scope });
    trusted.publish(scopedRelease());
    expect(trusted.invoke('query_knowledge_facts', { predicate: 'server.chest' })).toMatchObject({ ok: true, result: { items: [{ id: 'server-chest-a' }] } });
  });
});

describe('S07 FEC-52 three-state coverage', () => {
  it('separates a verified negative from incomplete coverage and unavailable sources', () => {
    const knowledge = new KnowledgeService();
    knowledge.publish(scopedRelease());
    const negative = knowledge.query({ predicate: 'block.hardness', subject: 'missing_block' });
    expect(negative).toMatchObject({
      status: 'not_found_in_verified_dataset', unknown: false, items: [],
      coverage: { predicate: 'block.hardness', completeness: 'complete', subjectCovered: true },
    });
    const partial = knowledge.query({ predicate: 'loot.table', subject: 'missing_mob' });
    expect(partial).toMatchObject({
      status: 'unknown_due_to_incomplete_coverage', reason: 'coverage-partial', unknown: true, items: [],
      coverage: { completeness: 'partial', subjectCovered: false },
    });
    // A covered predicate whose subject is unknown is never turned into a negative.
    expect(knowledge.query({ predicate: 'tag.item' })).toMatchObject({ status: 'unknown_due_to_incomplete_coverage', reason: 'coverage-unknown', unknown: true });
    expect(knowledge.query({ predicate: 'unmapped.predicate' })).toMatchObject({ status: 'source_unavailable', reason: 'missing-source', unknown: true });
    const coverage = knowledge.coverage();
    expect(coverage.predicates['block.hardness']).toMatchObject({ completeness: 'complete' });
    expect(coverage.predicates['loot.table']).toMatchObject({ completeness: 'partial' });
    expect(coverage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: 'block.hardness', completeness: 'complete' }),
      expect.objectContaining({ predicate: 'loot.table', completeness: 'partial' }),
      expect.objectContaining({ predicate: 'tag.item', completeness: 'unknown' }),
    ]));
  });

  it('exposes candidate-inherited and integrity-failed states explicitly', () => {
    const knowledge = new KnowledgeService();
    knowledge.publish(scopedRelease());
    expect(knowledge.query({ predicate: 'legacy.recipe' })).toMatchObject({
      status: 'candidate-inherited-unverified', unknown: true, reason: 'candidate-inherited-unverified', items: [{ id: 'candidate-recipe' }],
    });
    const failed = scopedRelease();
    failed.releaseId = 'release-broken';
    failed.integrity = 'failed';
    knowledge.publish(failed, false);
    expect(knowledge.query({ releaseId: 'release-broken' })).toMatchObject({ status: 'integrity-failed', unknown: true, items: [], reason: 'release-integrity-failed' });
  });

  it('reports missing releases as source-unavailable and keeps the legacy boolean derived', () => {
    const knowledge = new KnowledgeService();
    const missing = knowledge.query({ predicate: 'block.hardness' });
    expect(missing).toMatchObject({ status: 'source_unavailable', reason: 'release-missing', unknown: true });
    knowledge.publish(scopedRelease());
    expect(knowledge.query({ predicate: 'block.hardness' }).unknown).toBe(false);
    expect(knowledge.query({ predicate: 'block.hardness', subject: 'nope' }).unknown).toBe(false);
  });
});
