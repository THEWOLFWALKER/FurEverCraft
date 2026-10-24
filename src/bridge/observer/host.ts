import { Worker } from 'node:worker_threads';
import type {
  ObserverCompressionState,
  ObserverDirection,
  ObserverDirectionState,
  ObserverEvent,
  ObserverPhaseState,
  ObserverPayloadKind,
} from './bounded.js';
import type { WorkerInbound } from './worker.js';

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
};

const PAYLOAD_KIND: ObserverPayloadKind = 'frame-metadata';
const directionState = (direction: ObserverDirection): ObserverDirectionState => ({
  direction,
  byteOffset: '0',
  frameSequence: '0',
  phase: 'UNKNOWN',
  compression: 'disabled',
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
    compression: typeof input.compression === 'string' ? input.compression as ObserverCompressionState : 'disabled',
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
  private worker?: WorkerLike;
  private stopped = false;
  private lost = false;
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
    worker.on('message', message => {
      const payload = message as {
        type?: string;
        event?: ObserverEvent;
        direction?: unknown;
        state?: Partial<ObserverDirectionState>;
      } | undefined;
      if (payload?.type === 'event' && payload.event) this.options.onEvent(payload.event);
      if (payload?.type === 'state' && payload.direction && isDirection(payload.direction)) {
        const existing = this.directions[payload.direction];
        const next = normalizeDirection(payload.state, payload.direction);
        this.directions = { ...this.directions, [payload.direction]: { ...existing, ...next } };
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
    const availability = unavailable ? 'unknown' : 'degraded';
    const directions = {
      'client-to-server': { ...this.directions['client-to-server'], availability: unavailable ? 'unknown' : this.directions['client-to-server'].availability },
      'server-to-client': { ...this.directions['server-to-client'], availability: unavailable ? 'unknown' : this.directions['server-to-client'].availability },
    } satisfies Record<ObserverDirection, ObserverDirectionState>;
    return {
      running,
      phase: directions['server-to-client'].phase,
      compression: directions['server-to-client'].compression,
      payloadKind: PAYLOAD_KIND,
      availability,
      directions,
      limitation: 'packet-decoding-unsupported',
    };
  }

  attach(direction: ObserverDirection, bytes: Uint8Array): boolean {
    if (!this.worker) return false;
    this.worker.postMessage({ type: 'chunk', direction, bytes } satisfies WorkerInbound);
    return true;
  }
  reset(direction: ObserverDirection): void { this.worker?.postMessage({ type: 'reset', direction } satisfies WorkerInbound); }
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

  private notifyFailure(reason: string): void {
    try { this.options.onFailure?.(reason); } catch { /* callbacks are isolated */ }
    for (const listener of this.failureListeners) {
      try { listener(reason); } catch { /* callbacks are isolated */ }
    }
  }
}
