import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { DirectionalFrameDecoder, encodeBoundedVarInt, type FrameBudget } from '../../src/bridge/observer/framing.js';
import { createBoundedObserver } from '../../src/bridge/observer/bounded.js';
import { ObserverWorkerHost, type WorkerLike } from '../../src/bridge/observer/host.js';

const budgets = (overrides: Partial<FrameBudget> = {}): Partial<FrameBudget> => ({
  maxVarIntBytes: 5,
  maxFrameBytes: 4096,
  maxDecompressedBytes: 65536,
  maxCompressionRatio: 256,
  compressionRatioFloorBytes: 1024,
  maxDecompressMs: 1000,
  ...overrides,
});

/** Build compression-enabled frame bytes with an optional trailing payload. */
const frame = (body: Buffer, options: { declaredLength?: number; trailing?: Buffer } = {}) => {
  const data = deflateSync(body);
  const payload = options.trailing ? Buffer.concat([data, options.trailing]) : data;
  const decoded = encodeBoundedVarInt(options.declaredLength ?? body.length);
  return Buffer.concat([encodeBoundedVarInt(decoded.length + payload.length), decoded, payload]);
};
const storedFrame = (body: Buffer) => Buffer.concat([encodeBoundedVarInt(body.length + 1), Buffer.from([0]), body]);

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

describe('S02 compression boundaries', () => {
  it('rejects a compressed payload whose declared decoded length is below a nonzero threshold', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    decoder.setCompression(true, 64);
    const result = decoder.attach(frame(Buffer.alloc(8, 0x41)));
    expect(result.failure?.code).toBe('compressed-below-threshold');
    expect(result.frames).toEqual([]);
    expect(decoder.stopped).toBe(true);
  });

  it('allows a zero-length stored marker below a nonzero threshold', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    decoder.setCompression(true, 64);
    const result = decoder.attach(storedFrame(Buffer.from([1, 2, 3])));
    expect(result.failure).toBeUndefined();
    expect(result.frames[0]).toMatchObject({ compressed: false, payloadBytes: 3 });
  });

  it('accepts a compressed payload at or above the threshold', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    decoder.setCompression(true, 64);
    const body = Buffer.alloc(64, 0x5a);
    const result = decoder.attach(frame(body));
    expect(result.failure).toBeUndefined();
    expect(result.frames[0]?.body).toEqual(body);
  });

  it('detects zlib trailing bytes inside the declared compressed payload', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    decoder.setCompression(true, 0);
    const result = decoder.attach(frame(Buffer.from([1, 2, 3]), { trailing: Buffer.from([0xde, 0xad]) }));
    expect(result.failure?.code).toBe('zlib-trailing-bytes');
    expect(result.frames).toEqual([]);
    expect(decoder.stopReason).toBe('zlib-trailing-bytes');
  });

  it('distinguishes an output-cap failure from corrupt zlib input', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    decoder.setCompression(true, 0);
    // Declares three decoded bytes but the stream actually expands to six.
    const result = decoder.attach(frame(Buffer.from([1, 2, 3, 4, 5, 6]), { declaredLength: 3 }));
    expect(result.failure?.code).toBe('decompressed-too-large');
    expect(result.failure?.code).not.toBe('invalid-zlib');
  });

  it('keeps injected inflate helpers Buffer-compatible', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets(), {
      inflate: () => Buffer.from([9, 9, 9]),
    });
    decoder.setCompression(true, 0);
    const data = deflateSync(Buffer.from([1]));
    const decoded = encodeBoundedVarInt(3);
    const result = decoder.attach(Buffer.concat([encodeBoundedVarInt(decoded.length + data.length), decoded, data]));
    expect(result.failure).toBeUndefined();
    expect(result.frames[0]?.body).toEqual(Buffer.from([9, 9, 9]));
  });

  it('exposes compressionThreshold in observer and worker-host state', () => {
    const observer = createBoundedObserver();
    observer.setCompression('server-to-client', true, 32);
    expect(observer.state().upstream.compressionThreshold).toBe(32);
    expect(observer.state().downstream.compressionThreshold).toBeNull();

    const worker = new FakeWorker();
    const host = new ObserverWorkerHost({ createWorker: () => worker, onEvent: () => {} });
    host.start();
    worker.emit('message', { type: 'state', direction: 'server-to-client', state: { compression: 'enabled', compressionThreshold: 32, availability: 'degraded' } });
    expect(host.state().compressionThreshold).toBe(32);
    expect(host.state().directions['server-to-client'].compressionThreshold).toBe(32);
  });
});
