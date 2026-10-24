import { randomUUID } from 'node:crypto';
import {
  DirectionalFrameDecoder,
  type ControlEvent,
  type ControlEventRecognizer,
  type DecodedFrame,
  type ObserverCompressionState,
  type ObserverDirection,
  type ObserverPhase,
} from './framing.js';

export type ObserverLimits = {
  maxFrameBytes: number;
  maxDecompressedBytes: number;
  maxQueuedFrames: number;
  maxQueuedBytes: number;
  maxConcurrency: number;
  taskTimeoutMs: number;
  maxCompressionRatio: number;
  compressionRatioFloorBytes: number;
  maxVarIntBytes: number;
  maxDecompressMs: number;
};
export type { ObserverDirection, ObserverCompressionState, ObserverPhase, ControlEvent };

/**
 * Framing is per direction. `phase` stays `UNKNOWN` until a recognised control event
 * establishes it; compression is tracked independently for each direction as well.
 * `UNKNOWN` means interpretation for that direction stopped, not that a phase was
 * guessed from packet boundaries.
 */
export type ObserverPhaseState = ObserverPhase;
export type ObserverPayloadKind = 'frame-metadata';
export type ObserverDirectionState = {
  direction: ObserverDirection;
  byteOffset: string;
  frameSequence: string;
  phase: ObserverPhaseState;
  compression: ObserverCompressionState;
  payloadKind: ObserverPayloadKind;
  availability: 'degraded' | 'unknown';
  stoppedReason?: string;
};
export type ObserverHealth = 'healthy' | 'degraded' | 'unknown' | 'stopped';
export type ObserverEvent =
  | {
      kind: 'observation';
      source: 'client';
      sessionEpoch: string;
      direction: ObserverDirection;
      frameSequence: string;
      phase: ObserverPhaseState;
      compression: ObserverCompressionState;
      availability: 'degraded';
      payload: {
        kind: ObserverPayloadKind;
        bytes: number;
        payloadBytes: number;
        offsetStart: string;
        offsetEnd: string;
        compressed: boolean;
      };
    }
  | {
      kind: 'observer_gap';
      source: 'client';
      sessionEpoch: string;
      gap: { scope: 'global' | 'domain'; reason: string; direction?: ObserverDirection; fromFrame?: string; toFrame?: string };
    };
export type ObserverListener = (event: ObserverEvent) => unknown;
type PendingFrame = DecodedFrame;

const defaults: ObserverLimits = {
  maxFrameBytes: 8 * 1024 * 1024,
  maxDecompressedBytes: 32 * 1024 * 1024,
  maxQueuedFrames: 128,
  maxQueuedBytes: 32 * 1024 * 1024,
  maxConcurrency: 2,
  taskTimeoutMs: 2_000,
  maxCompressionRatio: 256,
  compressionRatioFloorBytes: 1024 * 1024,
  maxVarIntBytes: 5,
  maxDecompressMs: 2_000,
};
const PAYLOAD_KIND: ObserverPayloadKind = 'frame-metadata';

export type BoundedObserverOptions = {
  limits?: Partial<ObserverLimits>;
  /** Optional control-event recogniser. It must not scan bytes for a plausible boundary. */
  recogniseControl?: ControlEventRecognizer;
  /** Injectable inflation for tests; defaults to bounded zlib inflate. */
  inflate?: (data: Buffer, maxOutputLength: number) => Buffer;
  now?: () => number;
};

export class BoundedObserver {
  readonly sessionEpoch = `observer_${randomUUID()}`;
  private healthValue: ObserverHealth = 'degraded';
  private readonly listeners = new Set<ObserverListener>();
  private readonly decoders: Record<ObserverDirection, DirectionalFrameDecoder>;
  private readonly pending: PendingFrame[] = [];
  private queuedBytes = 0;
  private stopped = false;
  private draining = false;
  private inflight = 0;
  private readonly limits: ObserverLimits;
  private readonly now: () => number;

  constructor(options: Partial<ObserverLimits> & Pick<BoundedObserverOptions, 'recogniseControl' | 'inflate' | 'now'> = {}) {
    this.limits = { ...defaults, ...options };
    this.now = options.now ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
    const decoderOptions = {
      recogniseControl: options.recogniseControl,
      inflate: options.inflate,
      now: this.now,
    };
    this.decoders = {
      'client-to-server': new DirectionalFrameDecoder('client-to-server', this.limits, decoderOptions),
      'server-to-client': new DirectionalFrameDecoder('server-to-client', this.limits, decoderOptions),
    };
  }

  get health(): ObserverHealth { return this.healthValue; }
  queued(): { frames: number; bytes: number } { return { frames: this.pending.length, bytes: this.queuedBytes }; }

  attach(direction: ObserverDirection, chunk: Uint8Array): void {
    if (this.stopped) return;
    const decoder = this.decoders[direction];
    if (decoder.stopped) return;
    const result = decoder.attach(chunk);
    for (const frame of result.frames) this.enqueue(frame);
    if (result.failure) {
      this.markUnknownFromDecoder(direction, result.failure.reason);
      return;
    }
    void this.drain();
  }

  /** Apply an explicitly recognised per-direction control event. */
  control(direction: ObserverDirection, event: ControlEvent | undefined): void {
    if (this.stopped) return;
    this.decoders[direction].control(event);
    if (this.decoders[direction].stopped) this.markUnknownFromDecoder(direction, this.decoders[direction].stopReason ?? 'control-unknown');
  }

  setCompression(direction: ObserverDirection, enabled: boolean, threshold = 0): void {
    this.decoders[direction].setCompression(enabled, threshold);
    if (this.decoders[direction].stopped) this.markUnknownFromDecoder(direction, this.decoders[direction].stopReason ?? 'compression-control-invalid');
  }

  setPhase(direction: ObserverDirection, phase: ObserverPhase): void {
    this.decoders[direction].setPhase(phase);
  }

  subscribe(listener: ObserverListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  state() {
    const directions = this.directionStates();
    return {
      upstream: directions.find(state => state.direction === 'server-to-client')!,
      downstream: directions.find(state => state.direction === 'client-to-server')!,
    };
  }

  markUnknown(reason = 'framing-loss', direction?: ObserverDirection): void {
    this.healthValue = 'unknown';
    if (direction) {
      this.decoders[direction].markUnknown(reason);
      this.dropPending(direction);
    } else {
      for (const key of Object.keys(this.decoders) as ObserverDirection[]) {
        this.decoders[key].markUnknown(reason);
        this.dropPending(key);
      }
    }
    this.gap('global', reason, direction);
  }

  reset(direction: ObserverDirection): void {
    // A reset starts a new session/sequence for one direction only. It clears framing
    // and control state for that direction; the other direction is untouched.
    this.decoders[direction].reset();
    this.dropPending(direction);
    const directions = this.directionStates();
    if (directions.some(state => state.availability === 'unknown')) this.healthValue = 'unknown';
    else if (directions.some(state => state.phase === 'UNKNOWN')) this.healthValue = 'degraded';
    else this.healthValue = 'healthy';
  }

  private directionStates(): ObserverDirectionState[] {
    return (Object.keys(this.decoders) as ObserverDirection[]).map(direction => {
      const decoder = this.decoders[direction];
      return {
        direction,
        byteOffset: decoder.byteOffset,
        frameSequence: decoder.frameSequence,
        phase: decoder.phase,
        compression: decoder.compression,
        payloadKind: PAYLOAD_KIND,
        availability: decoder.stopped ? 'unknown' : 'degraded',
        ...(decoder.stopReason === undefined ? {} : { stoppedReason: decoder.stopReason }),
      };
    });
  }

  private markUnknownFromDecoder(direction: ObserverDirection, reason: string): void {
    this.healthValue = 'unknown';
    this.dropPending(direction);
    this.gap('global', reason, direction);
  }

  private enqueue(frame: DecodedFrame): void {
    if (this.pending.length >= this.limits.maxQueuedFrames || this.queuedBytes + frame.payloadBytes > this.limits.maxQueuedBytes) {
      // Without a decoded packet class we cannot prove the dropped frame was not a
      // control packet, so continuity is lost globally; stop interpreting rather than
      // skipping frames and pretending later state is authoritative.
      const decoder = this.decoders[frame.direction];
      decoder.markUnknown('queue-overflow');
      this.dropPending(frame.direction);
      this.healthValue = 'unknown';
      this.gap('global', 'queue-overflow', frame.direction, frame.frameSequence);
      return;
    }
    this.pending.push(frame);
    this.queuedBytes += frame.payloadBytes;
  }

  private dropPending(direction?: ObserverDirection): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const frame = this.pending[index]!;
      if (direction && frame.direction !== direction) continue;
      this.queuedBytes = Math.max(0, this.queuedBytes - frame.payloadBytes);
      this.pending.splice(index, 1);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (this.pending.length) {
        const batch = this.pending.splice(0, Math.max(1, this.limits.maxConcurrency - this.inflight));
        for (const item of batch) this.queuedBytes = Math.max(0, this.queuedBytes - item.payloadBytes);
        await Promise.all(batch.map(item => this.dispatch(item)));
      }
    } finally {
      this.draining = false;
    }
  }

  private async dispatch(item: PendingFrame): Promise<void> {
    // Frame metadata only: the outer length is framing, not a decoded packet ID; no
    // packet fields are parsed or exposed.
    const event: ObserverEvent = {
      kind: 'observation',
      source: 'client',
      sessionEpoch: this.sessionEpoch,
      direction: item.direction,
      frameSequence: item.frameSequence,
      phase: item.phase,
      compression: item.compression,
      availability: 'degraded',
      payload: {
        kind: PAYLOAD_KIND,
        bytes: item.frameBytes,
        payloadBytes: item.payloadBytes,
        offsetStart: item.offsetStart,
        offsetEnd: item.offsetEnd,
        compressed: item.compressed,
      },
    };
    this.inflight += 1;
    let released = false;
    const release = () => { if (released) return; released = true; this.inflight = Math.max(0, this.inflight - 1); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        if (this.healthValue === 'healthy') this.healthValue = 'degraded';
        resolve();
      }, this.limits.taskTimeoutMs);
    });
    const work = Promise.all([...this.listeners].map(listener => Promise.resolve().then(() => listener(event)).catch(() => undefined))).then(() => undefined);
    await Promise.race([work, timeout]);
    // On timeout release the slot immediately so a hung listener cannot exceed
    // maxConcurrency. The listener may keep running; its settlement never double-releases.
    release();
    work.finally(() => release());
    if (timer) clearTimeout(timer);
  }

  private gap(scope: 'global' | 'domain', reason: string, direction?: ObserverDirection, fromFrame?: string): void {
    if (this.healthValue === 'healthy') this.healthValue = 'degraded';
    this.emit({
      kind: 'observer_gap',
      source: 'client',
      sessionEpoch: this.sessionEpoch,
      gap: {
        scope,
        reason,
        direction,
        fromFrame,
        toFrame: direction ? this.decoders[direction].frameSequence : undefined,
      },
    });
  }

  private emit(event: ObserverEvent): void {
    for (const listener of this.listeners) {
      try { void listener(event); } catch { /* observer consumers are isolated */ }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.healthValue = 'stopped';
    this.pending.length = 0;
    this.queuedBytes = 0;
    this.listeners.clear();
  }
}

export function createBoundedObserver(limits: Partial<ObserverLimits> = {}): BoundedObserver {
  return new BoundedObserver(limits);
}
