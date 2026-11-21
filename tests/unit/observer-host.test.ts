import { describe, expect, it } from 'vitest';
import { ObserverWorkerHost, type WorkerLike } from '../../src/bridge/observer/host.js';
import type { ObserverEvent } from '../../src/bridge/observer/bounded.js';

class FakeWorker implements WorkerLike {
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly handlers = new Map<string, Set<(value?: unknown) => void>>();
  postMessage(value: unknown) { this.posted.push(value); }
  on(event: 'message' | 'error' | 'exit', listener: (value?: unknown) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(listener); this.handlers.set(event, set); return this; }
  emit(event: 'message' | 'error' | 'exit', value?: unknown) { for (const listener of this.handlers.get(event) ?? []) listener(value); }
  async terminate() { this.terminated = true; return 0; }
}

describe('observer worker host', () => {
  it('forwards chunks to the worker and surfaces only observation events', () => {
    const worker = new FakeWorker();
    const events: ObserverEvent[] = [];
    const failures: string[] = [];
    const host = new ObserverWorkerHost({ createWorker: () => worker, onEvent: event => events.push(event), onFailure: reason => failures.push(reason) });
    host.start();
    host.attach('client-to-server', new Uint8Array([1, 2]));
    expect(worker.posted[0]).toMatchObject({ type: 'chunk', direction: 'client-to-server' });
    worker.emit('message', { type: 'event', event: { kind: 'observer_gap', source: 'client', sessionEpoch: 's', gap: { scope: 'global', reason: 'frame-overflow' } } });
    expect(events).toHaveLength(1);
    worker.emit('error', new Error('boom'));
    expect(failures).toContain('observer-worker-error');
  });

  it('reports exit and stops idempotently without resending after stop', async () => {
    const worker = new FakeWorker();
    const failures: string[] = [];
    const host = new ObserverWorkerHost({ createWorker: () => worker, onEvent: () => {}, onFailure: reason => failures.push(reason) });
    host.start();
    worker.emit('exit', 1);
    expect(failures).toContain('observer-worker-exit');
    await host.stop();
    host.attach('server-to-client', new Uint8Array([1]));
    expect(worker.posted.filter(item => (item as { type?: string }).type === 'chunk')).toHaveLength(0);
    await host.stop();
  });

  it('does not crash the host when no worker can be created', async () => {
    const host = new ObserverWorkerHost({ createWorker: () => { throw new Error('spawn-denied'); }, onEvent: () => {} });
    expect(() => host.start()).toThrow('spawn-denied');
    await host.stop();
  });

  it('tracks phase and compression per direction without a shared flag', () => {
    const worker = new FakeWorker();
    const host = new ObserverWorkerHost({ createWorker: () => worker, onEvent: () => {} });
    host.start();
    worker.emit('message', { type: 'state', direction: 'server-to-client', state: { phase: 'PLAY', compression: 'enabled', byteOffset: '10', frameSequence: '4', availability: 'degraded' } });
    worker.emit('message', { type: 'state', direction: 'client-to-server', state: { phase: 'CONFIGURATION', compression: 'disabled', byteOffset: '7', frameSequence: '2', availability: 'degraded' } });
    const state = host.state();
    expect(state.directions['server-to-client']).toMatchObject({ phase: 'PLAY', compression: 'enabled', byteOffset: '10', frameSequence: '4' });
    expect(state.directions['client-to-server']).toMatchObject({ phase: 'CONFIGURATION', compression: 'disabled', byteOffset: '7', frameSequence: '2' });
    expect(state.phase).toBe('PLAY');
    expect(state.compression).toBe('enabled');
  });

  it('marks both directions unknown after worker loss and notifies every failure listener', async () => {
    const worker = new FakeWorker();
    const primary: string[] = [];
    const extra: string[] = [];
    const host = new ObserverWorkerHost({ createWorker: () => worker, onEvent: () => {}, onFailure: reason => primary.push(reason) });
    host.onFailure(reason => extra.push(reason));
    host.start();
    worker.emit('message', { type: 'state', direction: 'server-to-client', state: { availability: 'degraded', phase: 'PLAY' } });
    worker.emit('exit', 1);
    expect(primary).toEqual(['observer-worker-exit']);
    expect(extra).toEqual(['observer-worker-exit']);
    expect(host.state()).toMatchObject({ running: false, availability: 'unknown' });
    expect(host.state().directions['server-to-client'].availability).toBe('unknown');
    expect(host.state().directions['client-to-server'].availability).toBe('unknown');
    await host.stop();
  });
});
