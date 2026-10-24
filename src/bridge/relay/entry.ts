import { randomUUID } from 'node:crypto';
import type { ObserverDirection, ObserverEvent } from '../observer/bounded.js';
import { ObserverWorkerHost } from '../observer/host.js';
import { createRawTcpRelay, type RelayConfig } from './raw.js';

/**
 * Relay child entry. Started by the local supervisor via child_process fork. It owns only the
 * raw TCP relay; it accepts control/status requests and posts redacted state, never raw socket
 * write authority to the Runtime.
 *
 * Observation is scoped per TCP session. Each session owns a fresh observer host/worker (and
 * therefore fresh framing offsets, frame sequences, compression and park state); observation
 * events carry both the relay session identity and the observer epoch. A sequential session
 * can never inherit state from a closed one, and concurrent sessions cannot corrupt each
 * other. Observer failure is reported over IPC and never stops forwarding.
 */
export type RelayEntryConfig = RelayConfig & {
  heartbeatMs?: number;
  observer?: { enabled?: boolean };
};

type RelayIpc = {
  /**
   * IPC channel contract: `false` means the message was accepted and queued by the channel
   * (Node IPC backpressure), NOT that it was rejected. Only a thrown error means the message
   * was not handed off. Callers must never retry/resend a message because of `false`.
   */
  send(message: unknown): boolean;
  on(event: 'message' | 'disconnect', listener: (message?: unknown) => void): unknown;
  off?(event: 'message' | 'disconnect', listener: (message?: unknown) => void): unknown;
};

export type RelayObserverPublisher = {
  /** Forward one observer event, coalescing observations while the IPC channel is unavaliable. */
  event(event: ObserverEvent): void;
  /** Retry a pending coalesced gap; called from the bounded heartbeat, never per chunk. */
  flushGap(): void;
  pending(): { dropped: number } | undefined;
};

/**
 * Bounded relay->service observation bridge.
 *
 * The channel contract is explicit: `ipc.send()` returning false means the parent channel
 * queued the message; it was delivered exactly once and must not be retried. Observation
 * events are only dropped (and coalesced into one explicit global gap per episode) when the
 * channel rejects synchronously by throwing. Relay forwarding never consults this state.
 */
export function createRelayObserverPublisher(
  ipc: Pick<RelayIpc, 'send'>,
  sessionEpoch: string,
  relaySessionEpoch?: string,
): RelayObserverPublisher {
  let pressure: { dropped: number } | undefined;
  const withIdentity = (event: ObserverEvent): ObserverEvent => (
    relaySessionEpoch === undefined
      ? event
      : ({ ...event, relaySessionEpoch } as ObserverEvent & { relaySessionEpoch: string })
  );
  const send = (event: string, payload: unknown): boolean => {
    try {
      // false is a queued delivery, not a rejection: the message is handed off once.
      ipc.send({ type: 'event', protocolVersion: 1, sessionEpoch, ...(relaySessionEpoch === undefined ? {} : { relaySessionEpoch }), event, payload });
      return true;
    } catch { return false; }
  };
  const sendGap = (dropped: number): boolean => send('observer', withIdentity({
    kind: 'observer_gap', source: 'client', sessionEpoch: `observer_ipc_${relaySessionEpoch ?? sessionEpoch}`,
    gap: { scope: 'global', reason: 'relay-ipc-backpressure', dropped },
  } satisfies ObserverEvent));
  return {
    event(event) {
      if (pressure && event.kind === 'observation') { pressure.dropped += 1; return; }
      if (send('observer', withIdentity(event))) return;
      pressure = pressure ?? { dropped: 0 };
      pressure.dropped += 1;
      if (sendGap(pressure.dropped)) pressure = undefined;
    },
    flushGap() {
      if (!pressure) return;
      if (sendGap(pressure.dropped)) pressure = undefined;
    },
    pending() { return pressure ? { ...pressure } : undefined; },
  };
}

/** Structural surface the relay session manager needs from an observer host. */
export type RelayObserverHost = {
  readonly sessionEpoch: string;
  start(): void;
  attach(direction: ObserverDirection, bytes: Uint8Array): boolean;
  state(): unknown;
  resetAll?(): void;
  stop(): Promise<void>;
};

export type RelayObserverHostOptions = {
  relaySessionEpoch: string;
  onEvent: (event: ObserverEvent) => void;
  onFailure: (reason: string) => void;
};

export type RelayObserverHostFactory = (options: RelayObserverHostOptions) => RelayObserverHost;

const defaultObserverHostFactory: RelayObserverHostFactory = options => new ObserverWorkerHost({
  onEvent: options.onEvent,
  onFailure: options.onFailure,
});

type HostEntry = { host: RelayObserverHost; publisher: RelayObserverPublisher; observerEpoch: string };

export type RelayObserverSupervisorState = {
  enabled: boolean;
  paused: boolean;
  running: boolean;
  availability: 'degraded' | 'unknown';
  observerEpoch: string;
  sessions: Array<{ relaySessionEpoch: string; observerEpoch: string; state: unknown }>;
  /** Number of relay sessions bound for observation (may exceed installed hosts on failure). */
  boundSessions: number;
  [key: string]: unknown;
};

/**
 * Owns one observer host per active TCP session. This is the fix for process-wide framing
 * state: the relay only forwards `onChunk` with its session epoch, and this supervisor keeps
 * each session's decoder, frame sequence, compression/park state and observer worker isolated.
 */
export class RelayObserverSupervisor {
  readonly enabled: boolean;
  private epochValue = `observer_supervisor_${randomUUID()}`;
  private readonly hosts = new Map<string, HostEntry>();
  private readonly sessions = new Set<string>();
  private paused = false;
  private stopped = false;
  private readonly observerEnabled: boolean;
  private readonly createHost: RelayObserverHostFactory;

  constructor(
    private readonly ipc: Pick<RelayIpc, 'send'>,
    private readonly sessionEpoch: string,
    options: { enabled: boolean; createHost?: RelayObserverHostFactory } = { enabled: false },
  ) {
    this.enabled = options.enabled === true;
    this.observerEnabled = this.enabled;
    this.createHost = options.createHost ?? defaultObserverHostFactory;
  }

  get observerEpoch(): string { return this.epochValue; }

  /** Register a newly accepted TCP session before any chunk is observed. */
  bindSession(relaySessionEpoch: string): void {
    if (this.stopped) return;
    this.sessions.add(relaySessionEpoch);
    if (this.observerEnabled && !this.paused) this.ensureHost(relaySessionEpoch);
  }

  /** Discard all observation state for a closed session. */
  closeSession(relaySessionEpoch: string): void {
    this.sessions.delete(relaySessionEpoch);
    const entry = this.hosts.get(relaySessionEpoch);
    if (!entry) return;
    this.hosts.delete(relaySessionEpoch);
    void Promise.resolve(entry.host.stop()).catch(() => undefined);
  }

  attach(relaySessionEpoch: string, direction: ObserverDirection, bytes: Uint8Array): boolean {
    if (!this.enabled || this.paused || this.stopped) return false;
    this.sessions.add(relaySessionEpoch);
    const entry = this.ensureHost(relaySessionEpoch);
    if (!entry) return false;
    try { return entry.host.attach(direction, bytes); } catch { return false; }
  }

  flushGaps(): void {
    for (const entry of this.hosts.values()) entry.publisher.flushGap();
  }

  state(): RelayObserverSupervisorState {
    const sessions = [...this.hosts.entries()].map(([relaySessionEpoch, entry]) => ({
      relaySessionEpoch, observerEpoch: entry.observerEpoch, state: entry.host.state(),
    }));
    const running = sessions.some(session => (session.state as { running?: unknown } | undefined)?.running === true);
    const availability: 'degraded' | 'unknown' = this.enabled && !this.paused && !this.stopped && sessions.length > 0
      && sessions.every(session => (session.state as { availability?: unknown } | undefined)?.availability === 'degraded')
      ? 'degraded' : 'unknown';
    const single = sessions.length === 1 && sessions[0]?.state && typeof sessions[0].state === 'object'
      ? sessions[0].state as Record<string, unknown> : {};
    return {
      ...single,
      enabled: this.enabled,
      paused: this.paused,
      running,
      availability,
      observerEpoch: this.epochValue,
      sessions,
      boundSessions: this.sessions.size,
    };
  }

  /**
   * Recovery command: replace every host/worker with a fresh one (new epochs) and reset both
   * directions, so a globally parked/overflowed/backpressured observer can resume.
   *
   * `ensureHost` returns undefined when the worker cannot be created or started. Installing no
   * worker for an active session is not a recovery: report it as a failure so the parent does
   * not close admission on the strength of an observer that does not exist.
   */
  async startObservation(): Promise<{ supported: boolean; recovered: boolean; reason?: string; installedHosts: number; expectedHosts: number; reset: 'all-directions'; observerEpoch: string; observer: RelayObserverSupervisorState }> {
    if (!this.enabled) return { supported: false, recovered: false, installedHosts: 0, expectedHosts: this.sessions.size, reset: 'all-directions', observerEpoch: this.epochValue, observer: this.state() };
    this.stopped = false;
    this.paused = false;
    this.epochValue = `observer_supervisor_${randomUUID()}`;
    await this.resetHosts();
    const expected = [...this.sessions];
    let installed = 0;
    for (const relaySessionEpoch of expected) if (this.ensureHost(relaySessionEpoch)) installed += 1;
    // A partial install is also an incomplete recovery: every bound session must own a host,
    // otherwise its observation state is silently absent.
    if (installed < expected.length) {
      return {
        supported: true, recovered: false, reason: 'observer-recovery-failed',
        installedHosts: installed, expectedHosts: expected.length,
        reset: 'all-directions', observerEpoch: this.epochValue, observer: this.state(),
      };
    }
    return { supported: true, recovered: true, installedHosts: installed, expectedHosts: expected.length, reset: 'all-directions', observerEpoch: this.epochValue, observer: this.state() };
  }

  /** Stop interpreting without killing the relay; `startObservation` creates fresh hosts. */
  async stopObservation(): Promise<{ supported: boolean; stopped: boolean; observerEpoch: string; observer: RelayObserverSupervisorState }> {
    this.paused = true;
    await this.resetHosts();
    return { supported: this.enabled, stopped: true, observerEpoch: this.epochValue, observer: this.state() };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.paused = true;
    await this.resetHosts();
    this.sessions.clear();
  }

  private ensureHost(relaySessionEpoch: string): HostEntry | undefined {
    const existing = this.hosts.get(relaySessionEpoch);
    if (existing) return existing;
    const publisher = createRelayObserverPublisher(this.ipc, this.sessionEpoch, relaySessionEpoch);
    let host: RelayObserverHost;
    try {
      host = this.createHost({
        relaySessionEpoch,
        onEvent: event => publisher.event(event),
        onFailure: reason => this.reportFailure(relaySessionEpoch, reason),
      });
      host.start();
    } catch {
      this.reportFailure(relaySessionEpoch, 'observer-worker-unavailable');
      return undefined;
    }
    const entry: HostEntry = { host, publisher, observerEpoch: host.sessionEpoch };
    this.hosts.set(relaySessionEpoch, entry);
    return entry;
  }

  private async resetHosts(): Promise<void> {
    const entries = [...this.hosts.values()];
    this.hosts.clear();
    await Promise.all(entries.map(async entry => {
      try { await entry.host.stop(); } catch { /* best effort */ }
    }));
  }

  private reportFailure(relaySessionEpoch: string, reason: string): void {
    try {
      this.ipc.send({
        type: 'event', protocolVersion: 1, sessionEpoch: this.sessionEpoch, relaySessionEpoch, event: 'diagnostic',
        payload: { kind: 'observer-failure', reason, relaySessionEpoch, observerEpoch: this.epochValue },
      });
    } catch { /* bounded best effort; the channel may already be gone */ }
  }
}

export async function runRelayEntry(config: RelayEntryConfig, ipc: RelayIpc): Promise<{ stop: () => Promise<void> }> {
  const sessionEpoch = `relay_session_${randomUUID()}`;
  const { observer: observerConfig, ...relayConfig } = config;
  const observers = new RelayObserverSupervisor(ipc, sessionEpoch, { enabled: observerConfig?.enabled === true });
  const relay = createRawTcpRelay({
    ...relayConfig,
    onChunk: (direction, chunk, session) => {
      // The worker owns bounded framing; a failure here degrades observation only. State is
      // scoped by the relay session epoch so concurrent sessions never share decoders.
      try { observers.attach(session.sessionEpoch, direction, chunk); } catch { /* never block forwarding */ }
    },
  });
  const unsubscribeSessions = relay.onSession(session => {
    observers.bindSession(session.sessionEpoch);
    session.onClose(() => observers.closeSession(session.sessionEpoch));
  });
  await relay.start();
  // Advertise only commands this entry actually implements. `observe` is not an IPC command
  // here (observation is passive); advertising it invites a caller to request an operation
  // that can only fail with command-unsupported.
  ipc.send({
    type: 'hello', protocolVersion: 1, process: 'relay', sessionEpoch, bootEpoch: sessionEpoch,
    capabilities: observers.enabled ? ['control', 'observer'] : ['control'],
  });
  const heartbeat = setInterval(() => {
    // Retry at most one coalesced observation gap per session per heartbeat; never queue
    // observation data. A false send here means the event was queued by the channel.
    observers.flushGaps();
    ipc.send({
      type: 'event', protocolVersion: 1, sessionEpoch, event: 'relay-state',
      payload: { sessions: relay.sessions().length, observer: observers.state() },
    });
  }, config.heartbeatMs ?? 250);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    unsubscribeSessions();
    try { await observers.stop(); } catch { /* best effort */ }
    await relay.stop().catch(() => undefined);
  };
  const respond = (requestId: string, ok: boolean, result?: unknown, error?: { code: string; message: string }) => {
    ipc.send({ type: 'response', protocolVersion: 1, requestId, sessionEpoch, ok, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) });
  };
  ipc.on('message', (value?: unknown) => {
    const request = value as { type?: string; requestId?: string; sessionEpoch?: string; command?: string };
    if (request.type !== 'request' || !request.requestId) return;
    if (request.sessionEpoch !== sessionEpoch) {
      respond(request.requestId, false, undefined, { code: 'stale-session', message: 'session epoch mismatch' });
      return;
    }
    if (request.command === 'status') {
      respond(request.requestId, true, { sessions: relay.sessions().length, address: relay.address, observer: observers.state() });
    } else if (request.command === 'start-observer') {
      if (!observers.enabled) {
        respond(request.requestId, false, undefined, { code: 'command-unsupported', message: 'observer is disabled for this relay' });
        return;
      }
      void observers.startObservation().then(
        result => result.recovered
          ? respond(request.requestId!, true, result)
          : respond(request.requestId!, false, result, { code: 'observer-recovery-failed', message: result.reason ?? 'observer recovery failed' }),
        () => respond(request.requestId!, false, undefined, { code: 'observer-recovery-failed', message: 'observer recovery failed' }),
      );
    } else if (request.command === 'stop-observer') {
      if (!observers.enabled) {
        respond(request.requestId, false, undefined, { code: 'command-unsupported', message: 'observer is disabled for this relay' });
        return;
      }
      void observers.stopObservation().then(
        result => respond(request.requestId!, true, result),
        () => respond(request.requestId!, false, undefined, { code: 'observer-stop-failed', message: 'observer stop failed' }),
      );
    } else if (request.command === 'shutdown') {
      void stop().then(() => { respond(request.requestId!, true, { stopped: true }); process.exit(0); });
    } else {
      respond(request.requestId, false, undefined, { code: 'command-unsupported', message: `unsupported command: ${String(request.command)}` });
    }
  });
  // Parent loss must not orphan the listener or its sockets.
  ipc.on('disconnect', () => { void stop().then(() => process.exit(0)); });
  return { stop };
}

// Entry points are only launched when this module is the process entry.
if (process.send && process.env.FUREVERCRAFT_RELAY_CONFIG) {
  const config = JSON.parse(process.env.FUREVERCRAFT_RELAY_CONFIG ?? '{}') as RelayEntryConfig;
  void runRelayEntry(config, { send: message => process.send!(message), on: (event, listener) => process.on(event, listener), off: (event, listener) => process.off(event, listener) }).then(handle => {
    // SIGTERM is a graceful request (flush/close sessions), not an abrupt kill. The supervisor
    // falls back to force-kill only when the bounded grace expires without an exit.
    const shutdown = () => { void handle.stop().then(() => process.exit(0)).catch(() => process.exit(1)); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }, () => { process.exit(1); });
}
