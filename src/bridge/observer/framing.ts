import { inflateSync } from 'node:zlib';

/**
 * Incremental, bounded frame tracker for one TCP direction.
 *
 * The tracker understands only the version-independent framing rules:
 *   - an outer VarInt frame length (compression disabled), or
 *   - packetLength + dataLength (compression enabled, dataLength === 0 means the
 *     packet body is stored uncompressed inside the compressed framing).
 *
 * It does not guess 26.3 packet IDs, phases or compression-notification bodies.
 * Compression/phase changes are applied only through an explicit control event
 * (from an injected recognizer or the public control API). When control
 * continuity cannot be established the direction stops interpreting and stays
 * unknown instead of scanning bytes for a plausible boundary.
 */
export type ObserverDirection = 'client-to-server' | 'server-to-client';
export type ObserverPhase = 'HANDSHAKE' | 'STATUS' | 'LOGIN' | 'CONFIGURATION' | 'PLAY' | 'UNKNOWN';
export type ObserverPhaseState = ObserverPhase;
export type ObserverCompressionState = 'disabled' | 'enabled' | 'unknown';

export type ControlEvent =
  | { type: 'compression'; enabled: true; threshold: number }
  | { type: 'compression'; enabled: false }
  | { type: 'phase'; phase: ObserverPhase }
  | { type: 'control-unknown'; reason?: string };

export type ControlEventRecognizer = (input: {
  direction: ObserverDirection;
  body: Buffer;
  compressed: boolean;
  phase: ObserverPhase;
  compression: ObserverCompressionState;
}) => ControlEvent | undefined;

export type FrameBudget = {
  maxVarIntBytes: number;
  maxFrameBytes: number;
  maxDecompressedBytes: number;
  maxCompressionRatio: number;
  compressionRatioFloorBytes: number;
  maxDecompressMs: number;
};

export type FrameFailureCode =
  | 'varint-incomplete'
  | 'varint-too-long'
  | 'varint-overflow'
  | 'frame-too-large'
  | 'decompressed-too-large'
  | 'compression-unknown'
  | 'compression-control-invalid'
  | 'control-unknown'
  | 'length-mismatch'
  | 'invalid-zlib'
  | 'ratio-exceeded'
  | 'decompress-timeout';

export type DecodedFrame = {
  direction: ObserverDirection;
  frameSequence: string;
  offsetStart: string;
  offsetEnd: string;
  frameBytes: number;
  payloadBytes: number;
  compressed: boolean;
  body: Buffer;
  phase: ObserverPhase;
  compression: ObserverCompressionState;
};

export type FrameDecodeResult = {
  frames: DecodedFrame[];
  failure?: { code: FrameFailureCode; reason: string };
  stopped: boolean;
};

export type VarIntResult =
  | { ok: true; value: number; size: number }
  | { ok: false; code: 'incomplete' | 'too-long' | 'overflow'; size: number };

export function readBoundedVarInt(buffer: Buffer, offset = 0, maxBytes = 5): VarIntResult {
  let value = 0;
  for (let index = 0; index < maxBytes; index += 1) {
    if (offset + index >= buffer.length) return { ok: false, code: 'incomplete', size: index };
    const byte = buffer[offset + index]!;
    value += (byte & 0x7f) * 2 ** (7 * index);
    if ((byte & 0x80) === 0) {
      if (value > 0xffffffff) return { ok: false, code: 'overflow', size: index + 1 };
      return { ok: true, value, size: index + 1 };
    }
  }
  return { ok: false, code: 'too-long', size: maxBytes };
}

const defaultBudget: FrameBudget = {
  maxVarIntBytes: 5,
  maxFrameBytes: 8 * 1024 * 1024,
  maxDecompressedBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 256,
  compressionRatioFloorBytes: 1024 * 1024,
  maxDecompressMs: 2_000,
};

const phaseState = (phase: ObserverPhase | 'unknown'): ObserverPhase => (phase === 'unknown' ? 'UNKNOWN' : phase);

export class DirectionalFrameDecoder {
  private buffer = Buffer.alloc(0);
  private byteOffsetValue = 0n;
  private frameSequenceValue = 0n;
  private phaseValue: ObserverPhase | 'unknown' = 'unknown';
  private compressionValue: ObserverCompressionState = 'disabled';
  private thresholdValue: number | null = null;
  private stoppedReason?: string;
  private readonly budget: FrameBudget;
  private readonly now: () => number;

  constructor(
    readonly direction: ObserverDirection,
    budget: Partial<FrameBudget> = {},
    private readonly options: {
      recogniseControl?: ControlEventRecognizer;
      inflate?: (data: Buffer, maxOutputLength: number) => Buffer;
      now?: () => number;
    } = {},
  ) {
    this.budget = { ...defaultBudget, ...budget };
    this.now = options.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
  }

  get phase(): ObserverPhase { return phaseState(this.phaseValue); }
  get compression(): ObserverCompressionState { return this.compressionValue; }
  get compressionThreshold(): number | null { return this.thresholdValue; }
  get byteOffset(): string { return this.byteOffsetValue.toString(); }
  get frameSequence(): string { return this.frameSequenceValue.toString(); }
  get bufferedBytes(): number { return this.buffer.length; }
  get stopReason(): string | undefined { return this.stoppedReason; }
  get stopped(): boolean { return this.stoppedReason !== undefined; }

  /**
   * Apply a recognised control event to this direction only. `undefined` means the
   * caller expected a control event but could not identify it: interpretation stops.
   */
  control(event: ControlEvent | undefined): void {
    if (!event) { this.markUnknown('control-unknown'); return; }
    if (this.stopped) return;
    if (event.type === 'control-unknown') { this.markUnknown(event.reason ?? 'control-unknown'); return; }
    if (event.type === 'phase') { this.phaseValue = event.phase; return; }
    if (event.enabled) {
      if (!Number.isInteger(event.threshold) || event.threshold < 0 || event.threshold > this.budget.maxDecompressedBytes) {
        this.markUnknown('compression-control-invalid');
        return;
      }
      this.compressionValue = 'enabled';
      this.thresholdValue = event.threshold;
    } else {
      this.compressionValue = 'disabled';
      this.thresholdValue = null;
    }
  }

  setCompression(enabled: boolean, threshold = 0): void {
    this.control(enabled ? { type: 'compression', enabled: true, threshold } : { type: 'compression', enabled: false });
  }

  setPhase(phase: ObserverPhase): void { this.control({ type: 'phase', phase }); }

  markUnknown(reason: string): void {
    if (this.stopped) return;
    this.stoppedReason = reason;
    this.buffer = Buffer.alloc(0);
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.byteOffsetValue = 0n;
    this.consumedOffset = 0n;
    this.frameSequenceValue = 0n;
    this.phaseValue = 'unknown';
    this.compressionValue = 'disabled';
    this.thresholdValue = null;
    this.stoppedReason = undefined;
  }

  attach(chunk: Uint8Array): FrameDecodeResult {
    if (this.stopped) return { frames: [], stopped: true };
    const incoming = Buffer.from(chunk);
    this.byteOffsetValue += BigInt(incoming.length);
    const combined = this.buffer.length === 0 ? incoming : Buffer.concat([this.buffer, incoming]);
    this.buffer = combined;
    const frames: DecodedFrame[] = [];

    while (this.buffer.length > 0 && !this.stopped) {
      const outer = readBoundedVarInt(this.buffer, 0, this.budget.maxVarIntBytes);
      if (!outer.ok) {
        if (outer.code === 'incomplete') {
          if (this.buffer.length > this.budget.maxVarIntBytes) { this.markUnknown('varint-too-long'); return this.failure('varint-too-long', frames); }
          return { frames, stopped: this.stopped };
        }
        this.markUnknown(outer.code === 'too-long' ? 'varint-too-long' : 'varint-overflow');
        return this.failure(outer.code === 'too-long' ? 'varint-too-long' : 'varint-overflow', frames);
      }
      const packetLength = outer.value;
      if (packetLength > this.budget.maxDecompressedBytes) {
        this.markUnknown('decompressed-too-large');
        return this.failure('decompressed-too-large', frames);
      }
      if (this.compressionValue === 'unknown') {
        this.markUnknown('compression-unknown');
        return this.failure('compression-unknown', frames);
      }

      if (this.compressionValue === 'disabled') {
        if (packetLength > this.budget.maxFrameBytes) {
          this.markUnknown('frame-too-large');
          return this.failure('frame-too-large', frames);
        }
        const total = outer.size + packetLength;
        if (this.buffer.length < total) return { frames, stopped: this.stopped };
        const body = Buffer.from(this.buffer.subarray(outer.size, total));
        this.buffer = this.buffer.length === total ? Buffer.alloc(0) : Buffer.from(this.buffer.subarray(total));
        const frame = this.commit(body, total, packetLength, false, frames);
        if (!frame) return { frames, failure: { code: 'control-unknown', reason: this.stopReason ?? 'control-unknown' }, stopped: true };
        continue;
      }

      const data = readBoundedVarInt(this.buffer, outer.size, this.budget.maxVarIntBytes);
      if (!data.ok) {
        if (data.code === 'incomplete') {
          if (this.buffer.length > outer.size + this.budget.maxVarIntBytes) { this.markUnknown('varint-too-long'); return this.failure('varint-too-long', frames); }
          return { frames, stopped: this.stopped };
        }
        this.markUnknown(data.code === 'too-long' ? 'varint-too-long' : 'varint-overflow');
        return this.failure(data.code === 'too-long' ? 'varint-too-long' : 'varint-overflow', frames);
      }
      const dataLength = data.value;
      if (dataLength === 0) {
        if (packetLength > this.budget.maxFrameBytes) {
          this.markUnknown('frame-too-large');
          return this.failure('frame-too-large', frames);
        }
        const payloadStart = outer.size + data.size;
        const total = payloadStart + packetLength;
        if (this.buffer.length < total) return { frames, stopped: this.stopped };
        const body = Buffer.from(this.buffer.subarray(payloadStart, total));
        this.buffer = this.buffer.length === total ? Buffer.alloc(0) : Buffer.from(this.buffer.subarray(total));
        const frame = this.commit(body, total, packetLength, false, frames);
        if (!frame) return { frames, failure: { code: 'control-unknown', reason: this.stopReason ?? 'control-unknown' }, stopped: true };
        continue;
      }

      if (dataLength > this.budget.maxFrameBytes) {
        this.markUnknown('frame-too-large');
        return this.failure('frame-too-large', frames);
      }
      const payloadStart = outer.size + data.size;
      const total = payloadStart + dataLength;
      if (this.buffer.length < total) return { frames, stopped: this.stopped };
      const compressedBody = Buffer.from(this.buffer.subarray(payloadStart, total));
      this.buffer = this.buffer.length === total ? Buffer.alloc(0) : Buffer.from(this.buffer.subarray(total));

      const started = this.now();
      let body: Buffer;
      try {
        const inflate = this.options.inflate ?? ((value: Buffer, maxOutputLength: number) => inflateSync(value, { maxOutputLength }));
        // Request at most the declared length. A compressed stream that expands past the
        // declaration must fail rather than be silently truncated.
        body = inflate(compressedBody, Math.max(1, packetLength));
      } catch {
        this.markUnknown('invalid-zlib');
        return this.failure('invalid-zlib', frames);
      }
      if (this.now() - started > this.budget.maxDecompressMs) {
        this.markUnknown('decompress-timeout');
        return this.failure('decompress-timeout', frames);
      }
      if (body.length !== packetLength) {
        this.markUnknown('length-mismatch');
        return this.failure('length-mismatch', frames);
      }
      if (compressedBody.length > 0 && body.length >= this.budget.compressionRatioFloorBytes
        && body.length / compressedBody.length > this.budget.maxCompressionRatio) {
        this.markUnknown('ratio-exceeded');
        return this.failure('ratio-exceeded', frames);
      }
      const frame = this.commit(body, total, packetLength, true, frames);
      if (!frame) return { frames, failure: { code: 'control-unknown', reason: this.stopReason ?? 'control-unknown' }, stopped: true };
    }
    return { frames, stopped: this.stopped };
  }

  private commit(body: Buffer, frameBytes: number, payloadBytes: number, compressed: boolean, frames: DecodedFrame[]): DecodedFrame | undefined {
    const sequence = (this.frameSequenceValue + 1n).toString();
    // byteOffsetValue counts all received bytes; keep a separate consumed cursor so
    // offsetStart is the frame's absolute start even when chunks are coalesced.
    const offsetStart = this.consumedOffset.toString();
    const offsetEnd = (this.consumedOffset + BigInt(frameBytes)).toString();
    this.consumedOffset += BigInt(frameBytes);
    this.frameSequenceValue = BigInt(sequence);

    if (this.options.recogniseControl) {
      let event: ControlEvent | undefined;
      try {
        event = this.options.recogniseControl({ direction: this.direction, body, compressed, phase: this.phase, compression: this.compression });
      } catch {
        this.markUnknown('control-unknown');
        return undefined;
      }
      if (event) {
        if (event.type === 'control-unknown') {
          this.markUnknown(event.reason ?? 'control-unknown');
          return undefined;
        }
        this.control(event);
      }
    }
    if (this.stopped) return undefined;
    const frame: DecodedFrame = {
      direction: this.direction, frameSequence: sequence, offsetStart, offsetEnd, frameBytes, payloadBytes,
      compressed, body, phase: this.phase, compression: this.compression,
    };
    frames.push(frame);
    return frame;
  }

  private consumedOffset = 0n;

  private failure(code: FrameFailureCode, frames: DecodedFrame[] = []): FrameDecodeResult {
    return { frames, failure: { code, reason: this.stopReason ?? code }, stopped: true };
  }
}

/** Test/support helper: encode an unsigned VarInt (five-byte maximum). */
export function encodeBoundedVarInt(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('varint-out-of-range');
  const bytes: number[] = [];
  let current = value;
  do {
    let next = current & 0x7f;
    current = Math.floor(current / 128);
    if (current !== 0) next |= 0x80;
    bytes.push(next);
  } while (current !== 0);
  return Buffer.from(bytes);
}
