import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { DirectionalFrameDecoder, encodeBoundedVarInt, readBoundedVarInt, type FrameBudget } from '../../src/bridge/observer/framing.js';

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
const uncompressedInCompressedFrame = (body: Buffer) => Buffer.concat([encodeBoundedVarInt(body.length), Buffer.from([0]), body]);

describe('bounded directional framing', () => {
  it('reassembles a VarInt and frame across byte-at-a-time chunks', () => {
    const decoder = new DirectionalFrameDecoder('client-to-server', budgets());
    const frame = plainFrame(Buffer.concat([Buffer.alloc(200, 1), Buffer.alloc(100, 2)]));
    const observed: number[] = [];
    for (let index = 0; index < frame.length; index += 1) {
      const result = decoder.attach(frame.subarray(index, index + 1));
      if (result.failure) throw new Error(result.failure.code);
      observed.push(...result.frames.map(item => item.payloadBytes));
    }
    expect(observed).toEqual([300]);
    expect(decoder.frameSequence).toBe('1');
    expect(decoder.byteOffset).toBe(String(frame.length));
  });

  it('waits on a truncated VarInt and frame without guessing', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    expect(decoder.attach(Buffer.from([0x80])).failure).toBeUndefined();
    expect(decoder.attach(Buffer.from([0x80])).failure).toBeUndefined();
    expect(decoder.bufferedBytes).toBe(2);
    expect(decoder.stopped).toBe(false);
  });

  it('rejects an over-long VarInt and stops interpreting', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    const result = decoder.attach(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01]));
    expect(result.failure?.code).toBe('varint-too-long');
    expect(decoder.stopped).toBe(true);
    expect(decoder.bufferedBytes).toBe(0);
    // No scanning for a plausible boundary after continuity is lost.
    expect(decoder.attach(Buffer.from([1, 9])).frames).toEqual([]);
  });

  it('detects a VarInt value overflow', () => {
    expect(readBoundedVarInt(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x7f]))).toMatchObject({ ok: false, code: 'overflow' });
  });

  it('rejects a frame larger than the declared budget', () => {
    const decoder = new DirectionalFrameDecoder('client-to-server', budgets({ maxFrameBytes: 4 }));
    const result = decoder.attach(Buffer.from([5, 1, 2, 3, 4, 5]));
    expect(result.failure?.code).toBe('frame-too-large');
    expect(decoder.stopped).toBe(true);
  });

  it('decodes multiple frames from one coalesced chunk with continuous offsets', () => {
    const decoder = new DirectionalFrameDecoder('client-to-server', budgets());
    const chunk = Buffer.concat([plainFrame(Buffer.from([1, 2])), plainFrame(Buffer.from([3])), plainFrame(Buffer.from([4, 5, 6]))]);
    const result = decoder.attach(chunk);
    expect(result.failure).toBeUndefined();
    expect(result.frames.map(frame => ({ sequence: frame.frameSequence, start: frame.offsetStart, end: frame.offsetEnd, bytes: frame.payloadBytes }))).toEqual([
      { sequence: '1', start: '0', end: '3', bytes: 2 },
      { sequence: '2', start: '3', end: '5', bytes: 1 },
      { sequence: '3', start: '5', end: '9', bytes: 3 },
    ]);
  });

  it('supports compressed framing with both stored and deflated bodies', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    decoder.setCompression(true, 64);
    const stored = Buffer.from([0xaa, 0xbb, 0xcc]);
    const deflatedBody = Buffer.concat([Buffer.alloc(200, 0x5a), Buffer.from([1, 2, 3])]);
    const result = decoder.attach(Buffer.concat([uncompressedInCompressedFrame(stored), compressedFrame(deflatedBody)]));
    expect(result.failure).toBeUndefined();
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]).toMatchObject({ compressed: false, payloadBytes: 3, compression: 'enabled' });
    expect(result.frames[1]).toMatchObject({ compressed: true, payloadBytes: deflatedBody.length });
    expect(result.frames[1]!.body).toEqual(deflatedBody);
  });

  it('rejects corrupt zlib data as unknown instead of forwarding a guessed frame', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    decoder.setCompression(true, 0);
    const payload = Buffer.concat([encodeBoundedVarInt(8), encodeBoundedVarInt(3), Buffer.from([1, 2, 3])]);
    const result = decoder.attach(payload);
    expect(result.failure?.code).toBe('invalid-zlib');
    expect(decoder.stopped).toBe(true);
  });

  it('checks the inflated length against the declared length', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    decoder.setCompression(true, 0);
    const data = deflateSync(Buffer.from([1, 2, 3, 4, 5]));
    const payload = Buffer.concat([encodeBoundedVarInt(6), encodeBoundedVarInt(data.length), data]);
    const result = decoder.attach(payload);
    expect(result.failure?.code).toBe('length-mismatch');
    expect(result.frames).toEqual([]);
  });

  it('rejects a declared decompressed length above the output budget before inflating', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets({ maxDecompressedBytes: 8 }));
    const result = decoder.attach(Buffer.from([9, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(result.failure?.code).toBe('decompressed-too-large');
  });

  it('accepts a legal high-compression sample and rejects a ratio above the configured ceiling', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets({ maxCompressionRatio: 10_000, compressionRatioFloorBytes: 512 }));
    decoder.setCompression(true, 0);
    const body = Buffer.alloc(2048, 0x2a); // extremely compressible but legitimate
    const accepted = decoder.attach(compressedFrame(body));
    expect(accepted.failure).toBeUndefined();
    expect(accepted.frames[0]?.payloadBytes).toBe(2048);

    const strict = new DirectionalFrameDecoder('server-to-client', budgets({ maxCompressionRatio: 8, compressionRatioFloorBytes: 512 }));
    strict.setCompression(true, 0);
    const rejected = strict.attach(compressedFrame(body));
    expect(rejected.failure?.code).toBe('ratio-exceeded');
    expect(strict.stopped).toBe(true);
  });

  it('enforces the decompression time budget', () => {
    let now = 0;
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets({ maxDecompressMs: 50 }), { now: () => { now += 100; return now; } });
    decoder.setCompression(true, 0);
    const result = decoder.attach(compressedFrame(Buffer.from([1, 2, 3])));
    expect(result.failure?.code).toBe('decompress-timeout');
  });

  it('keeps compression and phase independent between two directions', () => {
    const downstream = new DirectionalFrameDecoder('server-to-client', budgets());
    const upstream = new DirectionalFrameDecoder('client-to-server', budgets());
    downstream.setCompression(true, 0);
    downstream.setPhase('PLAY');
    const body = Buffer.from([0x10, 0x20, 0x30]);
    expect(downstream.attach(compressedFrame(body)).frames[0]).toMatchObject({ compression: 'enabled', phase: 'PLAY', body });
    expect(upstream.compression).toBe('disabled');
    expect(upstream.phase).toBe('UNKNOWN');
    expect(upstream.attach(plainFrame(body)).frames[0]).toMatchObject({ compression: 'disabled', phase: 'UNKNOWN' });
  });

  it('applies a recognised control event at the exact frame boundary', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets(), {
      recogniseControl: ({ body }) => body.equals(Buffer.from([0x7e])) ? { type: 'compression', enabled: true, threshold: 32 } : undefined,
    });
    const chunk = Buffer.concat([plainFrame(Buffer.from([0x7e])), compressedFrame(Buffer.from([1, 2, 3, 4]))]);
    const result = decoder.attach(chunk);
    expect(result.failure).toBeUndefined();
    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]).toMatchObject({ compressed: false, compression: 'enabled' });
    expect(result.frames[1]).toMatchObject({ compressed: true });
    expect(decoder.compressionThreshold).toBe(32);
  });

  it('stops interpreting when control continuity cannot be established', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets(), {
      recogniseControl: () => ({ type: 'control-unknown', reason: 'unrecognised-login-frame' }),
    });
    const result = decoder.attach(plainFrame(Buffer.from([1, 2, 3])));
    expect(result.stopped).toBe(true);
    expect(result.failure?.code).toBe('control-unknown');
    expect(result.frames).toEqual([]);
    expect(decoder.stopped).toBe(true);
  });

  it('treats a missing control recogniser result as unknown when the caller requests control', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets());
    decoder.control(undefined);
    expect(decoder.stopped).toBe(true);
    expect(decoder.stopReason).toBe('control-unknown');
  });

  it('rejects an invalid compression threshold and stays unknown', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets({ maxDecompressedBytes: 100 }));
    decoder.setCompression(true, 101);
    expect(decoder.stopped).toBe(true);
    expect(decoder.stopReason).toBe('compression-control-invalid');
  });

  it('reset clears stop state, buffers, offsets and direction-specific compression', () => {
    const decoder = new DirectionalFrameDecoder('server-to-client', budgets({ maxFrameBytes: 2 }));
    decoder.attach(Buffer.from([5, 1, 2, 3, 4, 5]));
    expect(decoder.stopped).toBe(true);
    decoder.reset();
    expect(decoder.stopped).toBe(false);
    expect(decoder.byteOffset).toBe('0');
    expect(decoder.frameSequence).toBe('0');
    expect(decoder.compression).toBe('disabled');
    expect(decoder.phase).toBe('UNKNOWN');
    const result = decoder.attach(plainFrame(Buffer.from([1])));
    expect(result.frames).toHaveLength(1);
  });
});
