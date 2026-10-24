import { randomUUID } from 'node:crypto';
import type { ObserverEvent } from '../observer/bounded.js';
import { ObserverWorkerHost } from '../observer/host.js';
import { createRawTcpRelay, type RelayConfig } from './raw.js';

/**
 * Relay child entry. Started by the local supervisor via child_process fork. It owns only the
 * raw TCP relay; it accepts control/status requests and posts redacted state, never raw socket
 * write authority to the Runtime.
 *
 * When an observer worker is enabled it lives inside this process and receives a passive copy
 * of every source chunk. Observer failure is reported over IPC and never stops forwarding.
 */
export type RelayEntryConfig = RelayConfig & {
  heartbeatMs?: number;
  observer?: { enabled?: boolean };
};

type RelayIpc = {
  send(message: unknown): boolean;
  on(event: 'message' | 'disconnect', listener: (message?: unknown) => void): unknown;
  off?(event: 'message' | 'disconnect', listener: (message?: unknown) => void): unknown;
};

export type RelayObserverPublisher = {
  /** Forward one observer event, coalescing observations while the IPC channel is pressured. */
  event(event: ObserverEvent): void;
  /** Retry a pending coalesced gap; called from the bounded heartbeat, never per chunk. */
  flushGap(): void;
  pending(): { dropped: number } | undefined;
};

/**
 * Bounded relay->service observation bridge. `ipc.send()` returning false means the
 * parent channel is backpressured: observation events are dropped (never queued here),
 * coalesced into a single explicit global gap per pressure episode, and the first gap is
 * attempted immediately. Relay forwarding never consults this state.
 */
export function createRelayObserverPublisher(ipc: Pick<RelayIpc, 'send'>, sessionEpoch: string): RelayObserverPublisher {
  let pressure: { dropped: number } | undefined;
  const send = (event: string, payload: unknown): boolean => {
    try { return ipc.send({ type: 'event', protocolVersion: 1, sessionEpoch, event, payload }) !== false; } catch { return false; }
  };
  const sendGap = (dropped: number): boolean => send('observer', {
    kind: 'observer_gap', source: 'client', sessionEpoch: `observer_ipc_${sessionEpoch}`,
    gap: { scope: 'global', reason: 'relay-ipc-backpressure', dropped },
  } satisfies ObserverEvent);
  return {
    event(event) {
      if (pressure && event.kind === 'observation') { pressure.dropped += 1; return; }
      if (send('observer', event)) return;
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

export async function runRelayEntry(config: RelayEntryConfig, ipc: RelayIpc): Promise<{ stop: () => Promise<void> }> {
  const sessionEpoch = `relay_session_${randomUUID()}`;
  const { observer: observerConfig, ...relayConfig } = config;
  const observerEvents = createRelayObserverPublisher(ipc, sessionEpoch);
  let observer: ObserverWorkerHost | undefined;
  if (observerConfig?.enabled) {
    try {
      observer = new ObserverWorkerHost({
        onEvent: event => { observerEvents.event(event); },
        onFailure: reason => { try { ipc.send({ type: 'event', protocolVersion: 1, sessionEpoch, event: 'diagnostic', payload: { kind: 'observer-failure', reason } }); } catch { /* bounded best effort */ } },
      });
      observer.start();
    } catch {
      observer = undefined;
      ipc.send({ type: 'event', protocolVersion: 1, sessionEpoch, event: 'diagnostic', payload: { kind: 'observer-failure', reason: 'observer-worker-unavailable' } });
    }
  }
  const relay = createRawTcpRelay({
    ...relayConfig,
    onChunk: (direction, chunk) => {
      // The worker owns bounded framing; a failure here degrades observation only.
      try { observer?.attach(direction, chunk); } catch { /* never block forwarding */ }
    },
  });
  await relay.start();
  ipc.send({ type: 'hello', protocolVersion: 1, process: 'relay', sessionEpoch, bootEpoch: sessionEpoch, capabilities: observer ? ['control', 'observe', 'observer'] : ['control', 'observe'] });
  const heartbeat = setInterval(() => {
    // Retry at most one coalesced observation gap per heartbeat; never queue observation data.
    observerEvents.flushGap();
    ipc.send({
      type: 'event', protocolVersion: 1, sessionEpoch, event: 'relay-state',
      payload: { sessions: relay.sessions().length, ...(observer === undefined ? {} : { observer: observer.state() }) },
    });
  }, config.heartbeatMs ?? 250);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    try { await observer?.stop(); } catch { /* best effort */ }
    await relay.stop().catch(() => undefined);
  };
  ipc.on('message', (value?: unknown) => {
    const request = value as { type?: string; requestId?: string; sessionEpoch?: string; command?: string };
    if (request.type !== 'request' || !request.requestId) return;
    if (request.sessionEpoch !== sessionEpoch) {
      ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch, ok: false, error: { code: 'stale-session', message: 'session epoch mismatch' } });
      return;
    }
    if (request.command === 'status') ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch, ok: true, result: { sessions: relay.sessions().length, address: relay.address, observer: observer?.state() ?? null } });
    else if (request.command === 'shutdown') void stop().then(() => { ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId!, sessionEpoch, ok: true, result: { stopped: true } }); process.exit(0); });
    else ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch, ok: false, error: { code: 'unsupported-command', message: String(request.command) } });
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
