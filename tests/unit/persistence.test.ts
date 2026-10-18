import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SQLiteStore } from '../../src/persistence/store.js';

const context = { serverProfileId: 'fixture', worldGenerationId: 'world-a', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };
const tempDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'furevercraft-')), 'state.sqlite');

function execution() {
  return { executionId: 'execution-1', proposalId: 'proposal-1', proposalHash: 'hash-1', goalId: 'goal-1', skillId: 'place_one', skillVersion: '1.0.0', status: 'queued' };
}

describe('SQLiteStore W04 persistence', () => {
  it('persists proposals, action receipts and pending effects across restart', () => {
    const file = tempDb();
    const first = new SQLiteStore(file);
    first.saveExecution(execution());
    first.addActionReceipt({ receiptId: 'receipt-1', scope: 'body-1', commandId: 'cmd-1', status: 'completed', result: { accepted: true }, context });
    first.addEffect({ effectId: 'effect-1', executionId: 'execution-1', context, status: 'may-have-dispatched', intent: { kind: 'click' } });
    first.close();

    const second = new SQLiteStore(file);
    expect(second.getExecution('proposal-1')).toMatchObject({ executionId: 'execution-1', proposalHash: 'hash-1' });
    expect(second.getActionReceipt('body-1', 'cmd-1')).toMatchObject({ status: 'completed', result: { accepted: true } });
    expect(second.pendingEffects()[0]).toMatchObject({ effectId: 'effect-1', status: 'may-have-dispatched', intent: { kind: 'click' } });
    second.updateEffect('effect-1', 'confirmed', { observed: true });
    expect(second.pendingEffects()).toHaveLength(0);
    second.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('rejects a proposal id reused with a different hash', () => {
    const store = new SQLiteStore(tempDb());
    store.saveExecution(execution());
    expect(() => store.saveExecution({ ...execution(), proposalHash: 'different' })).toThrow('proposal-id-conflict');
    store.close();
  });

  it('stores checkpoints, durable events, places and episodes with context isolation', () => {
    const file = tempDb();
    const store = new SQLiteStore(file);
    store.saveCheckpoint({ checkpointId: 'cp-1', executionId: 'execution-1', revision: 2, payload: { position: { x: 2, y: 3 } } });
    store.saveCheckpoint({ checkpointId: 'cp-2', executionId: 'execution-1', revision: 3, payload: { position: { x: 3, y: 3 } } });
    store.addCriticalEvent({ seq: '1', eventId: 'event-1', kind: 'effect.confirmed', context, payload: { effectId: 'effect-1' } });
    store.savePlace({ placeId: 'place-a', context, status: 'valid', lastVerifiedAt: '2026-01-01T00:00:00.000Z', payload: { x: 4, y: 5 } });
    store.savePlace({ placeId: 'place-b', context: { ...context, dimension: 'the_nether' }, status: 'valid', payload: { x: 1, y: 2 } });
    store.saveEpisode({ episodeId: 'episode-a', context, eventRefs: ['event-1'], summary: { text: 'placed block' } });

    expect(store.getLatestCheckpoint('execution-1')).toMatchObject({ revision: 3, payload: { position: { x: 3, y: 3 } } });
    expect(store.getCriticalEvents()).toMatchObject([{ eventId: 'event-1', context, payload: { effectId: 'effect-1' } }]);
    expect(store.listPlaces(context)).toHaveLength(1);
    expect(store.getEpisode('episode-a')).toMatchObject({ eventRefs: ['event-1'], summary: { text: 'placed block' } });
    store.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('rolls back a transaction as one unit', () => {
    const store = new SQLiteStore(tempDb());
    expect(() => store.transaction(() => {
      store.saveExecution(execution());
      store.addEffect({ effectId: 'effect-tx', executionId: 'execution-1', context, status: 'prepared', intent: { kind: 'click' } });
      throw new Error('crash-before-commit');
    })).toThrow('crash-before-commit');
    expect(store.getExecution('execution-1')).toBeUndefined();
    expect(store.pendingEffects()).toHaveLength(0);
    store.close();
  });
});

describe('audit regressions', () => {
  it('rejects a same-revision goal overwrite', () => {
    const store = new SQLiteStore(':memory:');
    store.saveGoal({ goalId: 'g', revision: 1, status: 'active', text: 'one' });
    expect(() => store.saveGoal({ goalId: 'g', revision: 1, status: 'active', text: 'overwrite' })).toThrow('goal-revision-conflict');
    expect(store.getGoal('g')?.spec.text).toBe('one');
    store.close();
  });

  it('keeps goal CAS effective across a database reopen (FEC-204)', () => {
    const file = tempDb();
    const first = new SQLiteStore(file);
    first.saveGoal({ goalId: 'g', revision: 1, status: 'active', text: 'one', context });
    first.close();

    const second = new SQLiteStore(file);
    expect(second.getGoal('g')).toMatchObject({ revision: 1, spec: { text: 'one' } });
    expect(() => second.saveGoal({ goalId: 'g', revision: 1, status: 'active', text: 'overwrite' })).toThrow('goal-revision-conflict:1');
    second.saveGoal({ goalId: 'g', revision: 2, status: 'active', text: 'two' });
    expect(second.getGoal('g')).toMatchObject({ revision: 2, spec: { text: 'two' } });
    second.close();

    const third = new SQLiteStore(file);
    expect(() => third.saveGoal({ goalId: 'g', revision: 2, status: 'active', text: 'replay' })).toThrow('goal-revision-conflict:2');
    expect(third.getGoal('g')).toMatchObject({ revision: 2, spec: { text: 'two' } });
    const revised = third.reviseGoal('g', 2, 'three');
    expect(revised).toMatchObject({ revision: 3, spec: { text: 'three' } });
    third.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('rejects a goal revision rollback and a same-revision write after a revision (FEC-202/208)', () => {
    const store = new SQLiteStore(':memory:');
    expect(() => store.saveGoal({ goalId: 'g', revision: 3, status: 'active', text: 'skip-first' })).toThrow('goal-revision-conflict:0');
    expect(store.getGoal('g')).toBeUndefined();
    store.saveGoal({ goalId: 'g', revision: 1, status: 'active', text: 'one' });
    store.saveGoal({ goalId: 'g', revision: 2, status: 'active', text: 'two' });
    expect(() => store.saveGoal({ goalId: 'g', revision: 1, status: 'active', text: 'rollback' })).toThrow('goal-revision-conflict:2');
    expect(() => store.saveGoal({ goalId: 'g', revision: 2, status: 'active', text: 'same' })).toThrow('goal-revision-conflict:2');
    expect(() => store.saveGoal({ goalId: 'g', revision: 4, status: 'active', text: 'skip' })).toThrow('goal-revision-conflict:2');
    expect(store.getGoal('g')).toMatchObject({ revision: 2, spec: { text: 'two' } });
    expect(() => store.reviseGoal('g', 1, 'stale-writer')).toThrow('goal-revision-conflict:2');
    expect(store.listGoals()).toHaveLength(1);
    store.close();
  });

  it('isolates places by (place_id, context) so another world cannot overwrite them (FEC-219/220)', () => {
    const file = tempDb();
    const otherWorld = { ...context, worldGenerationId: 'world-b' };
    const store = new SQLiteStore(file);
    store.savePlace({ placeId: 'home', context, status: 'valid', payload: { x: 4, y: 5 } });
    store.savePlace({ placeId: 'home', context: otherWorld, status: 'valid', payload: { x: 40, y: 50 } });

    // Both scopes keep their own record; same-scope writes still update in place.
    expect(store.listPlaces(context)).toMatchObject([{ context, payload: { x: 4, y: 5 } }]);
    expect(store.listPlaces(otherWorld)).toMatchObject([{ context: otherWorld, payload: { x: 40, y: 50 } }]);
    expect(store.listPlaces()).toHaveLength(2);
    expect(store.getPlace('home', context)).toMatchObject({ payload: { x: 4, y: 5 } });
    expect(store.getPlace('home', otherWorld)).toMatchObject({ payload: { x: 40, y: 50 } });
    store.savePlace({ placeId: 'home', context: otherWorld, status: 'stale', payload: { x: 41, y: 51 } });
    expect(store.listPlaces()).toHaveLength(2);
    expect(store.listPlaces(otherWorld)).toMatchObject([{ status: 'stale', payload: { x: 41, y: 51 } }]);
    expect(store.listPlaces(context)).toMatchObject([{ status: 'valid', payload: { x: 4, y: 5 } }]);

    // API compatibility: getPlace(id) is the record in the current scope (latest scoped write).
    expect(store.getPlace('home')).toMatchObject({ context: otherWorld, payload: { x: 41, y: 51 } });
    expect(store.rememberPlace({ placeId: 'home', context, status: 'valid', payload: { x: 6, y: 7 } })).toMatchObject({ context, payload: { x: 6, y: 7 } });
    expect(store.getPlace('home')).toMatchObject({ context, payload: { x: 6, y: 7 } });
    expect(store.getPlace('home', otherWorld)).toMatchObject({ payload: { x: 41, y: 51 } });
    store.close();

    const reopened = new SQLiteStore(file);
    expect(reopened.listPlaces(context)).toMatchObject([{ payload: { x: 6, y: 7 } }]);
    expect(reopened.listPlaces(otherWorld)).toMatchObject([{ payload: { x: 41, y: 51 } }]);
    reopened.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('widens legacy single-column place/episode keys to (id, context) on open', () => {
    const file = tempDb();
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE places(place_id TEXT PRIMARY KEY, context TEXT NOT NULL, status TEXT NOT NULL,
        last_verified_at TEXT, payload_json TEXT NOT NULL);
      CREATE TABLE episodes(episode_id TEXT PRIMARY KEY, context TEXT NOT NULL,
        event_refs_json TEXT NOT NULL, summary_json TEXT NOT NULL);
      INSERT INTO places VALUES ('home', '${JSON.stringify(context)}', 'valid', NULL, '{"x":1,"y":2}');
      INSERT INTO episodes VALUES ('ep', '${JSON.stringify(context)}', '["event-0"]', '{"text":"legacy"}');
    `);
    legacy.close();

    const store = new SQLiteStore(file);
    expect(store.listPlaces(context)).toMatchObject([{ payload: { x: 1, y: 2 } }]);
    expect(store.getEpisode('ep')).toMatchObject({ eventRefs: ['event-0'], summary: { text: 'legacy' } });
    store.savePlace({ placeId: 'home', context: { ...context, worldGenerationId: 'world-b' }, status: 'valid', payload: { x: 9, y: 9 } });
    expect(store.listPlaces()).toHaveLength(2);
    expect(store.listPlaces(context)).toMatchObject([{ status: 'valid', payload: { x: 1, y: 2 } }]);
    store.close();

    // Reopening a migrated database is idempotent.
    const reopened = new SQLiteStore(file);
    expect(reopened.listPlaces()).toHaveLength(2);
    expect(reopened.listEpisodes()).toHaveLength(1);
    reopened.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('isolates episodes by (episode_id, context)', () => {
    const otherWorld = { ...context, worldGenerationId: 'world-b' };
    const store = new SQLiteStore(':memory:');
    store.saveEpisode({ episodeId: 'ep', context, eventRefs: ['event-1'], summary: { text: 'placed block' } });
    store.saveEpisode({ episodeId: 'ep', context: otherWorld, eventRefs: ['event-9'], summary: { text: 'other world' } });
    expect(store.listEpisodes(context)).toMatchObject([{ eventRefs: ['event-1'], summary: { text: 'placed block' } }]);
    expect(store.listEpisodes(otherWorld)).toMatchObject([{ eventRefs: ['event-9'], summary: { text: 'other world' } }]);
    expect(store.listEpisodes()).toHaveLength(2);
    store.saveEpisode({ episodeId: 'ep', context, eventRefs: ['event-1', 'event-2'], summary: { text: 'placed block' } });
    expect(store.listEpisodes()).toHaveLength(2);
    expect(store.listEpisodes(context)).toMatchObject([{ eventRefs: ['event-1', 'event-2'] }]);
    expect(store.getEpisode('ep', context)).toMatchObject({ eventRefs: ['event-1', 'event-2'], context });
    expect(store.recordEpisode({ episodeId: 'ep', context: otherWorld, eventRefs: ['event-8'], summary: { text: 'third' } })).toMatchObject({ context: otherWorld, summary: { text: 'third' } });
    // API compatibility: getEpisode(id) resolves inside the current scope.
    expect(store.getEpisode('ep')).toMatchObject({ context: otherWorld, summary: { text: 'third' } });
    expect(store.getEpisode('missing')).toBeUndefined();
    store.close();
  });
});
