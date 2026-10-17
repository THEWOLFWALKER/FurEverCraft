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

  it.each(['prepared', 'may-have-dispatched', 'verifying'] as const)('reconciles the %s crash window without replaying input', (status) => {
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

  it('keeps recovery ambiguous when the body context changed', () => {
    const file = tempDb();
    seedPlaceEffect(file);
    const store = new SQLiteStore(file);
    const bridge = new FakeClientBridge(12, { context: { ...context, connectionEpoch: '2' } });
    bridge.block(1, 0);
    const result = new SessionRuntime(bridge, store).start();
    expect(result.reconciled).toEqual([{ effectId: 'effect-c2', status: 'ambiguous' }]);
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
