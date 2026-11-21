import { parentPort } from 'node:worker_threads';
import {
  BoundedObserver,
  type ControlEvent,
  type ObserverDirection,
  type ObserverEvent,
  type ObserverLimits,
  type ObserverPhase,
} from './bounded.js';

/**
 * Observer worker entry. Bounded frame assembly and decompression live here so the relay
 * event loop is never blocked by observation work. Only redacted observation/gap events
 * and per-direction framing state are posted back; the worker never receives raw socket
 * write authority and never scans for a guessed packet boundary.
 *
 * Framing state is per TCP session: two relay connections are never interpreted as one
 * stream, and closing a session drops its decoders and partial frames instead of leaking
 * them into the next connection.
 */
export type WorkerInbound =
  | { type: 'chunk'; direction: ObserverDirection; bytes: Uint8Array; sessionEpoch?: string; chunkId?: string }
  | { type: 'stop' }
  | { type: 'close-session'; sessionEpoch: string }
  | { type: 'reset'; direction: ObserverDirection; sessionEpoch?: string }
  | { type: 'control'; direction: ObserverDirection; event: unknown; sessionEpoch?: string }
  | { type: 'set-compression'; direction: ObserverDirection; enabled: boolean; threshold?: number; sessionEpoch?: string }
  | { type: 'set-phase'; direction: ObserverDirection; phase: string; sessionEpoch?: string };

export type WorkerOutbound =
  | { type: 'ready' }
  | { type: 'event'; event: ObserverEvent }
  | { type: 'state'; direction: ObserverDirection; sessionEpoch?: string; state: unknown }
  | { type: 'ack'; chunkId: string };

export const DEFAULT_OBSERVER_SESSION = 'default';

export type ObserverSessionOptions = {
  onEvent: (event: ObserverEvent) => void;
  maxSessions?: number;
  observerLimits?: Partial<ObserverLimits>;
};

/**
 * Bounded per-session observer registry. This is the worker's only framing state, so a
 * session key is the connection epoch supplied by the relay.
 */
export class ObserverSessionRegistry {
  private readonly sessions = new Map<string, BoundedObserver>();
  private readonly closedSessions = new Set<string>();
  private readonly maxSessions: number;
  private readonly options: ObserverSessionOptions;

  constructor(options: ObserverSessionOptions) {
    this.options = options;
    this.maxSessions = Math.max(1, options.maxSessions ?? 16);
  }

  get size(): number { return this.sessions.size; }
  keys(): string[] { return [...this.sessions.keys()]; }

  attach(sessionEpoch: string | undefined, direction: ObserverDirection, bytes: Uint8Array): BoundedObserver | undefined {
    const observer = this.get(sessionEpoch);
    observer?.attach(direction, bytes);
    return observer;
  }

  observerFor(sessionEpoch?: string): BoundedObserver | undefined {
    return this.find(sessionEpoch);
  }

  reset(sessionEpoch: string | undefined, direction: ObserverDirection): BoundedObserver | undefined {
    const observer = this.find(sessionEpoch);
    observer?.reset(direction);
    return observer;
  }

  control(sessionEpoch: string | undefined, direction: ObserverDirection, event: ControlEvent | undefined): BoundedObserver | undefined {
    const observer = this.find(sessionEpoch);
    observer?.control(direction, event);
    return observer;
  }

  setCompression(sessionEpoch: string | undefined, direction: ObserverDirection, enabled: boolean, threshold = 0): BoundedObserver | undefined {
    const observer = this.find(sessionEpoch);
    observer?.setCompression(direction, enabled, threshold);
    return observer;
  }

  setPhase(sessionEpoch: string | undefined, direction: ObserverDirection, phase: ObserverPhase): BoundedObserver | undefined {
    const observer = this.find(sessionEpoch);
    observer?.setPhase(direction, phase);
    return observer;
  }

  /** Delete a session's decoder and partial frames. Late chunks/events from it are rejected. */
  close(sessionEpoch: string): void {
    const key = sessionEpoch || DEFAULT_OBSERVER_SESSION;
    const observer = this.sessions.get(key);
    this.rememberClosed(key);
    if (!observer) return;
    this.sessions.delete(key);
    void observer.stop();
  }

  async closeAll(): Promise<void> {
    const observers = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(observers.map(observer => observer.stop().catch(() => undefined)));
  }

  private find(sessionEpoch?: string): BoundedObserver | undefined {
    return this.sessions.get(sessionEpoch ?? DEFAULT_OBSERVER_SESSION);
  }

  private get(sessionEpoch?: string): BoundedObserver | undefined {
    const key = sessionEpoch ?? DEFAULT_OBSERVER_SESSION;
    if (this.closedSessions.has(key)) return undefined;
    const existing = this.sessions.get(key);
    if (existing) {
      // Refresh insertion order so the oldest *idle* session is evicted first.
      this.sessions.delete(key);
      this.sessions.set(key, existing);
      return existing;
    }
    if (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.entries().next().value as [string, BoundedObserver];
      const [oldKey, oldObserver] = oldest;
      this.sessions.delete(oldKey);
      this.rememberClosed(oldKey);
      void oldObserver.stop();
      this.options.onEvent({
        kind: 'observer_gap',
        source: 'client',
        sessionEpoch: oldObserver.sessionEpoch,
        gap: { scope: 'global', reason: 'observer-session-eviction' },
      });
    }
    const observer = new BoundedObserver({
      ...this.options.observerLimits,
      ...(sessionEpoch === undefined ? {} : { sessionEpoch }),
    });
    observer.subscribe(event => this.options.onEvent(event));
    this.sessions.set(key, observer);
    return observer;
  }

  private rememberClosed(key: string): void {
    this.closedSessions.add(key);
    const limit = this.maxSessions * 4;
    while (this.closedSessions.size > limit) {
      const oldest = this.closedSessions.values().next().value as string;
      this.closedSessions.delete(oldest);
    }
  }
}

if (parentPort) {
  const post = (message: WorkerOutbound) => parentPort!.postMessage(message);
  const registry = new ObserverSessionRegistry({
    maxSessions: 16,
    observerLimits: {
      maxQueuedFrames: 64,
      maxQueuedBytes: 8 * 1024 * 1024,
      maxConcurrency: 2,
      taskTimeoutMs: 2_000,
    },
    onEvent: event => post({ type: 'event', event }),
  });
  const postState = (sessionEpoch: string | undefined, direction: ObserverDirection, observer: BoundedObserver) => {
    const state = observer.state();
    const selected = direction === 'client-to-server' ? state.downstream : state.upstream;
    post({ type: 'state', direction, ...(sessionEpoch === undefined ? {} : { sessionEpoch }), state: selected });
  };
  // The host waits for this before reporting a completed start; a worker that cannot run
  // its loop must fail the start instead of producing a false success.
  post({ type: 'ready' });
  parentPort.on('message', (message: WorkerInbound) => {
    try {
      if (message.type === 'chunk') {
        const observer = registry.attach(message.sessionEpoch, message.direction, message.bytes);
        if (observer) postState(message.sessionEpoch, message.direction, observer);
      } else if (message.type === 'close-session') {
        registry.close(message.sessionEpoch);
      } else if (message.type === 'reset') {
        const observer = registry.reset(message.sessionEpoch, message.direction);
        if (observer) postState(message.sessionEpoch, message.direction, observer);
      } else if (message.type === 'control') {
        const observer = registry.control(message.sessionEpoch, message.direction, message.event as ControlEvent | undefined);
        if (observer) postState(message.sessionEpoch, message.direction, observer);
      } else if (message.type === 'set-compression') {
        const observer = registry.setCompression(message.sessionEpoch, message.direction, message.enabled, message.threshold);
        if (observer) postState(message.sessionEpoch, message.direction, observer);
      } else if (message.type === 'set-phase') {
        const observer = registry.setPhase(message.sessionEpoch, message.direction, message.phase as ObserverPhase);
        if (observer) postState(message.sessionEpoch, message.direction, observer);
      } else if (message.type === 'stop') {
        void registry.closeAll().then(() => parentPort!.close());
      }
    } finally {
      // Ack after the chunk has been handed to the bounded observer. The host uses acks
      // to return in-flight message/byte credit; only processing (not enqueueing) frees it.
      if (message.type === 'chunk' && message.chunkId) post({ type: 'ack', chunkId: message.chunkId });
    }
  });
}
