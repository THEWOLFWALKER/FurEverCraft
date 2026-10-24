import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type {
  ObserverCompressionState,
  ObserverDirection,
  ObserverDirectionState,
  ObserverEvent,
  ObserverPhaseState,
  ObserverPayloadKind,
} from './bounded.js';
import type { WorkerAck, WorkerInbound } from './worker.js';

export type WorkerLike = {
  postMessage(value: unknown): void;
  on(event: 'message' | 'error' | 'exit', listener: (value?: unknown) => void): unknown;
  terminate(): Promise<number> | void;
};

/**
 * Owns the observer worker. The relay feeds it bytes; it never gets socket-write
 * authority. The worker performs bounded framing/inflation off the relay event loop.
 * Until the worker reports per-direction state, both directions are `UNKNOWN` rather
 * than a guessed phase or a shared compression flag.
 */
export type ObserverHostState = {
  running: boolean;
  phase: ObserverPhaseState;
  compression: ObserverCompressionState;
  payloadKind: ObserverPayloadKind;
  availability: 'degraded' | 'unknown';
  directions: Record<ObserverDirection, ObserverDirectionState>;
  limitation: 'phase-compression-unknown' | 'packet-decoding-unsupported';
};

export type ObserverWorkerHostOptions = {
  createWorker?: () => WorkerLike;
  onEvent: (event: ObserverEvent) => void;
  onFailure?: (reason: string) => void;
  /** Unacknowledged (posted but not worker-acked) byte budget per direction. */
  maxUnackedBytes?: number;
  /** Unacknowledged chunk budget per direction. */
  maxUnackedFrames?: number;
};

const PAYLOAD_KIND: ObserverPayloadKind = 'frame-metadata';
const DEFAULT_MAX_UNACKED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_UNACKED_FRAMES = 256;
const directionState = (direction: ObserverDirection): ObserverDirectionState => ({
  direction,
  byteOffset: '0',
  frameSequence: '0',
  phase: 'UNKNOWN',
  compression: 'unknown',
  assumedCompression: 'uncompressed',
  payloadKind: PAYLOAD_KIND,
  availability: 'unknown',
});

const isDirection = (value: unknown): value is ObserverDirection => value === 'client-to-server' || value === 'server-to-client';
const normalizeDirection = (value: unknown, direction: ObserverDirection): ObserverDirectionState => {
  const input = (value ?? {}) as Partial<ObserverDirectionState>;
  return {
    direction,
    byteOffset: typeof input.byteOffset === 'string' ? input.byteOffset : '0',
    frameSequence: typeof input.frameSequence === 'string' ? input.frameSequence : '0',
    phase: typeof input.phase === 'string' ? input.phase as ObserverPhaseState : 'UNKNOWN',
    compression: typeof input.compression === 'string' ? input.compression as ObserverCompressionState : 'unknown',
    ...(input.assumedCompression === 'uncompressed' ? { assumedCompression: 'uncompressed' as const } : {}),
    payloadKind: PAYLOAD_KIND,
    availability: input.availability === 'degraded' ? 'degraded' : 'unknown',
    ...(typeof input.stoppedReason === 'string' ? { stoppedReason: input.stoppedReason } : {}),
  };
};

function defaultWorker(): WorkerLike {
  return new Worker(new URL('./worker.js', import.meta.url)) as unknown as WorkerLike;
}

/**
 * Owns the observer worker. The relay feeds it bytes; it never gets socket-write authority.
 * A worker failure is reported separately from the forwarding path so it cannot corrupt control.
 */
export class ObserverWorkerHost {
  readonly sessionEpoch = `observer_host_${randomUUID()}`;
  private worker?: WorkerLike;
  private stopped = false;
  private lost = false;
  private readonly stoppedDirections = new Set<ObserverDirection>();
  private readonly unackedBytes: Record<ObserverDirection, number> = { 'client-to-server': 0, 'server-to-client': 0 };
  private readonly unackedFrames: Record<ObserverDirection, number> = { 'client-to-server': 0, 'server-to-client': 0 };
  private directions: Record<ObserverDirection, ObserverDirectionState> = {
    'client-to-server': directionState('client-to-server'),
    'server-to-client': directionState('server-to-client'),
  };
  private readonly failureListeners = new Set<(reason: string) => void>();

  constructor(private readonly options: ObserverWorkerHostOptions) {}

  /** Register an additional failure observer without replacing the constructor callback. */
  onFailure(listener: (reason: string) => void): () => void {
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  start(): void {
    if (this.worker || this.stopped) return;
    const worker = (this.options.createWorker ?? defaultWorker)();
    this.worker = worker;
    this.lost = false;
    this.stoppedDirections.clear();
    for (const direction of Object.keys(this.unackedBytes) as ObserverDirection[]) {
      this.unackedBytes[direction] = 0;
      this.unackedFrames[direction] = 0;
    }
    worker.on('message', message => {
      const payload = message as {
        type?: string;
        event?: ObserverEvent;
        direction?: unknown;
        state?: Partial<ObserverDirectionState>;
        bytes?: unknown;
        frames?: unknown;
      } | undefined;
      if (payload?.type === 'event' && payload.event) this.options.onEvent(payload.event);
      if (payload?.type === 'ack' && payload.direction && isDirection(payload.direction)) {
        const ack = payload as unknown as WorkerAck;
        const direction = ack.direction;
        this.unackedBytes[direction] = Math.max(0, this.unackedBytes[direction] - Math.max(0, Number(ack.bytes) || 0));
        this.unackedFrames[direction] = Math.max(0, this.unackedFrames[direction] - Math.max(1, Number(ack.frames ?? 1) || 1));
      }
      if (payload?.type === 'state' && payload.direction && isDirection(payload.direction)) {
        const existing = this.directions[payload.direction];
        const next = normalizeDirection(payload.state, payload.direction);
        const merged = { ...existing, ...next };
        // Worker state is authoritative for optional markers: a confirmed compression
        // state must clear the stale assumed-uncompressed marker.
        if (next.assumedCompression === undefined) delete merged.assumedCompression;
        if (next.stoppedReason === undefined) delete merged.stoppedReason;
        this.directions = { ...this.directions, [payload.direction]: merged };
      }
    });
    worker.on('error', () => { this.lost = true; this.notifyFailure('observer-worker-error'); });
    worker.on('exit', () => {
      this.worker = undefined;
      this.lost = true;
      if (!this.stopped) this.notifyFailure('observer-worker-exit');
    });
  }

  /** Explicit capability report: framing state comes from the worker; no packet ID decoding. */
  state(): ObserverHostState {
    const running = Boolean(this.worker && !this.stopped);
    const unavailable = this.stopped || !running || this.lost;
    const directions = {
      'client-to-server': { ...this.directions['client-to-server'], availability: unavailable ? 'unknown' : this.directions['client-to-server'].availability },
      'server-to-client': { ...this.directions['server-to-client'], availability: unavailable ? 'unknown' : this.directions['server-to-client'].availability },
    } satisfies Record<ObserverDirection, ObserverDirectionState>;
    // Any direction that is stopped or reports unknown makes the aggregate unknown; worker
    // liveness alone is not enough to claim observation availability.
    const anyDirectionUnknown = this.stoppedDirections.size > 0
      || directions['client-to-server'].availability === 'unknown'
      || directions['server-to-client'].availability === 'unknown';
    const availability = unavailable || anyDirectionUnknown ? 'unknown' : 'degraded';
    const compressionUnknown = directions['client-to-server'].compression === 'unknown'
      || directions['server-to-client'].compression === 'unknown';
    return {
      running,
      phase: directions['server-to-client'].phase,
      compression: directions['server-to-client'].compression,
      payloadKind: PAYLOAD_KIND,
      availability,
      directions,
      limitation: compressionUnknown ? 'phase-compression-unknown' : 'packet-decoding-unsupported',
    };
  }

  attach(direction: ObserverDirection, bytes: Uint8Array): boolean {
    if (!this.worker || this.stopped || this.stoppedDirections.has(direction)) return false;
    const size = bytes.byteLength;
    const maxBytes = this.options.maxUnackedBytes ?? DEFAULT_MAX_UNACKED_BYTES;
    const maxFrames = this.options.maxUnackedFrames ?? DEFAULT_MAX_UNACKED_FRAMES;
    if (size > maxBytes
      || this.unackedBytes[direction] + size > maxBytes
      || this.unackedFrames[direction] + 1 > maxFrames) {
      this.stopDirection(direction, 'observer-attach-backpressure');
      return false;
    }
    this.unackedBytes[direction] += size;
    this.unackedFrames[direction] += 1;
    this.worker.postMessage({ type: 'chunk', direction, bytes } satisfies WorkerInbound);
    return true;
  }
  reset(direction: ObserverDirection): void {
    this.stoppedDirections.delete(direction);
    this.unackedBytes[direction] = 0;
    this.unackedFrames[direction] = 0;
    const { stoppedReason: _staleReason, ...rest } = this.directions[direction];
    void _staleReason;
    this.directions = { ...this.directions, [direction]: { ...rest, availability: 'unknown' } };
    this.worker?.postMessage({ type: 'reset', direction } satisfies WorkerInbound);
  }
  control(direction: ObserverDirection, event: unknown): void { this.worker?.postMessage({ type: 'control', direction, event } satisfies WorkerInbound); }
  setCompression(direction: ObserverDirection, enabled: boolean, threshold = 0): void {
    this.worker?.postMessage({ type: 'set-compression', direction, enabled, threshold } satisfies WorkerInbound);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    try { await worker.terminate(); } catch { /* best effort */ }
  }

  private stopDirection(direction: ObserverDirection, reason: string): void {
    this.stoppedDirections.add(direction);
    this.unackedBytes[direction] = 0;
    this.unackedFrames[direction] = 0;
    this.directions = {
      ...this.directions,
      [direction]: { ...this.directions[direction], availability: 'unknown', stoppedReason: reason },
    };
    // Bytes were not handed to the worker, so continuity for this direction is lost. Report
    // it as a global gap (the relay consumer revokes control) and as a failure diagnostic.
    try {
      this.options.onEvent({
        kind: 'observer_gap', source: 'client', sessionEpoch: this.sessionEpoch,
        gap: { scope: 'global', reason, direction },
      });
    } catch { /* event consumers are isolated */ }
    this.notifyFailure(reason);
  }

  private notifyFailure(reason: string): void {
    try { this.options.onFailure?.(reason); } catch { /* callbacks are isolated */ }
    for (const listener of this.failureListeners) {
      try { listener(reason); } catch { /* callbacks are isolated */ }
    }
  }
}
