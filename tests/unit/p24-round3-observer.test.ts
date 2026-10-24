import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  BoundedObserver,
  createBoundedObserver,
  type ObserverEvent,
} from '../../src/bridge/observer/bounded.js';
import {
  DirectionalFrameDecoder,
  encodeBoundedVarInt,
  type FrameBudget,
} from '../../src/bridge/observer/framing.js';
import { ObserverWorkerHost, type WorkerLike } from '../../src/bridge/observer/host.js';
import { createRelayObserverPublisher } from '../../src/bridge/relay/entry.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const budgets = (overrides: Partial<FrameBudget> = {}): Partial<FrameBudget> => ({
  maxVarIntBytes: 5,
  maxFrameBytes: 4096,
  maxDecompressedBytes: 65536,
  maxCompressionRatio: 256,
  compressionRatioFloorBytes: 1024,
  maxDecompressMs: 1000,
  ...overrides,
});
const plainFrame = (body: Buffer) => Buffer.concat([encodeBoundedVarInt(body.length), body]);
const compressedFrame = (body: Buffer) => {
  const data = deflateSync(body);
  return Buffer.concat([encodeBoundedVarInt(body.length), encodeBoundedVarInt(data.length), data]);
};

/**
 * Round 3 observer regressions. Control packets used below are synthetic markers with no
 * relationship to 26.3 packet IDs; production recognition remains blocked on the missing
 * 26.3 schema (see report).
 */

describe('Round 3 — observer compression truthfulness', () => {
  it('starts unknown, parses only under a reported assumed-uncompressed framing', async () => {
    const observer = createBoundedObserver();
    const observed: ObserverEvent[] = [];
    observer.subscribe(event => { observed.push(event); });
    expect(observer.state().upstream).toMatchObject({
      compression: 'unknown', assumedCompression: 'uncompressed', phase: 'UNKNOWN',
    });
    observer.attach('server-to-client', plainFrame(Buffer.from([1, 2, 3])));
    await tick();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      kind: 'observation', compression: 'unknown', compressionAssumed: 'uncompressed',
      payload: { compressed: false },
    });
    // It is never presented as a confirmed `disabled` framing.
    expect(observed[0]).not.toMatchObject({ compression: 'disabled' });
  });

  it('switches per-direction compression at a synthetic recognised control event and decompresses later frames', async () => {
    // Synthetic marker only: this is NOT a 26.3 packet ID.
    const syntheticEnableCompression = Buffer.from([0x42, 0x42]);
    const observer = createBoundedObserver({
      recogniseControl: ({ body, compressed }) => !compressed && body.equals(syntheticEnableCompression)
        ? { type: 'compression', enabled: true, threshold: 0 }
        : undefined,
    });
    const observed: ObserverEvent[] = [];
    observer.subscribe(event => { observed.push(event); });
    const body = Buffer.from([1, 2, 3, 4]);
    observer.attach('server-to-client', Buffer.concat([plainFrame(syntheticEnableCompression), compressedFrame(body)]));
    await tick();
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({ direction: 'server-to-client', compression: 'enabled', payload: { compressed: false } });
    expect(observed[1]).toMatchObject({ direction: 'server-to-client', compression: 'enabled', payload: { compressed: true, payloadBytes: body.length } });
    // The other direction is unaffected and remains under its own assumption.
    expect(observer.state().downstream).toMatchObject({ compression: 'unknown', assumedCompression: 'uncompressed' });
  });

  it('applies an explicit compression control event and then decompresses subsequent frames', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    expect(decoder.compression).toBe('unknown');
    decoder.control({ type: 'compression', enabled: true, threshold: 0 });
    const body = Buffer.from([9, 8, 7, 6, 5]);
    const result = decoder.attach(compressedFrame(body));
    expect(result.failure).toBeUndefined();
    expect(result.frames[0]).toMatchObject({ compression: 'enabled', compressed: true, body });
    expect(result.frames[0]?.compressionAssumed).toBeUndefined();
  });

  it('reaches compression-unknown and stops interpretation instead of guessing after an unrecognised transition', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    // Synthetic declaration: a transition happened but its new state is unknown.
    decoder.control({ type: 'compression', enabled: 'unknown', reason: 'synthetic-unrecognised-transition' });
    expect(decoder.compression).toBe('unknown');
    const result = decoder.attach(plainFrame(Buffer.from([1, 2, 3])));
    expect(result.failure?.code).toBe('compression-unknown');
    expect(result.frames).toEqual([]);
    expect(decoder.stopped).toBe(true);
    // No later frame is guessed either.
    expect(decoder.attach(plainFrame(Buffer.from([4]))).frames).toEqual([]);
  });
});

describe('Round 3 — global observer gaps are sticky', () => {
  it('stops the rest of an overflowing chunk, skips drain, and parks both directions until reset', async () => {
    const observer = createBoundedObserver({ maxQueuedFrames: 1, taskTimeoutMs: 50 });
    const observations: ObserverEvent[] = [];
    const gaps: ObserverEvent[] = [];
    observer.subscribe(event => { (event.kind === 'observation' ? observations : gaps).push(event); });
    // Three complete frames in one attach chunk. The second overflows the queue; the third
    // must not be enqueued or delivered, and no drain may start for the chunk.
    observer.attach('client-to-server', Buffer.from([1, 1, 1, 2, 1, 3]));
    await tick();
    expect(observations).toHaveLength(0);
    expect(observer.queued().frames).toBe(0);
    expect(gaps.filter(event => event.kind === 'observer_gap' && event.gap.scope === 'global' && event.gap.reason === 'queue-overflow')).toHaveLength(1);
    expect(observer.health).toBe('unknown');
    expect(observer.state().downstream.availability).toBe('unknown');
    expect(observer.state().upstream.availability).toBe('unknown');

    // Both directions are parked: no post-gap observation is emitted.
    observer.attach('client-to-server', Buffer.from([1, 9]));
    observer.attach('server-to-client', Buffer.from([1, 9]));
    await tick();
    expect(observations).toHaveLength(0);

    // Only an explicit reset/resync resumes observation.
    observer.reset('client-to-server');
    observer.attach('client-to-server', Buffer.from([1, 7]));
    await tick();
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ direction: 'client-to-server', frameSequence: '1' });
  });

  it('drops pending frames for both directions when one decoder loses framing continuity', async () => {
    const observer = createBoundedObserver({ maxFrameBytes: 2 });
    const observations: ObserverEvent[] = [];
    observer.subscribe(event => { if (event.kind === 'observation') observations.push(event); });
    observer.attach('server-to-client', Buffer.from([3, 1, 2, 3]));
    expect(observer.health).toBe('unknown');
    observer.attach('client-to-server', Buffer.from([1, 5]));
    await tick();
    expect(observations).toHaveLength(0);
    expect(observer.state().downstream.availability).toBe('unknown');
  });
});

class FakeWorker implements WorkerLike {
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly handlers = new Map<string, Set<(value?: unknown) => void>>();
  postMessage(value: unknown) { this.posted.push(value); }
  on(event: 'message' | 'error' | 'exit', listener: (value?: unknown) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(listener); this.handlers.set(event, set); return this; }
  emit(event: 'message' | 'error' | 'exit', value?: unknown) { for (const listener of this.handlers.get(event) ?? []) listener(value); }
  async terminate() { this.terminated = true; return 0; }
  chunks() { return this.posted.filter(item => (item as { type?: string }).type === 'chunk'); }
}

describe('Round 3 — bounded observer host accounting and availability', () => {
  it('bounds relay-to-worker unacknowledged chunks and reports a gap/failure on excess', async () => {
    const worker = new FakeWorker();
    const events: ObserverEvent[] = [];
    const failures: string[] = [];
    const host = new ObserverWorkerHost({
      createWorker: () => worker,
      onEvent: event => events.push(event),
      onFailure: reason => failures.push(reason),
      maxUnackedBytes: 4,
      maxUnackedFrames: 2,
    });
    host.start();
    expect(host.attach('client-to-server', new Uint8Array([1]))).toBe(true);
    expect(host.attach('client-to-server', new Uint8Array([2, 3]))).toBe(true);
    // Third unacked chunk exceeds both the frame and byte budget.
    expect(host.attach('client-to-server', new Uint8Array([4, 5]))).toBe(false);
    expect(worker.chunks()).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ kind: 'observer_gap', gap: { scope: 'global', reason: 'observer-attach-backpressure', direction: 'client-to-server' } });
    expect(failures).toContain('observer-attach-backpressure');
    expect(host.state().directions['client-to-server']).toMatchObject({ availability: 'unknown', stoppedReason: 'observer-attach-backpressure' });
    expect(host.state().availability).toBe('unknown');
    // The stopped direction stays stopped even after acks free the budget.
    worker.emit('message', { type: 'ack', direction: 'client-to-server', bytes: 3, frames: 2 });
    expect(host.attach('client-to-server', new Uint8Array([6]))).toBe(false);
    host.reset('client-to-server');
    expect(host.attach('client-to-server', new Uint8Array([6]))).toBe(true);
    await host.stop();
  });

  it('reports aggregate unknown availability when one direction is unknown even though the worker is running', () => {
    const worker = new FakeWorker();
    const host = new ObserverWorkerHost({ createWorker: () => worker, onEvent: () => {} });
    host.start();
    worker.emit('message', { type: 'state', direction: 'server-to-client', state: { availability: 'degraded', phase: 'PLAY', compression: 'enabled' } });
    worker.emit('message', { type: 'state', direction: 'client-to-server', state: { availability: 'degraded', phase: 'PLAY', compression: 'disabled' } });
    expect(host.state().availability).toBe('degraded');
    expect(host.state().limitation).toBe('packet-decoding-unsupported');
    worker.emit('message', { type: 'state', direction: 'client-to-server', state: { availability: 'unknown', phase: 'PLAY', compression: 'unknown', stoppedReason: 'decoder-stopped' } });
    expect(host.state().running).toBe(true);
    expect(host.state().availability).toBe('unknown');
    expect(host.state().limitation).toBe('phase-compression-unknown');
  });

  it('never presents a fresh worker as having confirmed compression', () => {
    const worker = new FakeWorker();
    const host = new ObserverWorkerHost({ createWorker: () => worker, onEvent: () => {} });
    host.start();
    expect(host.state()).toMatchObject({ availability: 'unknown', compression: 'unknown', limitation: 'phase-compression-unknown' });
    expect(host.state().directions['server-to-client']).toMatchObject({ compression: 'unknown', assumedCompression: 'uncompressed' });
  });
});

describe('Round 3 — relay IPC backpressure is explicit and bounded', () => {
  it('coalesces dropped observations into one explicit global gap without queueing forwarding data', () => {
    let accept = false;
    const sent: Array<Record<string, any>> = [];
    const publisher = createRelayObserverPublisher(
      // A throw is the only rejection signal; false would mean "queued" (see Round 5).
      { send: message => { if (!accept) throw new Error('channel-unavailable'); sent.push(message as Record<string, any>); return true; } },
      'relay_synthetic_session',
    );
    const observation = (frameSequence: string): ObserverEvent => ({
      kind: 'observation', source: 'client', sessionEpoch: 'observer_synthetic', direction: 'client-to-server',
      frameSequence, phase: 'UNKNOWN', compression: 'unknown', availability: 'degraded',
      payload: { kind: 'frame-metadata', bytes: 2, payloadBytes: 1, offsetStart: '0', offsetEnd: '2', compressed: false },
    });
    publisher.event(observation('1'));
    expect(publisher.pending()).toEqual({ dropped: 1 });
    publisher.event(observation('2'));
    publisher.event(observation('3'));
    // No observation is queued while pressured; only the coalesced gap remains pending.
    expect(sent).toHaveLength(0);
    expect(publisher.pending()).toEqual({ dropped: 3 });
    accept = true;
    publisher.flushGap();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event: 'observer',
      payload: { kind: 'observer_gap', gap: { scope: 'global', reason: 'relay-ipc-backpressure', dropped: 3 } },
    });
    expect(publisher.pending()).toBeUndefined();
    // Observation forwarding resumes after the gap is delivered.
    publisher.event(observation('4'));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ event: 'observer', payload: { kind: 'observation', frameSequence: '4' } });
  });
});

describe('Round 3 — bounded observer assumption is observable in state', () => {
  it('exposes the assumed-uncompressed framing until a control event confirms compression', () => {
    const observer: BoundedObserver = createBoundedObserver();
    expect(observer.state().upstream).toMatchObject({ compression: 'unknown', assumedCompression: 'uncompressed' });
    observer.control('server-to-client', { type: 'compression', enabled: true, threshold: 0 });
    expect(observer.state().upstream).toMatchObject({ compression: 'enabled' });
    expect(observer.state().upstream).not.toHaveProperty('assumedCompression');
    observer.control('server-to-client', { type: 'compression', enabled: 'unknown', reason: 'synthetic-unrecognised-transition' });
    expect(observer.state().upstream).toMatchObject({ compression: 'unknown' });
    expect(observer.state().upstream).not.toHaveProperty('assumedCompression');
  });
});
