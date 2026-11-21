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
  stopped?: boolean;
  phase: ObserverPhaseState;
  compression: ObserverCompressionState;
  compressionThreshold: number | null;
  payloadKind: ObserverPayloadKind;
  availability: 'degraded' | 'unknown';
  directions: Record<ObserverDirection, ObserverDirectionState>;
  limitation: 'phase-compression-unknown' | 'packet-decoding-unsupported';
};

/**
 * Host-side inbound credit. The worker's own queue bounds are applied after a message has
 * crossed the thread boundary; this budget bounds the in-flight copies before postMessage.
 */
export type ObserverHostLimits = {
  maxInFlightBytes: number;
  maxInFlightMessages: number;
  maxChunkBytes: number;
  maxSessions: number;
  readyTimeoutMs: number;
};

export type ObserverWorkerHostOptions = {
  createWorker?: () => WorkerLike;
  onEvent: (event: ObserverEvent) => void;
  onFailure?: (reason: string) => void;
  limits?: Partial<ObserverHostLimits>;
};

const PAYLOAD_KIND: ObserverPayloadKind = 'frame-metadata';
const DEFAULT_SESSION_KEY = 'default';
const defaultHostLimits: ObserverHostLimits = {
  maxInFlightBytes: 8 * 1024 * 1024,
  maxInFlightMessages: 64,
  maxChunkBytes: 256 * 1024,
  maxSessions: 16,
  readyTimeoutMs: 2_000,
};
const directionState = (direction: ObserverDirection): ObserverDirectionState => ({
  direction,
  byteOffset: '0',
  frameSequence: '0',
  phase: 'UNKNOWN',
  compression: 'disabled',
  compressionThreshold: null,
  payloadKind: PAYLOAD_KIND,
  availability: 'unknown',
});
const emptyDirections = (): Record<ObserverDirection, ObserverDirectionState> => ({
  'client-to-server': directionState('client-to-server'),
  'server-to-client': directionState('server-to-client'),
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
    compressionThreshold: typeof input.compressionThreshold === 'number' && Number.isInteger(input.compressionThreshold)
      ? input.compressionThreshold
      : null,
    payloadKind: PAYLOAD_KIND,
    availability: input.availability === 'degraded' ? 'degraded' : 'unknown',
    ...(typeof input.stoppedReason === 'string' ? { stoppedReason: input.stoppedReason } : {}),
  };
};

/** Accurate report for an observer worker that is not running (disabled or explicitly stopped). */
export function stoppedObserverState(): ObserverHostState {
  return {
    running: false,
    stopped: true,
    phase: 'UNKNOWN',
    compression: 'disabled',
    compressionThreshold: null,
    payloadKind: PAYLOAD_KIND,
    availability: 'unknown',
    directions: emptyDirections(),
    limitation: 'packet-decoding-unsupported',
  };
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL('./worker.js', import.meta.url)) as unknown as WorkerLike;
}

type SessionCredit = {
  key: string;
  inFlightBytes: number;
  inFlightMessages: number;
  directions: Record<ObserverDirection, ObserverDirectionState>;
};
type OutstandingChunk = { session: string; bytes: number };
type ReadyWaiter = { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * Owns the observer worker. The relay feeds it bytes; it never gets socket-write authority.
 * A worker failure is reported separately from the forwarding path so it cannot corrupt control.
 */
export class ObserverWorkerHost {
  private worker?: WorkerLike;
  private stopped = false;
  private lost = false;
  private readyValue = false;
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private readonly limits: ObserverHostLimits;
  private readonly sessions = new Map<string, SessionCredit>();
  private readonly outstanding = new Map<string, OutstandingChunk>();
  private readonly closedSessions = new Set<string>();
  private lastStateSession?: string;
  private chunkSequence = 0;
  private readonly failureListeners = new Set<(reason: string) => void>();

  constructor(private readonly options: ObserverWorkerHostOptions) {
    this.limits = { ...defaultHostLimits, ...options.limits };
  }

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
    this.readyValue = false;
    this.clearCredit();
    this.closedSessions.clear();
    worker.on('message', message => {
      if (this.worker !== worker || this.stopped) return;
      this.handleWorkerMessage(message);
    });
    worker.on('error', () => {
      if (this.worker !== worker || this.stopped) return;
      this.lost = true;
      this.clearCredit();
      this.settleReady(new Error('observer-worker-error'));
      this.notifyFailure('observer-worker-error');
    });
    worker.on('exit', () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.lost = true;
      this.clearCredit();
      this.settleReady(new Error('observer-worker-exit'));
      if (!this.stopped) this.notifyFailure('observer-worker-exit');
    });
  }

  /** Resolve once the worker has entered its message loop; rejects on failure/timeout. */
  ready(timeoutMs = this.limits.readyTimeoutMs): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('observer-worker-stopped'));
    if (this.readyValue && this.worker) return Promise.resolve();
    if (!this.worker) return Promise.reject(new Error('observer-worker-unavailable'));
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve: () => { clearTimeout(waiter.timer); resolve(); },
        reject: error => { clearTimeout(waiter.timer); reject(error); },
        timer: setTimeout(() => { this.readyWaiters.delete(waiter); reject(new Error('observer-worker-ready-timeout')); }, timeoutMs),
      };
      this.readyWaiters.add(waiter);
    });
  }

  /** Explicit capability report: framing state comes from the worker; no packet ID decoding. */
  state(): ObserverHostState {
    const running = Boolean(this.worker && !this.stopped && !this.lost);
    const unavailable = !running;
    const sessionKey = this.lastStateSession && this.sessions.has(this.lastStateSession)
      ? this.lastStateSession
      : [...this.sessions.keys()][0];
    const session = sessionKey === undefined ? undefined : this.sessions.get(sessionKey);
    const source = session?.directions ?? emptyDirections();
    const directions = {
      'client-to-server': {
        ...source['client-to-server'],
        availability: unavailable ? 'unknown' : source['client-to-server'].availability,
      },
      'server-to-client': {
        ...source['server-to-client'],
        availability: unavailable ? 'unknown' : source['server-to-client'].availability,
      },
    } satisfies Record<ObserverDirection, ObserverDirectionState>;
    return {
      running,
      phase: directions['server-to-client'].phase,
      compression: directions['server-to-client'].compression,
      compressionThreshold: directions['server-to-client'].compressionThreshold,
      payloadKind: PAYLOAD_KIND,
      availability: unavailable ? 'unknown' : 'degraded',
      directions,
      limitation: 'packet-decoding-unsupported',
    };
  }

  /**
   * Reserve host credit and hand a chunk to the worker. Returns false when the worker is
   * unavailable or credit is exhausted; the relay must treat that as observation loss, never
   * as a reason to block forwarding.
   */
  attach(direction: ObserverDirection, bytes: Uint8Array, sessionEpoch?: string): boolean {
    const worker = this.worker;
    if (!worker || this.stopped || this.lost) return false;
    const key = sessionEpoch ?? DEFAULT_SESSION_KEY;
    const session = this.ensureSession(key);
    if (!session) return false;
    if (bytes.length === 0) return true;
    const total = bytes.length;
    for (let offset = 0; offset < total; offset += this.limits.maxChunkBytes) {
      const end = Math.min(total, offset + this.limits.maxChunkBytes);
      const piece = offset === 0 && end === total ? bytes : Uint8Array.prototype.slice.call(bytes, offset, end);
      if (!this.reserve(session, piece.length)) {
        this.stopSession(key, 'observer-credit-exhausted');
        return false;
      }
      const chunkId = `chunk_${++this.chunkSequence}`;
      this.outstanding.set(chunkId, { session: key, bytes: piece.length });
      try {
        worker.postMessage({
          type: 'chunk', direction, bytes: piece, ...(sessionEpoch === undefined ? {} : { sessionEpoch }), chunkId,
        } satisfies WorkerInbound);
      } catch {
        this.outstanding.delete(chunkId);
        this.stopSession(key, 'observer-post-failed');
        return false;
      }
    }
    return true;
  }

  reset(direction: ObserverDirection, sessionEpoch?: string): void {
    this.worker?.postMessage({ type: 'reset', direction, ...(sessionEpoch === undefined ? {} : { sessionEpoch }) } satisfies WorkerInbound);
  }

  control(direction: ObserverDirection, event: unknown, sessionEpoch?: string): void {
    this.worker?.postMessage({ type: 'control', direction, event, ...(sessionEpoch === undefined ? {} : { sessionEpoch }) } satisfies WorkerInbound);
  }

  setCompression(direction: ObserverDirection, enabled: boolean, threshold = 0, sessionEpoch?: string): void {
    this.worker?.postMessage({ type: 'set-compression', direction, enabled, threshold, ...(sessionEpoch === undefined ? {} : { sessionEpoch }) } satisfies WorkerInbound);
  }

  /** Relay connection closed: drop that session's decoder, partial frames and host credit. */
  closeSession(sessionEpoch: string): void {
    const session = this.sessions.get(sessionEpoch);
    if (session) this.releaseSession(sessionEpoch);
    this.rememberClosed(sessionEpoch);
    try { this.worker?.postMessage({ type: 'close-session', sessionEpoch } satisfies WorkerInbound); } catch { /* worker gone */ }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearCredit();
    this.settleReady(new Error('observer-worker-stopped'));
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return;
    try { await worker.terminate(); } catch { /* best effort */ }
  }

  private handleWorkerMessage(message: unknown): void {
    if (this.lost) return;
    const payload = message as {
      type?: string;
      event?: ObserverEvent;
      direction?: unknown;
      sessionEpoch?: unknown;
      state?: Partial<ObserverDirectionState>;
      chunkId?: unknown;
    } | undefined;
    if (!payload) return;
    if (payload.type === 'ready') { this.settleReady(); return; }
    if (payload.type === 'ack') { this.acknowledge(payload.chunkId); return; }
    if (payload.type === 'event' && payload.event) {
      this.options.onEvent(payload.event);
      return;
    }
    if (payload.type === 'state' && payload.direction && isDirection(payload.direction)) {
      const key = typeof payload.sessionEpoch === 'string' ? payload.sessionEpoch : DEFAULT_SESSION_KEY;
      if (this.closedSessions.has(key)) return;
      const session = this.ensureSession(key);
      if (!session) return;
      const existing = session.directions[payload.direction];
      const next = normalizeDirection(payload.state, payload.direction);
      session.directions = { ...session.directions, [payload.direction]: { ...existing, ...next } } as Record<ObserverDirection, ObserverDirectionState>;
      this.lastStateSession = key;
    }
  }

  private ensureSession(key: string): SessionCredit | undefined {
    if (this.closedSessions.has(key)) return undefined;
    const existing = this.sessions.get(key);
    if (existing) {
      // Refresh insertion order so eviction drops the least recently active session.
      this.sessions.delete(key);
      this.sessions.set(key, existing);
      return existing;
    }
    if (this.sessions.size >= this.limits.maxSessions) {
      const oldest = this.sessions.keys().next().value as string;
      this.stopSession(oldest, 'observer-session-eviction');
    }
    const session: SessionCredit = { key, inFlightBytes: 0, inFlightMessages: 0, directions: emptyDirections() };
    this.sessions.set(key, session);
    return session;
  }

  private reserve(session: SessionCredit, bytes: number): boolean {
    if (session.inFlightBytes + bytes > this.limits.maxInFlightBytes) return false;
    if (session.inFlightMessages + 1 > this.limits.maxInFlightMessages) return false;
    session.inFlightBytes += bytes;
    session.inFlightMessages += 1;
    return true;
  }

  private acknowledge(chunkId: unknown): void {
    if (typeof chunkId !== 'string') return;
    const entry = this.outstanding.get(chunkId);
    if (!entry) return;
    this.outstanding.delete(chunkId);
    const session = this.sessions.get(entry.session);
    if (!session) return;
    session.inFlightBytes = Math.max(0, session.inFlightBytes - entry.bytes);
    session.inFlightMessages = Math.max(0, session.inFlightMessages - 1);
  }

  private releaseSession(key: string): void {
    for (const [id, entry] of this.outstanding) {
      if (entry.session === key) this.outstanding.delete(id);
    }
    this.sessions.delete(key);
    if (this.lastStateSession === key) this.lastStateSession = undefined;
  }

  private stopSession(key: string, reason: string): void {
    if (!this.sessions.has(key)) return;
    this.releaseSession(key);
    this.rememberClosed(key);
    try { this.worker?.postMessage({ type: 'close-session', sessionEpoch: key } satisfies WorkerInbound); } catch { /* worker gone */ }
    this.emitGap(key, reason);
  }

  private rememberClosed(key: string): void {
    this.closedSessions.add(key);
    const limit = this.limits.maxSessions * 4;
    while (this.closedSessions.size > limit) {
      const oldest = this.closedSessions.values().next().value as string;
      this.closedSessions.delete(oldest);
    }
  }

  private emitGap(sessionEpoch: string, reason: string): void {
    try {
      this.options.onEvent({
        kind: 'observer_gap',
        source: 'client',
        sessionEpoch,
        gap: { scope: 'global', reason },
      });
    } catch { /* callbacks are isolated */ }
  }

  private clearCredit(): void {
    this.outstanding.clear();
    this.sessions.clear();
    this.lastStateSession = undefined;
  }

  private settleReady(error?: Error): void {
    if (!error) this.readyValue = true;
    for (const waiter of [...this.readyWaiters]) {
      this.readyWaiters.delete(waiter);
      if (error) waiter.reject(error); else waiter.resolve();
    }
  }

  private notifyFailure(reason: string): void {
    try { this.options.onFailure?.(reason); } catch { /* callbacks are isolated */ }
    for (const listener of this.failureListeners) {
      try { listener(reason); } catch { /* callbacks are isolated */ }
    }
  }
}
