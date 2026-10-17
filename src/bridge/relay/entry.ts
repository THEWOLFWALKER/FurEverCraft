import { createRawTcpRelay, type RelayConfig } from './raw.js';

/**
 * Relay child entry. Started by the local supervisor via child_process fork. It owns only the
 * raw TCP relay; it accepts control/status requests and posts redacted state, never raw socket
 * write authority to the Runtime.
 */
export type RelayEntryConfig = RelayConfig & { heartbeatMs?: number };

export async function runRelayEntry(config: RelayEntryConfig, ipc: { send(message: unknown): boolean; on(event: 'message', listener: (message: unknown) => void): unknown }): Promise<void> {
  const relay = createRawTcpRelay(config);
  await relay.start();
  const sessionEpoch = `relay_session_${Date.now().toString(36)}`;
  ipc.send({ type: 'hello', protocolVersion: 1, process: 'relay', sessionEpoch, bootEpoch: sessionEpoch, capabilities: ['control', 'observe'] });
  const heartbeat = setInterval(() => { ipc.send({ type: 'event', protocolVersion: 1, sessionEpoch, event: 'relay-state', payload: { sessions: relay.sessions().length } }); }, config.heartbeatMs ?? 250);
  ipc.on('message', message => {
    const request = message as { type?: string; requestId?: string; sessionEpoch?: string; command?: string };
    if (request.type !== 'request' || !request.requestId) return;
    if (request.sessionEpoch !== sessionEpoch) {
      ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch, ok: false, error: { code: 'stale-session', message: 'session epoch mismatch' } });
      return;
    }
    if (request.command === 'status') ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch, ok: true, result: { sessions: relay.sessions().length, address: relay.address } });
    else if (request.command === 'shutdown') void relay.stop().then(() => { clearInterval(heartbeat); ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId!, sessionEpoch, ok: true, result: { stopped: true } }); process.exit(0); });
    else ipc.send({ type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch, ok: false, error: { code: 'unsupported-command', message: String(request.command) } });
  });
}

// Entry points are only launched when this module is the process entry.
if (process.send) {
  const config = JSON.parse(process.env.FUREVERCRAFT_RELAY_CONFIG ?? '{}') as RelayEntryConfig;
  void runRelayEntry(config, { send: message => process.send!(message), on: (event, listener) => process.on(event, listener) });
}
