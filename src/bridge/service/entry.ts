import { randomUUID } from 'node:crypto';
import { redact } from '../../diagnostics/redaction.js';
import { IpcRequestSchema, type IpcRequest } from '../ipc/protocol.js';
import { spawnRelayProcess } from '../relay/spawn.js';
import type { RelayEntryConfig } from '../relay/entry.js';
import { ProcessSupervisor } from '../supervisor.js';
import { BridgeService, type ObserverMonitor } from './orchestrator.js';

/**
 * Passive observer monitor over the relay child's IPC stream. The worker lives in the relay
 * process (it needs the raw chunks); this service only tracks its reported state and failures.
 */
class RelayObserverMonitor implements ObserverMonitor {
  private stateValue: unknown = { running: false, availability: 'unknown', limitation: 'awaiting-relay-child' };
  private readonly failures = new Set<(reason: string) => void>();
  constructor(private readonly onEvent: (event: unknown) => void) {}

  start(): void { /* the relay child owns the worker lifecycle */ }
  async stop(): Promise<void> { /* stopping the relay child stops the worker */ }
  state(): unknown { return this.stateValue; }
  onFailure(listener: (reason: string) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }

  handle(message: unknown): void {
    const value = message as { type?: string; event?: string; payload?: unknown; reason?: string } | undefined;
    if (!value || value.type !== 'event') return;
    if (value.event === 'observer') {
      try { this.onEvent(value.payload); } catch { /* isolated */ }
      return;
    }
    if (value.event === 'diagnostic') {
      const payload = value.payload as { kind?: string; reason?: string } | undefined;
      if (payload?.kind === 'observer-failure') {
        for (const listener of this.failures) { try { listener(payload.reason ?? 'observer-worker-failure'); } catch { /* isolated */ } }
      }
      return;
    }
    if (value.event === 'relay-state') {
      const payload = value.payload as { observer?: unknown } | undefined;
      if (payload?.observer !== undefined) this.stateValue = payload.observer;
    }
  }
}

/**
 * Bridge service child entry. It owns the relay child process, observer worker and the
 * bounded IPC outbox. It is a real process entry (used by the integration fixture) so
 * child exit, IPC closure and shutdown are exercised through fork + IPC, not only
 * through unit-level fakes.
 */
export type BridgeServiceEntryConfig = {
  relay: RelayEntryConfig;
  observer?: { enabled?: boolean };
  shutdownGraceMs?: number;
  helloTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxIpcMessages?: number;
  maxIpcBytes?: number;
};

export type ServiceIpc = {
  send(message: unknown): boolean;
  on(event: 'message' | 'disconnect', listener: (value?: unknown) => void): unknown;
  off?(event: 'message' | 'disconnect', listener: (value?: unknown) => void): unknown;
};

export type BridgeServiceEntryHandle = {
  readonly sessionEpoch: string;
  readonly service: BridgeService;
  stop(reason?: string): Promise<void>;
};

export type ServiceCommandReply =
  | { kind: 'reply'; ok: boolean; result?: unknown; error?: { code: string; message: string } }
  | { kind: 'shutdown' }
  | { kind: 'start-observer' }
  | { kind: 'stop-observer' };

/**
 * Resolve one IPC request against the owning service. Session epoch is checked here so
 * every command (including arm) is fenced to the owner that was handed the epoch.
 */
export function serviceCommandReply(
  request: IpcRequest,
  context: { sessionEpoch: string; service: BridgeService; observer?: ObserverMonitor },
): ServiceCommandReply {
  if (request.sessionEpoch !== context.sessionEpoch) {
    return { kind: 'reply', ok: false, error: { code: 'stale-session', message: 'session epoch mismatch' } };
  }
  switch (request.command) {
    case 'status':
      return { kind: 'reply', ok: true, result: { sessionEpoch: context.sessionEpoch, ...context.service.status(), observer: context.observer?.state() ?? null } };
    case 'capabilities':
      return { kind: 'reply', ok: true, result: { profile: 'client-offline', network: 'disabled', observer: context.observer?.state() ?? null } };
    case 'shutdown':
      return { kind: 'shutdown' };
    case 'start-observer':
      return { kind: 'start-observer' };
    case 'stop-observer':
      return { kind: 'stop-observer' };
    case 'arm': {
      context.service.armControl('operator-ipc-arm');
      const status = context.service.status();
      return { kind: 'reply', ok: true, result: { armed: status.admissionOpen, controlRevoked: status.controlRevoked, status } };
    }
    case 'observe':
      return {
        kind: 'reply', ok: false,
        error: { code: 'observe-unsupported', message: 'the bridge service observer is passive; observe is not supported' },
      };
    default:
      return {
        kind: 'reply', ok: false,
        error: { code: 'command-unsupported', message: `unsupported command: ${String((request as { command?: unknown }).command)}` },
      };
  }
}

export async function runBridgeServiceEntry(
  config: BridgeServiceEntryConfig,
  ipc: ServiceIpc,
  options: { log?: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void } = {},
): Promise<BridgeServiceEntryHandle> {
  const sessionEpoch = `bridge_${randomUUID()}`;
  const bootEpoch = randomUUID();
  const log = options.log ?? ((level, event, fields) => {
    try { process.stderr.write(`${JSON.stringify(redact({ level, event, ...(fields ?? {}) }))}\n`); } catch { /* best effort */ }
  });
  let stopped = false;
  let service!: BridgeService;
  const observerEnabled = config.observer?.enabled !== false;
  const observer = observerEnabled ? new RelayObserverMonitor(event => service?.publishObserver(event)) : undefined;
  const relay = new ProcessSupervisor({
    spawn: () => spawnRelayProcess({ ...config.relay, observer: config.relay.observer ?? { enabled: observerEnabled } }),
    maxRestarts: 0,
    ipcTimeoutMs: config.helloTimeoutMs ?? 5_000,
  });
  if (observer) relay.onMessage(message => observer.handle(message));
  service = new BridgeService({
    relay,
    observer,
    ipc,
    shutdownGraceMs: config.shutdownGraceMs,
    helloTimeoutMs: config.helloTimeoutMs,
    maxRestarts: config.maxRestarts,
    restartWindowMs: config.restartWindowMs,
    backoffBaseMs: config.backoffBaseMs,
    backoffMaxMs: config.backoffMaxMs,
    maxIpcMessages: config.maxIpcMessages,
    maxIpcBytes: config.maxIpcBytes,
    log,
    onFatal: reason => { log('error', 'service-fatal', { reason }); process.exitCode = 1; },
  });

  const respond = (request: IpcRequest, ok: boolean, result?: unknown, error?: { code: string; message: string }) => {
    service.emit({ type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch, ok, ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }) }, true);
  };

  const stop = async (reason = 'shutdown') => {
    if (stopped) return;
    stopped = true;
    await service.stop(reason);
    service.flush();
    try { ipc.off?.('message', onMessage); ipc.off?.('disconnect', onDisconnect); } catch { /* best effort */ }
  };

  const onMessage = (value: unknown) => {
    if (stopped) return;
    const parsed = IpcRequestSchema.safeParse(value);
    // A hello/response/event from the parent is not a command; ignore non-requests.
    if (!parsed.success) return;
    const request = parsed.data;
    const reply = serviceCommandReply(request, { sessionEpoch, service, ...(observer === undefined ? {} : { observer }) });
    if (reply.kind === 'shutdown') {
      respond(request, true, { stopped: true });
      void stop('shutdown').then(() => { if (typeof process.send === 'function') process.exit(0); });
      return;
    }
    if (reply.kind === 'start-observer') {
      observer?.start();
      respond(request, true, { observer: observer?.state() ?? null });
      return;
    }
    if (reply.kind === 'stop-observer') {
      void observer?.stop().then(() => respond(request, true, { observer: observer?.state() ?? null }));
      return;
    }
    respond(request, reply.ok, reply.result, reply.error);
  };

  const onDisconnect = () => { void stop('parent-disconnect'); };

  ipc.send({ type: 'hello', protocolVersion: 1, process: 'runtime', sessionEpoch, bootEpoch, capabilities: ['control', 'observe', 'relay', 'observer'] });
  ipc.on('message', onMessage);
  ipc.on('disconnect', onDisconnect);

  try {
    await service.start();
  } catch (error) {
    log('error', 'service-entry-start-failed', { error: error instanceof Error ? error.message : String(error) });
    service.emit({ type: 'fatal', reason: 'service-entry-start-failed' }, true);
    process.exitCode = 1;
  }

  return { sessionEpoch, service, stop };
}

if (process.send && process.env.FUREVERCRAFT_SERVICE_CONFIG) {
  const config = JSON.parse(process.env.FUREVERCRAFT_SERVICE_CONFIG) as BridgeServiceEntryConfig;
  void runBridgeServiceEntry(config, {
    send: message => process.send!(message),
    on: (event, listener) => process.on(event, listener),
    off: (event, listener) => process.off(event, listener),
  }).then(handle => {
    const shutdown = (signal: string) => { void handle.stop(signal).then(() => process.exit(process.exitCode ?? 0)); };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }, () => { process.exit(1); });
}
