import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SQLiteStore } from '../../src/persistence/store.js';
import { KnowledgeService, type KnowledgeRelease } from '../../src/autonomous/knowledge.js';
import { MemoryService, createPlaceResolver } from '../../src/autonomous/memory.js';

const tempDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'furevercraft-memory-')), 'state.sqlite');
const now = Date.parse('2026-03-01T00:00:00.000Z');
const scope = { serverProfileId: 'fixture', accountId: 'account-a', worldGenerationId: 'world-a', dimensionId: 'overworld' };
const otherWorld = { ...scope, worldGenerationId: 'world-b' };
const nether = { ...scope, dimensionId: 'the_nether' };
const otherAccount = { ...scope, accountId: 'account-b' };
const memoryFor = (store: SQLiteStore) => new MemoryService(store, [], { now: () => now, freshnessMaxAgeMs: 60_000 });

function knowledgeRelease(): KnowledgeRelease {
  return {
    releaseId: 'release-memory', version: '1.0.0', createdAt: '2026-01-01T00:00:00.000Z',
    manifest: { manifestVersion: 'm1', createdAt: '2026-01-01T00:00:00.000Z', sources: [{ sourceId: 'fixture-source', version: '1', kind: 'fixture', origin: 'fixture://source', verified: true, covers: ['block.hardness'], registeredAt: '2026-01-01T00:00:00.000Z' }] },
    rules: [{ id: 'hardness', namespace: 'rule', predicate: 'block.hardness', subject: 'stone', value: 1.5, sourceId: 'fixture-source', sourceVersion: '1' }],
  };
}

describe('P20 spatial memory', () => {
  it('creates, queries, updates and invalidates a scoped place with revisions', () => {
    const store = new SQLiteStore(':memory:');
    const memory = memoryFor(store);
    const created = memory.rememberPlace({ placeId: 'home', context: scope, payload: { x: 4, y: 5 }, provenance: { source: 'observed-server', observer: 'fixture' } });
    expect(created).toMatchObject({ placeId: 'home', status: 'known', revision: 0, freshness: 'current', fresh: true, provenance: { observer: 'fixture' } });
    expect(created.scope).toEqual(scope);
    const updated = memory.updatePlace('home', scope, { payload: { x: 6, y: 7 }, expectedRevision: 0, provenance: { source: 'observed-server' } });
    expect(updated).toMatchObject({ revision: 1, payload: { x: 6, y: 7 } });
    expect(() => memory.updatePlace('home', scope, { payload: { x: 9, y: 9 }, expectedRevision: 0 })).toThrow('place-revision-conflict:1');
    const invalidated = memory.invalidatePlace('home', scope, 'target-destroyed', 1);
    expect(invalidated).toMatchObject({ revision: 2, status: 'invalid', invalidatedReason: 'target-destroyed' });
    expect(memory.resolveReturnToPlace('home', scope)).toEqual({ ok: false, reason: 'place-invalid' });
    expect(() => memory.updatePlace('missing', scope, {})).toThrow('place-not-found');
    store.close();
  });

  it('resolves only the exact scope and rejects cross-dimension/world/account access', () => {
    const store = new SQLiteStore(':memory:');
    const memory = memoryFor(store);
    memory.rememberPlace({ placeId: 'home', context: scope, payload: { x: 2, y: 3 }, status: 'valid' });
    expect(memory.returnToPlaceTarget('home', scope)).toMatchObject({ x: 2, y: 3, placeId: 'home', freshness: 'current' });
    expect(createPlaceResolver(memory, scope)('home')).toEqual({ x: 2, y: 3 });
    expect(createPlaceResolver(memory, nether)('home')).toBeUndefined();
    expect(memory.resolvePlace('home', nether)).toBeUndefined();
    expect(memory.resolvePlace('home', otherWorld)).toBeUndefined();
    expect(memory.resolvePlace('home', otherAccount)).toBeUndefined();
    // The same id in another world is a separate record, never an overwrite.
    memory.rememberPlace({ placeId: 'home', context: otherWorld, payload: { x: 40, y: 50 }, status: 'valid' });
    expect(memory.returnToPlaceTarget('home', scope)).toMatchObject({ x: 2, y: 3 });
    expect(memory.returnToPlaceTarget('home', otherWorld)).toMatchObject({ x: 40, y: 50 });
    store.close();
  });

  it('marks old or unverified placements stale/unknown and withholds them from return_to_place', () => {
    const store = new SQLiteStore(':memory:');
    const memory = memoryFor(store);
    memory.rememberPlace({ placeId: 'old', context: scope, payload: { x: 1, y: 1 }, lastVerifiedAt: new Date(now - 120_000).toISOString() });
    expect(memory.resolvePlace('old', scope)?.freshness).toBe('stale');
    expect(memory.returnToPlaceTarget('old', scope)).toBeUndefined();
    expect(memory.resolveReturnToPlace('old', scope)).toEqual({ ok: false, reason: 'place-stale' });
    store.savePlace({ placeId: 'unknown', context: scope, status: 'known', payload: { x: 2, y: 2 } });
    expect(memory.resolvePlace('unknown', scope)?.freshness).toBe('unknown');
    expect(memory.resolveReturnToPlace('unknown', scope)).toEqual({ ok: false, reason: 'place-unknown' });
    store.close();
  });

  it('preserves places and revisions across a restart and isolates a rebuilt world', () => {
    const file = tempDb();
    const first = new SQLiteStore(file);
    const created = memoryFor(first).rememberPlace({ placeId: 'base', context: scope, payload: { x: 12, y: -3 }, provenance: { source: 'observed-server' } });
    expect(created.revision).toBe(0);
    first.close();
    const second = new SQLiteStore(file);
    const memory = memoryFor(second);
    expect(memory.resolvePlace('base', scope)).toMatchObject({ payload: { x: 12, y: -3 }, revision: 0, freshness: 'current' });
    expect(memory.returnToPlaceTarget('base', scope)).toMatchObject({ x: 12, y: -3 });
    expect(memory.resolvePlace('base', otherWorld)).toBeUndefined();
    second.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('bounds place and episode pages with cursors', () => {
    const store = new SQLiteStore(':memory:');
    const memory = memoryFor(store);
    for (let index = 0; index < 25; index++) memory.rememberPlace({ placeId: `p-${String(index).padStart(2, '0')}`, context: scope, payload: { x: index, y: 0 } });
    const first = memory.queryPlaces({ scope, limit: 100 });
    expect(first.items).toHaveLength(20);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe('20');
    const second = memory.queryPlaces({ scope, cursor: first.nextCursor });
    expect(second.items).toHaveLength(5);
    expect(second.truncated).toBe(false);
    expect(() => memory.queryPlaces({ scope, cursor: 'oops' })).toThrow('invalid-memory-cursor');
    expect(() => memory.queryPlaces({ cursor: '20000' })).toThrow('memory-cursor-limit');
    for (let index = 0; index < 12; index++) {
      memory.recordExecutionExperience({ episodeId: `e-${String(index).padStart(2, '0')}`, scope, skillId: 'dig_one', outcome: 'failed', failureClass: 'precondition', premises: [{ name: 'target', value: 'stone' }], evidence: [{ kind: 'observation', ref: `event-${index}` }] });
    }
    const experiences = memory.queryExperiences({ scope, limit: 10 });
    expect(experiences.items).toHaveLength(10);
    expect(experiences.truncated).toBe(true);
    expect(memory.queryExperiences({ scope, cursor: experiences.nextCursor }).items).toHaveLength(2);
    store.close();
  });
});

describe('P20 execution experience', () => {
  it('records concrete premises, failure class and evidence without creating a world rule', () => {
    const store = new SQLiteStore(':memory:');
    const memory = memoryFor(store);
    const experience = memory.recordExecutionExperience({
      episodeId: 'experience-1', scope, skillId: 'dig_one', goalId: 'goal-1', executionId: 'execution-1',
      outcome: 'failed', failureClass: 'precondition',
      premises: [{ name: 'target-cell', value: 'blocked' }, { name: 'tool', value: 'stone_pickaxe' }],
      evidence: [{ kind: 'observation', ref: 'event-42', detail: { cell: 'blocked' } }],
      provenance: { source: 'execution' },
    });
    expect(experience).toMatchObject({ kind: 'execution-experience', failureClass: 'precondition', authorizesAction: false, authorizesWorldRule: false });
    expect(memory.queryExperiences({ scope }).items).toMatchObject([{ episodeId: 'experience-1', premises: [{ name: 'target-cell', value: 'blocked' }, { name: 'tool', value: 'stone_pickaxe' }] }]);
    expect(() => memory.recordExecutionExperience({ episodeId: 'bad', scope, skillId: 'dig_one', outcome: 'failed', failureClass: 'x', premises: [], evidence: [] })).toThrow('experience-premises-required');
    expect(() => memory.recordExecutionExperience({ episodeId: 'bad-2', scope, skillId: 'dig_one', outcome: 'confirmed', failureClass: 'precondition', premises: [{ name: 'target', value: 'stone' }], evidence: [{ kind: 'observation' }] })).toThrow('experience-failure-class-conflict');
    store.close();
  });

  it('keeps experience out of the knowledge namespace and never lets history authorize a stale place action', () => {
    const store = new SQLiteStore(':memory:');
    const memory = memoryFor(store);
    memory.recordExecutionExperience({ episodeId: 'experience-2', scope, skillId: 'place_one', outcome: 'confirmed', failureClass: 'none', premises: [{ name: 'target', value: 'free' }], evidence: [{ kind: 'snapshot', ref: 'event-7' }] });
    memory.rememberPlace({ placeId: 'home', context: scope, payload: { x: 1, y: 2 }, lastVerifiedAt: new Date(now - 120_000).toISOString() });
    const knowledge = new KnowledgeService({ store });
    knowledge.publish(knowledgeRelease());
    // The successful execution is evidence, not a rule: no knowledge predicate was created for it.
    expect(knowledge.query({ predicate: 'place_one.success' })).toMatchObject({ unknown: true, reason: 'missing-source', items: [] });
    expect(knowledge.coverage().namespaces.rule).toBe(1);
    // History cannot substitute for a fresh place observation.
    expect(memory.resolveReturnToPlace('home', scope)).toEqual({ ok: false, reason: 'place-stale' });
    expect(memory.returnToPlaceTarget('home', scope)).toBeUndefined();
    expect(memory.queryEpisodic({ scope }).items[0]).toMatchObject({ authorizesAction: false });
    store.close();
  });
});
