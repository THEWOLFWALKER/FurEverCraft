import { describe, expect, it } from 'vitest';
import { SQLiteStore } from '../../src/persistence/store.js';
import {
  MemoryService, resolveMemoryScope, createScopeResolver, createDynamicPlaceResolver,
} from '../../src/autonomous/memory.js';

const scope = { serverProfileId: 'server-a', accountId: 'account-a', worldGenerationId: 'world-1', dimensionId: 'overworld' };
const otherWorld = { ...scope, worldGenerationId: 'world-2' };
const utc = '2026-04-01T12:00:00.000Z';
const laterUtc = '2026-04-01T12:10:00.000Z';

function service(store: SQLiteStore, options: { utcNow?: () => string; mono?: () => number; maxAge?: number } = {}) {
  return new MemoryService(store, [], {
    utcNow: options.utcNow ?? (() => utc),
    nowMono: options.mono ?? (() => 12_345),
    freshnessMaxAgeMs: options.maxAge ?? 60_000,
  });
}

describe('S07 FEC-48 memory time basis', () => {
  it('never persists a legacy monotonic clock value as UTC', () => {
    const store = new SQLiteStore(':memory:');
    // A legacy caller supplies only a monotonic-looking number. It must not become a timestamp.
    const memory = new MemoryService(store, [], { now: () => 123_456_789, utcNow: () => utc });
    const place = memory.rememberPlace({ placeId: 'model-place', context: scope, payload: { x: 1, y: 2 } });
    expect(place).toMatchObject({ timeBasis: 'unknown', verificationStatus: 'unverified', freshness: 'unknown' });
    expect(place.lastVerifiedAt).toBeUndefined();
    expect(JSON.stringify(place.provenance)).toContain(utc);
    expect(JSON.stringify(place.provenance)).not.toContain('123456789');
    store.close();
  });

  it('compares freshness in UTC and treats legacy time_basis=unknown as unknown, not current/stale', () => {
    const store = new SQLiteStore(':memory:');
    const memory = service(store);
    // Explicitly verified but no trustworthy clock domain: unknown.
    store.savePlace({ placeId: 'legacy', context: scope, status: 'known', lastVerifiedAt: '2021-01-01T00:00:00.000Z', payload: { x: 1, y: 1 }, timeBasis: 'unknown', verificationStatus: 'verified' });
    expect(memory.resolvePlace('legacy', scope)?.freshness).toBe('unknown');
    expect(memory.returnToPlaceTarget('legacy', scope)).toBeUndefined();
    // The same UTC timestamp with a recorded UTC basis is stale.
    store.savePlace({ placeId: 'utc-old', context: scope, status: 'known', lastVerifiedAt: '2021-01-01T00:00:00.000Z', payload: { x: 1, y: 1 }, timeBasis: 'utc', verificationStatus: 'verified' });
    expect(memory.resolvePlace('utc-old', scope)?.freshness).toBe('stale');
    const fresh = service(store, { utcNow: () => laterUtc, maxAge: 60_000 });
    store.savePlace({ placeId: 'utc-new', context: scope, status: 'known', lastVerifiedAt: utc, payload: { x: 2, y: 2 }, timeBasis: 'utc', verificationStatus: 'verified' });
    expect(fresh.resolvePlace('utc-new', scope)?.freshness).toBe('stale');
    store.close();
  });

  it('record provenance uses UTC rather than the monotonic clock', () => {
    const store = new SQLiteStore(':memory:');
    const memory = new MemoryService(store, [], { now: () => 5, utcNow: () => utc });
    const view = memory.recordExecutionExperience({
      episodeId: 'ep-1', scope, skillId: 'dig_one', outcome: 'failed', failureClass: 'precondition',
      premises: [{ name: 'target', value: 'stone' }], evidence: [{ kind: 'observation', ref: 'e-1' }],
    });
    expect(JSON.stringify(view.provenance ?? {})).toContain(utc);
    store.close();
  });
});

describe('S07 FEC-49 dynamic scope resolution', () => {
  it('resolves scope on every call instead of freezing the constructor value', () => {
    let live: unknown = scope;
    const resolve = createScopeResolver(() => live);
    expect(resolve()).toMatchObject({ status: 'resolved', scope });
    live = otherWorld;
    expect(resolve()).toMatchObject({ status: 'resolved', scope: otherWorld });
    live = { serverProfileId: 'server-a', accountId: 'account-a' };
    expect(resolve()).toMatchObject({ status: 'unresolved', missing: ['worldGenerationId', 'dimensionId'] });
  });

  it('rejects unresolved scopes and never falls back to a previous world', () => {
    const store = new SQLiteStore(':memory:');
    const memory = service(store);
    memory.rememberPlace({ placeId: 'base', context: scope, payload: { x: 5, y: 6 } });
    memory.verifyPlaceFromObservation('base', scope, { source: 'server-observed', pose: { x: 5, y: 6 }, evidenceRef: 'e-base' });
    let live: unknown = scope;
    const target = createDynamicPlaceResolver(memory, () => live);
    expect(target('base')).toEqual({ x: 5, y: 6 });
    live = otherWorld;
    expect(target('base')).toBeUndefined();
    live = { serverProfileId: 'server-a' };
    expect(target('base')).toBeUndefined();
    live = scope;
    expect(target('base')).toEqual({ x: 5, y: 6 });
    store.close();
  });

  it('uses canonical stable scope identity', () => {
    const reversed = { dimensionId: 'overworld', worldGenerationId: 'world-1', accountId: 'account-a', serverProfileId: 'server-a' };
    expect(resolveMemoryScope(scope)).toMatchObject({ status: 'resolved', scopeKey: resolveMemoryScope(reversed).status === 'resolved' ? (resolveMemoryScope(reversed) as { scopeKey: string }).scopeKey : '' });
  });
});

describe('S07 FEC-51 trusted places', () => {
  it('promotes only observation-bound places and withholds model places from return_to_place', () => {
    const store = new SQLiteStore(':memory:');
    const memory = service(store);
    const remembered = memory.rememberPlace({ placeId: 'home', context: scope, payload: { x: 8, y: 9 }, lastVerifiedAt: utc });
    expect(remembered).toMatchObject({ verificationStatus: 'unverified', timeBasis: 'unknown', freshness: 'unknown' });
    expect(remembered.lastVerifiedAt).toBeUndefined();
    expect(memory.returnToPlaceTarget('home', scope)).toBeUndefined();
    expect(memory.resolveReturnToPlace('home', scope)).toEqual({ ok: false, reason: 'place-unverified' });
    expect(() => memory.verifyPlaceFromObservation('home', scope, { source: 'model', pose: { x: 8, y: 9 }, evidenceRef: 'model-made' })).toThrow('observation-not-trusted');
    expect(() => memory.verifyPlaceFromObservation('home', scope, { source: 'server-observed', pose: { x: 8, y: 9 }, evidenceRef: '' })).toThrow('observation-evidence-required');
    expect(() => memory.verifyPlaceFromObservation('home', scope, { source: 'server-observed', pose: { x: 8, y: 9 }, evidenceRef: 'e', scope: otherWorld })).toThrow('observation-scope-mismatch');
    const verified = memory.verifyPlaceFromObservation('home', scope, {
      source: 'server-observed', pose: { x: 8, y: 9, z: 10 }, evidenceRef: { id: 'obs-1' }, fieldRevision: 'rev-9',
    });
    expect(verified).toMatchObject({
      verificationStatus: 'verified', timeBasis: 'utc', freshness: 'current', lastVerifiedAt: utc,
      provenance: { source: 'server-observed', evidenceRef: 'obs-1', recordedAt: utc, fieldRevision: 'rev-9' },
    });
    expect(memory.returnToPlaceTarget('home', scope)).toMatchObject({ x: 8, y: 9, z: 10, freshness: 'current' });
    store.close();
  });

  it('does not let an update or a caller timestamp upgrade verification', () => {
    const store = new SQLiteStore(':memory:');
    const memory = service(store);
    memory.rememberPlace({ placeId: 'home', context: scope, payload: { x: 1, y: 2 } });
    memory.updatePlace('home', scope, { lastVerifiedAt: utc, payload: { x: 3, y: 4 }, provenance: { source: 'model' } });
    expect(memory.resolvePlace('home', scope)).toMatchObject({ verificationStatus: 'unverified', freshness: 'unknown', lastVerifiedAt: undefined });
    expect(memory.returnToPlaceTarget('home', scope)).toBeUndefined();
    store.close();
  });

  it('rejects stale observations and observations from a future clock skew', () => {
    const store = new SQLiteStore(':memory:');
    const memory = service(store);
    memory.rememberPlace({ placeId: 'home', context: scope, payload: { x: 1, y: 2 } });
    expect(() => memory.verifyPlaceFromObservation('home', scope, {
      source: 'server-observed', pose: { x: 1, y: 2 }, evidenceRef: 'old', observedAtUtc: '2026-04-01T11:50:00.000Z',
    })).toThrow('observation-stale');
    expect(() => memory.verifyPlaceFromObservation('home', scope, {
      source: 'server-observed', pose: { x: 1, y: 2 }, evidenceRef: 'future', observedAtUtc: '2026-04-01T12:05:00.000Z',
    })).toThrow('observation-clock-skew');
    store.close();
  });
});
