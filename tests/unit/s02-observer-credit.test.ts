import { describe, expect, it } from 'vitest';
import { ObserverWorkerHost, type WorkerLike } from '../../src/bridge/observer/host.js';
import type { ObserverEvent } from '../../src/bridge/observer/bounded.js';

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
  chunks(): Array<{ chunkId: string; bytes: Uint8Array; sessionEpoch?: string }> {
    return this.posted.filter((item): item is { type: 'chunk'; chunkId: string; bytes: Uint8Array; sessionEpoch?: string } =>
      (item as { type?: string }).type === 'chunk');
  }
}

const create = (limits: ConstructorParameters<typeof ObserverWorkerHost>[0]['limits']) => {
  const worker = new FakeWorker();
  const events: ObserverEvent[] = [];
  const host = new ObserverWorkerHost({ createWorker: () => worker, onEvent: event => events.push(event), limits });
  host.start();
  return { worker, events, host };
};

describe('S02 host-side observer credit', () => {
  it('splits large chunks without changing order and acks restore credit', () => {
    const { worker, host } = create({ maxInFlightBytes: 9, maxInFlightMessages: 8, maxChunkBytes: 4 });
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(host.attach('client-to-server', bytes, 'relay_a')).toBe(true);
    const chunks = worker.chunks();
    expect(chunks.map(chunk => Array.from(chunk.bytes))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
    expect(chunks.every(chunk => chunk.sessionEpoch === 'relay_a')).toBe(true);
    // The byte budget is fully reserved; the acks are what allow the next chunk.
    for (const chunk of chunks) worker.emit('message', { type: 'ack', chunkId: chunk.chunkId });
    expect(host.attach('client-to-server', Uint8Array.from([10]), 'relay_a')).toBe(true);
  });

  it('stops only the exhausted session and emits one global gap without blocking', () => {
    const { worker, events, host } = create({ maxInFlightBytes: 64, maxInFlightMessages: 2, maxChunkBytes: 16 });
    expect(host.attach('client-to-server', Uint8Array.from([1]), 'relay_a')).toBe(true);
    expect(host.attach('client-to-server', Uint8Array.from([2]), 'relay_a')).toBe(true);
    expect(host.attach('client-to-server', Uint8Array.from([3]), 'relay_a')).toBe(false);
    expect(events.filter(event => event.kind === 'observer_gap' && event.gap.reason === 'observer-credit-exhausted')).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionEpoch: 'relay_a', gap: { scope: 'global', reason: 'observer-credit-exhausted' } });
    // Another session remains observable; only the exhausted one stops.
    expect(host.attach('client-to-server', Uint8Array.from([4]), 'relay_b')).toBe(true);
    // Later attempts for the stopped session keep returning false but do not emit more gaps.
    expect(host.attach('client-to-server', Uint8Array.from([5]), 'relay_a')).toBe(false);
    expect(events.filter(event => event.kind === 'observer_gap')).toHaveLength(1);
    // The worker was told to drop the exhausted session's partial state.
    expect(worker.posted).toContainEqual(expect.objectContaining({ type: 'close-session', sessionEpoch: 'relay_a' }));
  });

  it('enforces the byte budget independently of the message budget', () => {
    const { host, events } = create({ maxInFlightBytes: 8, maxInFlightMessages: 64, maxChunkBytes: 4 });
    expect(host.attach('client-to-server', Uint8Array.from([1, 2, 3, 4]), 'relay_a')).toBe(true);
    expect(host.attach('client-to-server', Uint8Array.from([5, 6, 7, 8]), 'relay_a')).toBe(true);
    expect(host.attach('client-to-server', Uint8Array.from([9]), 'relay_a')).toBe(false);
    expect(events.some(event => event.kind === 'observer_gap' && event.gap.reason === 'observer-credit-exhausted')).toBe(true);
  });

  it('clears credit on worker error, exit and stop', async () => {
    for (const failure of ['error', 'exit', 'stop'] as const) {
      const { host, worker } = create({ maxInFlightBytes: 64, maxInFlightMessages: 4, maxChunkBytes: 8 });
      expect(host.attach('client-to-server', Uint8Array.from([1]), 'relay_a')).toBe(true);
      if (failure === 'stop') await host.stop();
      else worker.emit(failure, 1);
      expect(host.attach('client-to-server', Uint8Array.from([2]), 'relay_a')).toBe(false);
    }
  });

  it('resolves ready only after the worker reports its message loop', async () => {
    const { host, worker } = create(undefined);
    let settled = false;
    const ready = host.ready(100).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    worker.emit('message', { type: 'ready' });
    await ready;
    expect(settled).toBe(true);
    await host.stop();
  });
});
