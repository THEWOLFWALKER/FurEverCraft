import { describe, expect, it } from 'vitest';
import { createIpcEndpoint } from '../../src/bridge/ipc/endpoint.js';

class FakeChannel {
  readonly sent: unknown[] = [];
  private readonly handlers = new Map<string, Set<(value?: unknown) => void>>();
  send(message: unknown) { this.sent.push(message); return true; }
  on(event: 'message' | 'disconnect', listener: (value?: unknown) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(listener); this.handlers.set(event, set); return this; }
  off(event: 'message' | 'disconnect', listener: (value?: unknown) => void) { this.handlers.get(event)?.delete(listener); return this; }
  disconnect() { this.emit('disconnect', undefined); }
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
});
