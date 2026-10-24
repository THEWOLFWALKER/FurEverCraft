import { randomUUID } from 'node:crypto';
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

export async function runRelayEntry(config: RelayEntryConfig, ipc: RelayIpc): Promise<void> {
  const sessionEpoch = `relay_session_${randomUUID()}`;
  const { observer: observerConfig, ...relayConfig } = config;
  let observer: ObserverWorkerHost | undefined;
  if (observerConfig?.enabled) {
    try {
      observer = new ObserverWorkerHost({
        onEvent: event => { ipc.send({ type: 'event', protocolVersion: 1, sessionEpoch, event: 'observer', payload: event }); },
        onFailure: reason => { ipc.send({ type: 'event', protocolVersion: 1, sessionEpoch, event: 'diagnostic', payload: { kind: 'observer-failure', reason } }); },
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
}

// Entry points are only launched when this module is the process entry.
if (process.send) {
  const config = JSON.parse(process.env.FUREVERCRAFT_RELAY_CONFIG ?? '{}') as RelayEntryConfig;
  void runRelayEntry(config, { send: message => process.send!(message), on: (event, listener) => process.on(event, listener), off: (event, listener) => process.off(event, listener) });
}
