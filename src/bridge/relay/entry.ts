import { randomUUID } from 'node:crypto';
import { ObserverWorkerHost, stoppedObserverState, type ObserverHostLimits } from '../observer/host.js';
import { createRawTcpRelay, type RelayConfig } from './raw.js';

/**
 * Relay child entry. Started by the local supervisor via child_process fork. It owns only the
 * raw TCP relay; it accepts control/status requests and posts redacted state, never raw socket
 * write authority to the Runtime.
 *
 * When an observer worker is enabled it lives inside this process and receives a passive copy
 * of every source chunk. Observer failure is reported over IPC and never stops forwarding.
 * start-observer/stop-observer really create and terminate that worker; a completed response is
 * only sent after the worker reports ready or has actually stopped.
 */
export type RelayEntryConfig = RelayConfig & {
  heartbeatMs?: number;
  observer?: {
    enabled?: boolean;
    maxSessions?: number;
    limits?: Partial<ObserverHostLimits>;
    readyTimeoutMs?: number;
  };
};

type RelayIpc = {
  send(message: unknown): boolean;
  on(event: 'message' | 'disconnect', listener: (message?: unknown) => void): unknown;
  off?(event: 'message' | 'disconnect', listener: (message?: unknown) => void): unknown;
};

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function runRelayEntry(config: RelayEntryConfig, ipc: RelayIpc): Promise<{ stop: () => Promise<void> }> {
  const sessionEpoch = `relay_session_${randomUUID()}`;
  const { observer: observerConfig, ...relayConfig } = config;
  let observer: ObserverWorkerHost | undefined;
  const observerState = () => observer?.state() ?? stoppedObserverState();
  const sendDiagnostic = (reason: string) => {
    ipc.send({ type: 'event', protocolVersion: 1, sessionEpoch, event: 'diagnostic', payload: { kind: 'observer-failure', reason } });
  };

  const startObserver = async (): Promise<unknown> => {
    if (observer) return observer.state();
    const host = new ObserverWorkerHost({
      onEvent: event => { ipc.send({ type: 'event', protocolVersion: 1, sessionEpoch, event: 'observer', payload: event }); },
      onFailure: reason => { sendDiagnostic(reason); },
      limits: observerConfig?.limits,
    });
    try {
      host.start();
      await host.ready(observerConfig?.readyTimeoutMs ?? 2_000);
    } catch (error) {
      await host.stop().catch(() => undefined);
      throw error;
    }
    if (stopping) {
      await host.stop().catch(() => undefined);
      throw new Error('relay-stopping');
    }
    observer = host;
    return observer.state();
  };

  const stopObserver = async (): Promise<unknown> => {
    const current = observer;
    observer = undefined;
    if (current) {
      try { await current.stop(); } catch { /* terminate is best effort */ }
    }
    return observerState();
  };

  let stopping = false;
  // Boot-time enablement is controlled by config. An explicit start-observer can still start
  // the worker later even when this flag was false.
  if (observerConfig?.enabled) {
    try { await startObserver(); }
    catch { sendDiagnostic('observer-worker-unavailable'); }
  }

  const relay = createRawTcpRelay({
    ...relayConfig,
    onChunk: (direction, chunk, relaySessionEpoch) => {
      // The worker owns bounded framing; a failure here degrades observation only.
      try { observer?.attach(direction, chunk, relaySessionEpoch); } catch { /* never block forwarding */ }
    },
    onSessionClose: relaySessionEpoch => {
      try { observer?.closeSession(relaySessionEpoch); } catch { /* never block teardown */ }
    },
  });
  await relay.start();
  // Advertise only commands this entry actually implements. `observe` is not an IPC command
  // here (observation is passive); advertising it invites a caller to request an operation
  // that can only fail with command-unsupported. `observer` is advertised when observation is
  // configured for this relay (matching the v0.2 `observers.enabled` semantics).
  ipc.send({
    type: 'hello', protocolVersion: 1, process: 'relay', sessionEpoch, bootEpoch: sessionEpoch,
    capabilities: observerConfig?.enabled === true ? ['control', 'observer'] : ['control'],
  });
  const heartbeat = setInterval(() => {
    ipc.send({
      type: 'event', protocolVersion: 1, sessionEpoch, event: 'relay-state',
      payload: { sessions: relay.sessions().length, quota: relay.quota(), observer: observerState() },
    });
  }, config.heartbeatMs ?? 250);

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    try { await observer?.stop(); } catch { /* best effort */ }
    observer = undefined;
    await relay.stop().catch(() => undefined);
  };
  ipc.on('message', (value?: unknown) => {
    const request = value as { type?: string; requestId?: string; sessionEpoch?: string; command?: string };
    if (request.type !== 'request' || !request.requestId) return;
    if (request.sessionEpoch !== sessionEpoch) {
      ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch, ok: false, error: { code: 'stale-session', message: 'session epoch mismatch' } });
      return;
    }
    if (request.command === 'status') {
      ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch, ok: true, result: { sessions: relay.sessions().length, address: relay.address, quota: relay.quota(), observer: observerState() } });
    } else if (request.command === 'start-observer') {
      void startObserver().then(
        state => ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId!, sessionEpoch, ok: true, result: { accepted: true, completed: true, status: 'running', observer: state } }),
        error => ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId!, sessionEpoch, ok: false, error: { code: 'observer-start-failed', message: errorText(error) } }),
      );
    } else if (request.command === 'stop-observer') {
      void stopObserver().then(
        state => ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId!, sessionEpoch, ok: true, result: { accepted: true, completed: true, status: 'stopped', observer: state } }),
        error => ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId!, sessionEpoch, ok: false, error: { code: 'observer-stop-failed', message: errorText(error) } }),
      );
    } else if (request.command === 'shutdown') {
      void stop().then(() => { ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId!, sessionEpoch, ok: true, result: { stopped: true } }); process.exit(0); });
    } else {
      ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch, ok: false, error: { code: 'unsupported-command', message: String(request.command) } });
    }
  });
  // Parent loss must not orphan the listener or its sockets.
  ipc.on('disconnect', () => { void stop().then(() => process.exit(0)); });
  return { stop };
}

// Entry points are only launched when this module is the process entry. Requiring the config
// env var (which the spawn helper always sets) keeps the bootstrap from firing when the module
// is merely imported by a test harness that happens to expose an IPC channel.
if (process.send && process.env.FUREVERCRAFT_RELAY_CONFIG) {
  const config = JSON.parse(process.env.FUREVERCRAFT_RELAY_CONFIG) as RelayEntryConfig;
  void runRelayEntry(config, { send: message => process.send!(message), on: (event, listener) => process.on(event, listener), off: (event, listener) => process.off(event, listener) }).then(handle => {
    // SIGTERM is a graceful request (flush/close sessions), not an abrupt kill. The supervisor
    // falls back to force-kill only when the bounded grace expires without an exit.
    const shutdown = () => { void handle.stop().then(() => process.exit(0)).catch(() => process.exit(1)); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }, () => { process.exit(1); });
}
