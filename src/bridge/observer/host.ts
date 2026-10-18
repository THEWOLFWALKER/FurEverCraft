import { Worker } from 'node:worker_threads';
import type { ObserverCompressionState, ObserverDirection, ObserverDirectionState, ObserverEvent, ObserverPhaseState, ObserverPayloadKind } from './bounded.js';
import type { WorkerInbound } from './worker.js';

export type WorkerLike = {
  postMessage(value: unknown): void;
  on(event: 'message' | 'error' | 'exit', listener: (value?: unknown) => void): unknown;
  terminate(): Promise<number> | void;
};

/**
 * FEC-401/402/403: the worker only frames raw bytes. Phase and compression tracking and packet
 * decoding are not implemented, so the host reports them as 'unsupported' and availability as
 * 'degraded' instead of inventing state. 'unknown' is reserved for worker/framing loss.
 */
export type ObserverHostState = {
  running: boolean;
  phase: ObserverPhaseState;
  compression: ObserverCompressionState;
  payloadKind: ObserverPayloadKind;
  availability: 'degraded'|'unknown';
  directions: Record<ObserverDirection, ObserverDirectionState>;
  limitation: 'phase-compression-unsupported'|'packet-decoding-unsupported';
};

export type ObserverWorkerHostOptions = {
  createWorker?: () => WorkerLike;
  onEvent: (event: ObserverEvent) => void;
  onFailure?: (reason: string) => void;
};

const UNSUPPORTED_PHASE: ObserverPhaseState = 'unsupported';
const UNSUPPORTED_COMPRESSION: ObserverCompressionState = 'unsupported';
const PAYLOAD_KIND: ObserverPayloadKind = 'frame-metadata';
const directionState = (direction: ObserverDirection): ObserverDirectionState => ({
  direction, byteOffset: '0', frameSequence: '0', phase: UNSUPPORTED_PHASE,
  compression: UNSUPPORTED_COMPRESSION, payloadKind: PAYLOAD_KIND, availability: 'degraded',
});

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
  constructor(private readonly options: ObserverWorkerHostOptions) {}
  start(): void {
    if (this.worker || this.stopped) return;
    const worker = (this.options.createWorker ?? defaultWorker)();
    this.worker = worker;
    this.lost = false;
    worker.on('message', message => {
      const payload = message as { type?: string; event?: ObserverEvent } | undefined;
      if (payload?.type === 'event' && payload.event) this.options.onEvent(payload.event);
    });
    worker.on('error', () => { this.lost = true; this.options.onFailure?.('observer-worker-error'); });
    worker.on('exit', () => { this.worker = undefined; this.lost = true; if (!this.stopped) this.options.onFailure?.('observer-worker-exit'); });
  }
  /** Explicit capability report: no decompression, no phase tracking, no packet ID/field decoding. */
  state(): ObserverHostState {
    const running = Boolean(this.worker && !this.stopped);
    const unavailable = this.stopped || !running || this.lost;
    const availability = unavailable ? 'unknown' : 'degraded';
    const directions = {
      'client-to-server': { ...directionState('client-to-server'), availability: availability as 'degraded'|'unknown' },
      'server-to-client': { ...directionState('server-to-client'), availability: availability as 'degraded'|'unknown' },
    };
    return { running, phase: UNSUPPORTED_PHASE, compression: UNSUPPORTED_COMPRESSION, payloadKind: PAYLOAD_KIND, availability, directions, limitation: 'phase-compression-unsupported' };
  }
  attach(direction: ObserverDirection, bytes: Uint8Array): void {
    if (!this.worker) return;
    this.worker.postMessage({ type: 'chunk', direction, bytes } satisfies WorkerInbound);
  }
  reset(direction: ObserverDirection): void { this.worker?.postMessage({ type: 'reset', direction } satisfies WorkerInbound); }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    try { await worker.terminate(); } catch { /* best effort */ }
  }
}
