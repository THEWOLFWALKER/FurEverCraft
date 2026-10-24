import { randomUUID } from 'node:crypto';
import { redact } from '../../diagnostics/redaction.js';
import { IpcRequestSchema, type IpcRequest } from '../ipc/protocol.js';
import { spawnRelayProcess } from '../relay/spawn.js';
import type { RelayEntryConfig } from '../relay/entry.js';
import { ProcessSupervisor } from '../supervisor.js';
import { BridgeService, type BridgeShutdownResult, type ObserverMonitor } from './orchestrator.js';

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

  /** Adopt the observer state returned by a relay recovery/stop command. */
  applyResult(result: unknown): void {
    const observer = (result as { observer?: unknown } | undefined)?.observer;
    if (observer !== undefined) this.stateValue = observer;
  }

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
        // Never leave a stale 'running' report after a worker failure: admission arming reads
        // this state, and a later relay-state heartbeat may not arrive before the operator arm.
        const current = this.stateValue && typeof this.stateValue === 'object'
          ? this.stateValue as Record<string, unknown> : {};
        this.stateValue = { ...current, running: false, availability: 'unknown', lastFailure: payload.reason ?? 'observer-worker-failure' };
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
  /** Optional profile/network labels supplied by the caller that assembled this config. */
  profile?: string;
  network?: string;
  shutdownGraceMs?: number;
  helloTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxIpcMessages?: number;
  maxIpcBytes?: number;
  /** Explicit capability report; defaults are derived from the configured relay target. */
  capabilities?: { profile?: string; network?: string };
};

export type ServiceIpc = {
  send(message: unknown): boolean;
  on(event: 'message' | 'disconnect', listener: (value?: unknown) => void): unknown;
  off?(event: 'message' | 'disconnect', listener: (value?: unknown) => void): unknown;
};

export type BridgeServiceEntryHandle = {
  readonly sessionEpoch: string;
  readonly service: BridgeService;
  stop(reason?: string): Promise<BridgeShutdownResult>;
};

export type ServiceCommandReply =
  | { kind: 'reply'; ok: boolean; result?: unknown; error?: { code: string; message: string } }
  | { kind: 'shutdown' }
  | { kind: 'start-observer' }
  | { kind: 'stop-observer' };

/**
 * Real capability report for the configured service. Target/network come from the relay
 * configuration actually handed to this child; profile is reported only when the caller
 * supplied it (`unspecified` otherwise, never a guessed profile).
 */
export function describeBridgeServiceCapabilities(config: BridgeServiceEntryConfig, observerState: unknown) {
  const relay = config.relay;
  const profile = config.capabilities?.profile ?? config.profile ?? 'unspecified';
  const network = config.capabilities?.network ?? config.network
    ?? (relay.allowMinecraftUpstream ? 'upstream-explicit' : 'disabled');
  return {
    profile,
    network,
    target: { host: relay.targetHost, port: relay.targetPort, source: 'configured-target' },
    upstream: { enabled: relay.allowMinecraftUpstream === true, rewriteHandshake: relay.rewriteHandshake === true },
    observer: observerState,
  };
}

/**
 * Resolve one IPC request against the owning service. Session epoch is checked here so
 * every command (including arm) is fenced to the owner that was handed the epoch.
 */
export function serviceCommandReply(
  request: IpcRequest,
  context: { sessionEpoch: string; service: BridgeService; observer?: ObserverMonitor; config?: BridgeServiceEntryConfig },
): ServiceCommandReply {
  if (request.sessionEpoch !== context.sessionEpoch) {
    return { kind: 'reply', ok: false, error: { code: 'stale-session', message: 'session epoch mismatch' } };
  }
  switch (request.command) {
    case 'status':
      return { kind: 'reply', ok: true, result: { sessionEpoch: context.sessionEpoch, ...context.service.status(), observer: context.observer?.state() ?? null } };
    case 'capabilities':
      return {
        kind: 'reply', ok: true,
        result: context.config
          ? describeBridgeServiceCapabilities(context.config, context.observer?.state() ?? null)
          : { profile: 'unspecified', network: 'disabled', target: null, observer: context.observer?.state() ?? null },
      };
    case 'shutdown':
      return { kind: 'shutdown' };
    case 'start-observer':
      if (context.observer === undefined) {
        return { kind: 'reply', ok: false, error: { code: 'command-unsupported', message: 'observer is not configured for this service' } };
      }
      return { kind: 'start-observer' };
    case 'stop-observer':
      if (context.observer === undefined) {
        return { kind: 'reply', ok: false, error: { code: 'command-unsupported', message: 'observer is not configured for this service' } };
      }
      return { kind: 'stop-observer' };
    case 'arm': {
      const armed = context.service.armControl('operator-ipc-arm');
      const refusal = context.service.armRefusalReason;
      const status = context.service.status();
      return armed
        ? { kind: 'reply', ok: true, result: { armed: true, controlRevoked: status.controlRevoked, status } }
        : {
          kind: 'reply', ok: false,
          result: { armed: false, controlRevoked: status.controlRevoked, ...(refusal === undefined ? {} : { refusal }), status },
          error: { code: 'control-arm-refused', message: `control cannot be armed: ${refusal ?? 'unspecified-refusal'}` },
        };
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
  let stopPromise: Promise<BridgeShutdownResult> | undefined;
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

  const stop = (reason = 'shutdown'): Promise<BridgeShutdownResult> => {
    if (stopPromise) return stopPromise;
    // Stop accepting commands while shutdown is in flight; the shutdown reply itself is sent
    // only after the service reports its real stop outcome.
    stopped = true;
    stopPromise = (async () => {
      const result = await service.stop(reason);
      service.flush();
      try { ipc.off?.('message', onMessage); ipc.off?.('disconnect', onDisconnect); } catch { /* best effort */ }
      return result;
    })();
    return stopPromise;
  };

  const onMessage = (value: unknown) => {
    if (stopped) return;
    const parsed = IpcRequestSchema.safeParse(value);
    // A hello/response/event from the parent is not a command; ignore non-requests.
    if (!parsed.success) return;
    const request = parsed.data;
    const reply = serviceCommandReply(request, { sessionEpoch, service, ...(observer === undefined ? {} : { observer }), config });
    if (reply.kind === 'shutdown') {
      // Acknowledge only after the service has actually attempted to stop every child. A
      // per-child failure or a forced escalation is reported as `stopped:false`, never as a
      // clean stop.
      void stop('shutdown').then(result => {
        // The request itself completed; its result carries whether the shutdown was clean.
        // Sending ok:false here would make the correlated transport discard `forced`/`error`.
        respond(
          request,
          true,
          { stopped: result.stopped, ...(result.stopped ? {} : { error: result.error ?? 'shutdown-failed', forced: result.forced }) },
        );
        if (typeof process.send === 'function') process.exit(result.stopped ? 0 : 1);
      });
      return;
    }
    if (reply.kind === 'start-observer') {
      // Forward recovery to the owning relay child. A local no-op success would leave a
      // globally parked/overflowed observer unrecoverable while reporting success.
      void relay.request('start-observer').then(
        result => { observer?.applyResult(result); respond(request, true, result); },
        error => respond(request, false, undefined, { code: 'observer-recovery-failed', message: errorText(error) }),
      );
      return;
    }
    if (reply.kind === 'stop-observer') {
      void relay.request('stop-observer').then(
        result => { observer?.applyResult(result); respond(request, true, result); },
        error => respond(request, false, undefined, { code: 'observer-stop-failed', message: errorText(error) }),
      );
      return;
    }
    respond(request, reply.ok, reply.result, reply.error);
  };

  const onDisconnect = () => { void stop('parent-disconnect').then(result => process.exit(result.stopped ? 0 : 1)); };

  ipc.on('message', onMessage);
  ipc.on('disconnect', onDisconnect);

  try {
    await service.start();
  } catch (error) {
    log('error', 'service-entry-start-failed', { error: errorText(error) });
    service.emit({ type: 'fatal', reason: 'service-entry-start-failed' }, true);
    // Never advertise a service that never reached running/degraded. Do not send hello:
    // the parent's waitForHello must fail so the command exits non-zero instead of
    // reporting an optimistic result. Then release the relay child and exit non-zero.
    await stop('start-failed').catch(() => undefined);
    process.exitCode = 1;
    throw error;
  }
  // Advertise the session only after the service actually reached running/degraded.
  // Advertise only capabilities this entry implements. `observe` is not a service command
  // (the observer is passive and `observe` is rejected as unsupported), and `observer` is only
  // advertised when an observer monitor is actually configured.
  ipc.send({
    type: 'hello', protocolVersion: 1, process: 'runtime', sessionEpoch, bootEpoch,
    capabilities: ['control', 'relay', ...(observer === undefined ? [] : ['observer'])],
  });

  return { sessionEpoch, service, stop };
}

function errorText(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)) as string;
}

if (process.send && process.env.FUREVERCRAFT_SERVICE_CONFIG) {
  const config = JSON.parse(process.env.FUREVERCRAFT_SERVICE_CONFIG) as BridgeServiceEntryConfig;
  void runBridgeServiceEntry(config, {
    send: message => process.send!(message),
    on: (event, listener) => process.on(event, listener),
    off: (event, listener) => process.off(event, listener),
  }).then(handle => {
    const shutdown = (signal: string) => {
      void handle.stop(signal).then(result => process.exit(result.stopped ? (process.exitCode ?? 0) : 1));
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }, () => { process.exit(1); });
}
