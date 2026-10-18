import { describe, expect, it } from 'vitest';
import { createIpcEndpoint } from '../../src/bridge/ipc/endpoint.js';

class FakeChannel {
  readonly sent: unknown[] = [];
  private readonly handlers = new Map<string, Set<(value?: unknown) => void>>();
  disconnectCalls = 0;
  send(message: unknown) { this.sent.push(message); return true; }
  on(event: 'message' | 'disconnect', listener: (value?: unknown) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(listener); this.handlers.set(event, set); return this; }
  off(event: 'message' | 'disconnect', listener: (value?: unknown) => void) { this.handlers.get(event)?.delete(listener); return this; }
  disconnect() { this.disconnectCalls += 1; this.emit('disconnect', undefined); }
  count(event: 'message' | 'disconnect') { return this.handlers.get(event)?.size ?? 0; }
  emit(event: 'message' | 'disconnect', value: unknown) { for (const listener of this.handlers.get(event) ?? []) listener(value); }
  requestOf(index = 0) { return this.sent[index] as { requestId: string; sessionEpoch: string }; }
}

describe('IPC endpoint session fencing', () => {
  it('resolves a request only for its own session epoch', async () => {
    const channel = new FakeChannel();
    const endpoint = createIpcEndpoint(channel, { sessionEpoch: 'epoch-A' });
    const pending = endpoint.request({ command: 'status', payload: {}, requestId: 'req-1' });
    const request = channel.requestOf(0);
    expect(request.sessionEpoch).toBe('epoch-A');
    channel.emit('message', { type: 'response', protocolVersion: 1, requestId: 'req-1', sessionEpoch: 'epoch-OLD', ok: true, result: { stale: true } });
    const settled = await Promise.race([pending.then(() => 'settled'), new Promise<string>(r => setTimeout(() => r('pending'), 20))]);
    expect(settled).toBe('pending');
    channel.emit('message', { type: 'response', protocolVersion: 1, requestId: 'req-1', sessionEpoch: 'epoch-A', ok: true, result: { fresh: true } });
    await expect(pending).resolves.toEqual({ fresh: true });
    await endpoint.close();
  });

  it('rejects in-flight requests on disconnect and ignores late responses', async () => {
    const channel = new FakeChannel();
    const endpoint = createIpcEndpoint(channel, { sessionEpoch: 'epoch-B' });
    const pending = endpoint.request({ command: 'status', payload: {}, requestId: 'req-2' });
    channel.disconnect();
    await expect(pending).rejects.toThrow('ipc-disconnected');
    expect(endpoint.send({ type: 'event', protocolVersion: 1, sessionEpoch: 'epoch-B', event: 'diagnostic', payload: {} })).toBe(false);
  });

  it('FEC-048 close clears pending, listeners and channel handlers', async () => {
    const channel = new FakeChannel();
    const endpoint = createIpcEndpoint(channel, { sessionEpoch: 'epoch-C' });
    const received: unknown[] = [];
    endpoint.subscribe(message => received.push(message));
    const pending = endpoint.request({ command: 'status', payload: {}, requestId: 'req-3', timeoutMs: 10_000 });
    expect(channel.count('message')).toBe(1);
    expect(channel.count('disconnect')).toBe(1);
    expect(endpoint.queued()).toMatchObject({ inFlight: 1, sent: 1 });
    await endpoint.close();
    await expect(pending).rejects.toThrow('ipc-disconnected');
    expect(endpoint.queued()).toEqual({ inFlight: 0, sent: 0, queued: 0 });
    expect(channel.count('message')).toBe(0);
    expect(channel.count('disconnect')).toBe(0);
    channel.emit('message', { type: 'event', protocolVersion: 1, sessionEpoch: 'epoch-C', event: 'diagnostic', payload: {} });
    expect(received).toHaveLength(0);
    expect(endpoint.send({ type: 'event', protocolVersion: 1, sessionEpoch: 'epoch-C', event: 'diagnostic', payload: {} })).toBe(false);
    // Closing twice is idempotent and does not re-run disconnect handling.
    await endpoint.close();
    expect(channel.disconnectCalls).toBe(1);
  });

  it('FEC-050 backpressure counts the real outstanding queue instead of resetting synchronously', async () => {
    const channel = new FakeChannel();
    const endpoint = createIpcEndpoint(channel, { sessionEpoch: 'epoch-D', maxQueuedMessages: 2 });
    const first = endpoint.request({ command: 'status', payload: {}, requestId: 'q-1', timeoutMs: 10_000 });
    const second = endpoint.request({ command: 'status', payload: {}, requestId: 'q-2', timeoutMs: 10_000 });
    expect(endpoint.queued()).toEqual({ inFlight: 2, sent: 2, queued: 2 });
    await expect(endpoint.request({ command: 'status', payload: {}, requestId: 'q-3' })).rejects.toThrow('ipc-backpressure');
    // Completing one request frees exactly one slot.
    channel.emit('message', { type: 'response', protocolVersion: 1, requestId: 'q-1', sessionEpoch: 'epoch-D', ok: true, result: { ok: 1 } });
    await expect(first).resolves.toEqual({ ok: 1 });
    expect(endpoint.queued()).toEqual({ inFlight: 1, sent: 1, queued: 1 });
    const third = endpoint.request({ command: 'status', payload: {}, requestId: 'q-3', timeoutMs: 10_000 });
    expect(channel.sent).toHaveLength(3);
    // Timeouts also release the slot.
    channel.emit('message', { type: 'response', protocolVersion: 1, requestId: 'q-2', sessionEpoch: 'epoch-D', ok: true, result: {} });
    await expect(second).resolves.toEqual({});
    const short = endpoint.request({ command: 'status', payload: {}, requestId: 'q-4', timeoutMs: 10 });
    await expect(short).rejects.toThrow('ipc-timeout');
    expect(endpoint.queued()).toEqual({ inFlight: 1, sent: 1, queued: 1 });
    expect(endpoint.send({ type: 'event', protocolVersion: 1, sessionEpoch: 'epoch-D', event: 'diagnostic', payload: {} })).toBe(true);
    channel.emit('message', { type: 'response', protocolVersion: 1, requestId: 'q-3', sessionEpoch: 'epoch-D', ok: true, result: {} });
    await expect(third).resolves.toEqual({});
    expect(endpoint.queued()).toEqual({ inFlight: 0, sent: 0, queued: 0 });
    await endpoint.close();
  });
});
