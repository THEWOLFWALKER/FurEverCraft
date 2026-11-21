import { describe, expect, it } from 'vitest';
import { ObserverSessionRegistry } from '../../src/bridge/observer/worker.js';
import { ObserverWorkerHost, type WorkerLike } from '../../src/bridge/observer/host.js';
import type { ObserverEvent } from '../../src/bridge/observer/bounded.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const frame = (payload: number[]) => Buffer.from([payload.length, ...payload]);

class FakeWorker implements WorkerLike {
  readonly posted: unknown[] = [];
  private readonly handlers = new Map<string, Set<(value?: unknown) => void>>();
  postMessage(value: unknown) { this.posted.push(value); }
  on(event: 'message' | 'error' | 'exit', listener: (value?: unknown) => void) {
    const set = this.handlers.get(event) ?? new Set();
    set.add(listener);
    this.handlers.set(event, set);
    return this;
  }
  emit(event: 'message' | 'error' | 'exit', value?: unknown) { for (const listener of this.handlers.get(event) ?? []) listener(value); }
  async terminate() { return 0; }
}

describe('S02 per-connection observer sessions', () => {
  it('interleaves two connections without mixing partial frames', async () => {
    const events: ObserverEvent[] = [];
    const registry = new ObserverSessionRegistry({ onEvent: event => events.push(event), observerLimits: { maxQueuedFrames: 16 } });

    // A sends only the first byte of a two-byte frame; B sends a complete frame.
    registry.attach('relay_a', 'client-to-server', Buffer.from([2, 0x11]));
    registry.attach('relay_b', 'client-to-server', frame([0x22, 0x33]));
    await tick();

    expect(events.filter(event => event.sessionEpoch === 'relay_a')).toEqual([]);
    const fromB = events.filter(event => event.kind === 'observation' && event.sessionEpoch === 'relay_b');
    expect(fromB).toHaveLength(1);
    expect(fromB[0]).toMatchObject({ direction: 'client-to-server', payload: { offsetStart: '0', offsetEnd: '3', payloadBytes: 2 } });

    // A's remainder completes only A's frame; B is not advanced by A's bytes.
    registry.attach('relay_a', 'client-to-server', Buffer.from([0x44]));
    await tick();
    const fromA = events.filter(event => event.kind === 'observation' && event.sessionEpoch === 'relay_a');
    expect(fromA).toHaveLength(1);
    expect(fromA[0]).toMatchObject({ payload: { offsetStart: '0', offsetEnd: '3', payloadBytes: 2 } });
    expect(events.filter(event => event.kind === 'observation' && event.sessionEpoch === 'relay_b')).toHaveLength(1);
  });

  it('starts a reconnect with fresh decoders, offsets, phase and compression', async () => {
    const events: ObserverEvent[] = [];
    const registry = new ObserverSessionRegistry({ onEvent: event => events.push(event), observerLimits: { maxQueuedFrames: 16 } });
    // Old connection leaves a partial frame and enables compression on the upstream direction.
    registry.attach('relay_old', 'client-to-server', Buffer.from([5, 1]));
    registry.setCompression('relay_old', 'server-to-client', true, 64);
    const oldState = registry.observerFor('relay_old')!.state();
    expect(oldState.upstream).toMatchObject({ compression: 'enabled', compressionThreshold: 64 });

    registry.close('relay_old');
    // Late bytes for the closed session never complete the old partial frame.
    expect(registry.attach('relay_old', 'client-to-server', Buffer.from([2, 3, 4]))).toBeUndefined();
    await tick();
    expect(events.filter(event => event.kind === 'observation')).toEqual([]);

    const fresh = registry.attach('relay_new', 'client-to-server', frame([7, 8]))!;
    await tick();
    expect(fresh.state().downstream).toMatchObject({
      byteOffset: '3', frameSequence: '1', phase: 'UNKNOWN', compression: 'disabled', compressionThreshold: null,
    });
    const observed = events.filter(event => event.kind === 'observation' && event.sessionEpoch === 'relay_new');
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ payload: { offsetStart: '0', offsetEnd: '3' } });
  });

  it('bounds the active session map and reports a global gap when evicting', async () => {
    const events: ObserverEvent[] = [];
    const registry = new ObserverSessionRegistry({ onEvent: event => events.push(event), maxSessions: 2 });
    registry.attach('relay_1', 'client-to-server', frame([1]));
    registry.attach('relay_2', 'client-to-server', frame([2]));
    registry.attach('relay_3', 'client-to-server', frame([3]));
    expect(registry.size).toBe(2);
    expect(registry.keys()).toEqual(['relay_2', 'relay_3']);
    expect(events.some(event => event.kind === 'observer_gap' && event.gap.reason === 'observer-session-eviction' && event.gap.scope === 'global')).toBe(true);
    // An evicted connection is not silently observed under a new decoder.
    expect(registry.attach('relay_1', 'client-to-server', frame([4]))).toBeUndefined();
  });

  it('host routes session close to the worker and ignores late state for it', () => {
    const worker = new FakeWorker();
    const host = new ObserverWorkerHost({ createWorker: () => worker, onEvent: () => {} });
    host.start();
    expect(host.attach('client-to-server', new Uint8Array([1, 2]), 'relay_a')).toBe(true);
    host.closeSession('relay_a');
    expect(worker.posted).toContainEqual(expect.objectContaining({ type: 'close-session', sessionEpoch: 'relay_a' }));
    // Late state/chunks for the closed epoch are dropped.
    worker.emit('message', { type: 'state', sessionEpoch: 'relay_a', direction: 'client-to-server', state: { frameSequence: '9', availability: 'degraded' } });
    expect(host.state().directions['client-to-server'].frameSequence).toBe('0');
    expect(host.attach('client-to-server', new Uint8Array([3]), 'relay_a')).toBe(false);
  });
});
