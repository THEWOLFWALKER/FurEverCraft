import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
