import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { EventHub } from '../../src/diagnostics/events.js';
import { SessionRuntime } from '../../src/execution/session.js';
import { SQLiteStore } from '../../src/persistence/store.js';

const context = {
  serverProfileId: 'fixture',
  worldGenerationId: 'world-c2',
  connectionEpoch: '1',
  bodyEpoch: '1',
  dimension: 'overworld',
};

const tempDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'furevercraft-c2-')), 'state.sqlite');
const cleanup = (file: string) => fs.rmSync(path.dirname(file), { recursive: true, force: true });

function seedPlaceEffect(file: string, status: string = 'may-have-dispatched') {
  const store = new SQLiteStore(file);
  store.saveExecution({
    executionId: 'execution-c2',
    proposalId: 'proposal-c2',
    proposalHash: 'hash-c2',
    goalId: 'goal-c2',
    skillId: 'place_one',
    skillVersion: '1.0.0',
    status: 'running',
  });
  store.addEffect({
    effectId: 'effect-c2',
    executionId: 'execution-c2',
    context,
    status,
    intent: { kind: 'place', x: 1, y: 0 },
  });
  store.close();
}

describe('C2 receipt and effect recovery contracts', () => {
  it('keeps the first receipt for an identical command replay', () => {
    const file = tempDb();
    const store = new SQLiteStore(file);
    store.addActionReceipt({ receiptId: 'receipt-c2', scope: 'body-c2', commandId: 'command-c2', status: 'completed', result: { accepted: true }, context });
    store.addActionReceipt({ receiptId: 'receipt-c2-replay', scope: 'body-c2', commandId: 'command-c2', status: 'unknown', result: { accepted: false }, context });
    expect(store.getActionReceipt('body-c2', 'command-c2')).toMatchObject({ status: 'completed', result: { accepted: true } });
    store.close();
    cleanup(file);
  });

  it('does not confirm a place effect from an unavailable snapshot', () => {
    const file = tempDb();
    seedPlaceEffect(file);
    const store = new SQLiteStore(file);
    const bridge = new FakeClientBridge(12, { context, faults: { snapshot: { fault: 'ambiguous', count: 1 } } });
    const result = new SessionRuntime(bridge, store).start();
    expect(result.reconciled).toEqual([{ effectId: 'effect-c2', status: 'ambiguous' }]);
    expect(store.pendingEffects()).toHaveLength(1);
    store.close();
    cleanup(file);
  });

  it.each(['may-have-dispatched', 'verifying'] as const)('reconciles the %s crash window without replaying input', (status) => {
    const file = tempDb();
    seedPlaceEffect(file, status);
    const bridge = new FakeClientBridge(12, { context });
    bridge.block(1, 0);
    const inventoryBefore = bridge.inventory;
    const store = new SQLiteStore(file);
    const result = new SessionRuntime(bridge, store).start();
    expect(result.reconciled).toEqual([{ effectId: 'effect-c2', status: 'confirmed' }]);
    expect(bridge.inventory).toBe(inventoryBefore);
    expect(store.pendingEffects()).toHaveLength(0);
    store.close();
    cleanup(file);
  });

  it('keeps a prepared (never dispatched) effect ambiguous even if the target is blocked', () => {
    const file = tempDb();
    seedPlaceEffect(file, 'prepared');
    const bridge = new FakeClientBridge(12, { context });
    bridge.block(1, 0);
    const store = new SQLiteStore(file);
    const result = new SessionRuntime(bridge, store).start();
    expect(result.reconciled).toEqual([{ effectId: 'effect-c2', status: 'ambiguous' }]);
    expect(store.pendingEffects()).toHaveLength(1);
    store.close();
    cleanup(file);
  });

  it('keeps recovery ambiguous when the body context changed', () => {
    const file = tempDb();
    seedPlaceEffect(file);
    const store = new SQLiteStore(file);
    const bridge = new FakeClientBridge(12, { context: { ...context, connectionEpoch: '2' } });
    bridge.block(1, 0);
    const result = new SessionRuntime(bridge, store).start();
    // The effect belongs to a previous connection epoch: it is left untouched, never re-attributed.
    expect(result.reconciled).toEqual([]);
    expect(store.getEffect('effect-c2')).toMatchObject({ status: 'may-have-dispatched', context });
    expect(store.getEffect('effect-c2')?.evidence).toBeUndefined();
    expect(store.pendingEffects()).toHaveLength(1);
    store.close();
    cleanup(file);
  });

  it('does not reconcile pending effects of another world or account (FEC-233)', () => {
    const file = tempDb();
    const store = new SQLiteStore(file);
    store.saveExecution({ executionId: 'execution-other', proposalId: 'proposal-other', proposalHash: 'hash-other', goalId: 'goal-other', skillId: 'place_one', skillVersion: '1.0.0', status: 'running' });
    store.saveExecution({ executionId: 'execution-c2', proposalId: 'proposal-c2', proposalHash: 'hash-c2', goalId: 'goal-c2', skillId: 'place_one', skillVersion: '1.0.0', status: 'running' });
    const otherWorld = { ...context, worldGenerationId: 'world-other' };
    const otherAccount = { ...context, bodyEpoch: '9' };
    store.addEffect({ effectId: 'effect-other-world', executionId: 'execution-other', context: otherWorld, status: 'may-have-dispatched', intent: { kind: 'place', x: 1, y: 0 } });
    store.addEffect({ effectId: 'effect-other-account', executionId: 'execution-other', context: otherAccount, status: 'verifying', intent: { kind: 'place', x: 1, y: 0 } });
    store.addEffect({ effectId: 'effect-c2', executionId: 'execution-c2', context, status: 'may-have-dispatched', intent: { kind: 'place', x: 1, y: 0 } });
    const bridge = new FakeClientBridge(12, { context });
    bridge.block(1, 0);

    const result = new SessionRuntime(bridge, store).start();
    expect(result.reconciled).toEqual([{ effectId: 'effect-c2', status: 'confirmed' }]);
    // Other scopes are left pending and untouched, with no recovery evidence written.
    for (const id of ['effect-other-world', 'effect-other-account']) {
      expect(store.getEffect(id)).toMatchObject({ status: id === 'effect-other-account' ? 'verifying' : 'may-have-dispatched' });
      expect(store.getEffect(id)?.evidence).toBeUndefined();
    }
    expect(store.pendingEffects().map(effect => effect.effectId)).toEqual(['effect-other-account', 'effect-other-world']);

    // Their own session can still reconcile them against its own snapshot.
    const otherBridge = new FakeClientBridge(12, { context: otherWorld });
    otherBridge.block(1, 0);
    const other = new SessionRuntime(otherBridge, store).start();
    expect(other.reconciled).toEqual([{ effectId: 'effect-other-world', status: 'confirmed' }]);
    expect(store.getEffect('effect-other-account')).toMatchObject({ status: 'verifying' });
    store.close();
    cleanup(file);
  });

  it('does not confirm from a snapshot with a gap (FEC-235/237)', () => {
    const file = tempDb();
    seedPlaceEffect(file);
    const store = new SQLiteStore(file);
    const bridge = new FakeClientBridge(12, { context });
    bridge.block(1, 0);
    // The observer reports a sequence gap: the cells in this snapshot are not fresh evidence.
    const original = bridge.snapshot.bind(bridge);
    bridge.snapshot = () => original(true);
    const result = new SessionRuntime(bridge, store).start();
    expect(result.reconciled).toEqual([{ effectId: 'effect-c2', status: 'ambiguous' }]);
    expect(store.getEffect('effect-c2')).toMatchObject({ status: 'ambiguous', evidence: { error: 'snapshot-gap' } });
    expect(store.pendingEffects()).toHaveLength(1);
    store.close();
    cleanup(file);
  });

  it.each([
    ['available=false', (field: Record<string, unknown>) => ({ ...field, available: false })],
    ['freshness=stale', (field: Record<string, unknown>) => ({ ...field, freshness: 'stale' })],
    ['freshness=unknown', (field: Record<string, unknown>) => ({ ...field, freshness: 'unknown' })],
  ])('does not confirm from a snapshot whose fields are not available (%s) (FEC-239)', (_label, corrupt) => {
    const file = tempDb();
    seedPlaceEffect(file);
    const store = new SQLiteStore(file);
    const bridge = new FakeClientBridge(12, { context });
    bridge.block(1, 0);
    const original = bridge.snapshot.bind(bridge);
    bridge.snapshot = (gap = false) => {
      const snapshot = original(gap);
      const cells = corrupt({ ...snapshot.fields.cells }) as (typeof snapshot.fields)[string];
      return { ...snapshot, fields: { ...snapshot.fields, cells } };
    };
    const result = new SessionRuntime(bridge, store).start();
    expect(result.reconciled).toEqual([{ effectId: 'effect-c2', status: 'ambiguous' }]);
    expect(store.getEffect('effect-c2')).toMatchObject({ status: 'ambiguous', evidence: { error: 'snapshot-stale', unavailableField: 'cells' } });
    expect(store.pendingEffects()).toHaveLength(1);
    store.close();
    cleanup(file);
  });

  it('does not confirm from a snapshot without field evidence at all', () => {
    const file = tempDb();
    seedPlaceEffect(file);
    const store = new SQLiteStore(file);
    const bridge = new FakeClientBridge(12, { context });
    bridge.block(1, 0);
    const original = bridge.snapshot.bind(bridge);
    // A snapshot that carries no per-field evidence cannot certify the cells are fresh.
    bridge.snapshot = (gap = false) => ({ ...original(gap), fields: {} });
    const result = new SessionRuntime(bridge, store).start();
    expect(result.reconciled).toEqual([{ effectId: 'effect-c2', status: 'ambiguous' }]);
    expect(store.getEffect('effect-c2')).toMatchObject({ status: 'ambiguous', evidence: { error: 'snapshot-unverified' } });
    expect(store.pendingEffects()).toHaveLength(1);
    store.close();
    cleanup(file);
  });
});

describe('C2 EventHub cursor contracts', () => {
  it('reports a gap relative to retained events of the requested filter', () => {
    const hub = new EventHub(2);
    hub.publish('noise', { n: 1 });
    hub.publish('target', { n: 2 });
    hub.publish('noise', { n: 3 });
    const read = hub.read('0', 10, 'target');
    expect(read.events.map(event => event.kind)).toEqual(['target']);
    expect(read.gap).toBe(false);
    expect(read.availableFrom).toBe('2');
  });

  it('replays durable events after a new EventHub is created', () => {
    const file = tempDb();
    const firstStore = new SQLiteStore(file);
    const firstHub = new EventHub(1, firstStore, context);
    const durable = firstHub.publish('effect.confirmed', { effectId: 'effect-c2' }, true, context);
    firstStore.close();

    const reopened = new SQLiteStore(file);
    const secondHub = new EventHub(1, reopened, context);
    expect(secondHub.read('0', 10, 'effect.confirmed')).toMatchObject({
      events: [expect.objectContaining({ seq: durable.seq, durable: true, kind: 'effect.confirmed' })],
      gap: false,
    });
    reopened.close();
    cleanup(file);
  });
});
