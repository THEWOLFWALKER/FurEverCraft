import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { createBoundedObserver } from '../../src/bridge/observer/bounded.js';

const tick = () => new Promise<void>(r => setImmediate(r));
const compressedFrame = (body: Buffer) => {
  const data = deflateSync(body);
  return Buffer.concat([Buffer.from([body.length]), Buffer.from([data.length]), data]);
};

describe('bounded observer', () => {
  it('assembles fragmented frames and preserves direction state', async () => {
    const observer = createBoundedObserver();
    const events: any[] = [];
    observer.subscribe(e => events.push(e));
    observer.attach('client-to-server', Buffer.from([3, 1]));
    observer.attach('client-to-server', Buffer.from([2, 3, 9]));
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'observation', direction: 'client-to-server', frameSequence: '1' });
    expect(observer.state().downstream.byteOffset).toBe('5');
  });

  it('turns an over-budget frame into an explicit global unknown gap', () => {
    const observer = createBoundedObserver({ maxFrameBytes: 2 });
    const events: any[] = [];
    observer.subscribe(e => events.push(e));
    observer.attach('server-to-client', Buffer.from([3, 1, 2, 3]));
    expect(observer.health).toBe('unknown');
    expect(events[0]).toMatchObject({ kind: 'observer_gap', gap: { scope: 'global', reason: 'frame-too-large' } });
    expect(observer.state().upstream).toMatchObject({ phase: 'UNKNOWN', availability: 'unknown', stoppedReason: 'frame-too-large' });
    // Once framing continuity is lost the observer stops interpreting rather than scanning.
    observer.attach('server-to-client', Buffer.from([1, 7]));
    expect(events.filter(event => event.kind === 'observation')).toHaveLength(0);
  });

  it('reports precise per-frame offsets for multiple frames in one chunk', async () => {
    const observer = createBoundedObserver();
    const observed: any[] = [];
    observer.subscribe(e => { if (e.kind === 'observation') observed.push(e); });
    observer.attach('client-to-server', Buffer.from([2, 1, 1, 3, 2, 2, 2]));
    await tick();
    expect(observed.map(e => [e.frameSequence, e.payload.offsetStart, e.payload.offsetEnd])).toEqual([['1', '0', '3'], ['2', '3', '7']]);
  });

  it('enforces the pending frame queue and gap rather than emitting unbounded', async () => {
    const observer = createBoundedObserver({ maxQueuedFrames: 1, taskTimeoutMs: 50 });
    const observed: any[] = [];
    observer.subscribe(async e => { if (e.kind === 'observation') { observed.push(e); await new Promise(r => setTimeout(r, 30)); } });
    observer.attach('client-to-server', Buffer.from([1, 1, 1, 2, 2, 2]));
    observer.attach('client-to-server', Buffer.from([3, 3, 3]));
    await new Promise(r => setTimeout(r, 120));
    expect(observed.length).toBeLessThan(3);
    expect(observer.health).not.toBe('healthy');
  });

  it('keeps global framing loss sticky until an explicit reset', async () => {
    const observer = createBoundedObserver({ maxFrameBytes: 1, maxQueuedFrames: 16 });
    const events: any[] = [];
    observer.subscribe(e => events.push(e));
    observer.attach('client-to-server', Buffer.from([9, 1, 2, 3]));
    expect(observer.state().downstream.phase).toBe('UNKNOWN');
    observer.attach('client-to-server', Buffer.from([1, 7]));
    await tick();
    expect(events.filter(e => e.kind === 'observation')).toHaveLength(0);
    observer.reset('client-to-server');
    observer.attach('client-to-server', Buffer.from([1, 7]));
    await tick();
    expect(events.filter(e => e.kind === 'observation')).toHaveLength(1);
  });

  it('starts with an unknown phase and independent disabled compression per direction', () => {
    const observer = createBoundedObserver();
    const state = observer.state();
    for (const direction of ['upstream', 'downstream'] as const) {
      expect(state[direction]).toMatchObject({ phase: 'UNKNOWN', compression: 'disabled', payloadKind: 'frame-metadata', availability: 'degraded' });
    }
    // A compression event on one direction must not change the other.
    observer.setCompression('server-to-client', true, 64);
    expect(observer.state().upstream).toMatchObject({ compression: 'enabled' });
    expect(observer.state().downstream).toMatchObject({ compression: 'disabled' });
    // Framing loss is the only known unknown; it is not silently rewritten as a phase.
    observer.markUnknown('framing-loss', 'client-to-server');
    expect(observer.state().downstream).toMatchObject({ phase: 'UNKNOWN', availability: 'unknown' });
  });

  it('reset clears only the selected direction and no longer reports global unknown', async () => {
    const observer = createBoundedObserver({ maxQueuedFrames: 1, taskTimeoutMs: 50 });
    observer.subscribe(async () => { await new Promise(r => setTimeout(r, 20)); });
    observer.attach('client-to-server', Buffer.from([1, 1, 1, 2]));
    await new Promise(r => setTimeout(r, 60));
    expect(observer.health).toBe('unknown');
    observer.reset('client-to-server');
    // The untouched direction has never had a phase anchor, so the observer stays degraded
    // rather than claiming health it cannot prove.
    expect(observer.health).toBe('degraded');
    expect(observer.state().downstream).toMatchObject({ availability: 'degraded' });
  });

  it('publishes frame metadata only and never claims a decoded packet ID or fields', async () => {
    const observer = createBoundedObserver();
    const observed: any[] = [];
    observer.subscribe(e => { if (e.kind === 'observation') observed.push(e); });
    // [length=2][packet-id byte 0x05][payload 0x33] - the leading VarInt is framing, not a packet ID.
    observer.attach('server-to-client', Buffer.from([2, 5, 0x33]));
    await tick();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'observation', direction: 'server-to-client', frameSequence: '1', phase: 'UNKNOWN', availability: 'degraded', payload: { kind: 'frame-metadata', bytes: 3, offsetStart: '0', offsetEnd: '3' } });
    expect(observed[0].payload).not.toHaveProperty('packetId');
    expect(observed[0].payload).not.toHaveProperty('fields');
    expect(JSON.stringify(observed[0])).not.toContain('packetId');
    expect(observer.state().upstream.phase).not.toBe('PLAY');
  });

  it('decodes compressed server frames while client frames stay uncompressed', async () => {
    const observer = createBoundedObserver();
    const observed: any[] = [];
    observer.subscribe(e => { if (e.kind === 'observation') observed.push(e); });
    observer.setCompression('server-to-client', true, 0);
    const body = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    observer.attach('server-to-client', compressedFrame(body));
    observer.attach('client-to-server', Buffer.from([2, 0xaa, 0xbb]));
    await tick();
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({ direction: 'server-to-client', compression: 'enabled', payload: { compressed: true, payloadBytes: body.length } });
    expect(observed[1]).toMatchObject({ direction: 'client-to-server', compression: 'disabled', payload: { compressed: false, payloadBytes: 2 } });
    expect(observer.state().upstream.compression).toBe('enabled');
    expect(observer.state().downstream.compression).toBe('disabled');
  });

  it('resets frame sequence and offsets for one direction without touching the other', async () => {
    const observer = createBoundedObserver();
    const observed: any[] = [];
    observer.subscribe(e => { if (e.kind === 'observation') observed.push(e); });
    observer.attach('client-to-server', Buffer.from([1, 1]));
    observer.attach('server-to-client', Buffer.from([1, 9]));
    await tick();
    observer.reset('client-to-server');
    observer.attach('client-to-server', Buffer.from([1, 2]));
    await tick();
    expect(observer.state().downstream.frameSequence).toBe('1');
    expect(observer.state().downstream.byteOffset).toBe('2');
    expect(observer.state().upstream.frameSequence).toBe('1');
    expect(observed.map(event => event.frameSequence)).toEqual(['1', '1', '1']);
  });
});
