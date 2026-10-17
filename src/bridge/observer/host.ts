import { Worker } from 'node:worker_threads';
import type { ObserverDirection, ObserverEvent } from './bounded.js';
import type { WorkerInbound } from './worker.js';

export type WorkerLike = {
  postMessage(value: unknown): void;
  on(event: 'message' | 'error' | 'exit', listener: (value?: unknown) => void): unknown;
  terminate(): Promise<number> | void;
};

export type ObserverWorkerHostOptions = {
  createWorker?: () => WorkerLike;
  onEvent: (event: ObserverEvent) => void;
  onFailure?: (reason: string) => void;
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
  constructor(private readonly options: ObserverWorkerHostOptions) {}
  start(): void {
    if (this.worker || this.stopped) return;
    const worker = (this.options.createWorker ?? defaultWorker)();
    this.worker = worker;
    worker.on('message', message => {
      const payload = message as { type?: string; event?: ObserverEvent } | undefined;
      if (payload?.type === 'event' && payload.event) this.options.onEvent(payload.event);
    });
    worker.on('error', () => this.options.onFailure?.('observer-worker-error'));
    worker.on('exit', () => { this.worker = undefined; if (!this.stopped) this.options.onFailure?.('observer-worker-exit'); });
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
