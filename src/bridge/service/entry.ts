import { randomUUID } from 'node:crypto';
import { redact } from '../../diagnostics/redaction.js';
import { stoppedObserverState } from '../observer/host.js';
import { IpcRequestSchema, type IpcRequest } from '../ipc/protocol.js';
import { spawnRelayProcess } from '../relay/spawn.js';
import type { RelayEntryConfig } from '../relay/entry.js';
import { ProcessSupervisor } from '../supervisor.js';
import { BridgeService, type ObserverMonitor } from './orchestrator.js';

type ObserverCommand = 'start-observer' | 'stop-observer';
type ObserverCommandResult = { completed?: boolean; status?: string; observer?: unknown };

const AWAITING_RELAY_STATE = { running: false, stopped: true, availability: 'unknown', limitation: 'awaiting-relay-child' };

/**
 * Passive observer monitor over the relay child's IPC stream. The worker lives in the relay
 * process (it needs the raw chunks); this service only tracks its reported state and failures.
 * Explicit start-observer/stop-observer requests are forwarded to the relay child, and only an
 * actual worker transition is reported as completed.
 */
export class RelayObserverMonitor implements ObserverMonitor {
  private stateValue: unknown = AWAITING_RELAY_STATE;
  private readonly failures = new Set<(reason: string) => void>();
  private stopped = true;
  private epoch?: string;
  private generation = 0;
  /**
   * Whether observer events from the current relay generation are dropped. Distinct from the
   * reported worker `stopped` state: a monitor is only constructed when observation is enabled,
   * and the relay child starts that worker at boot from its own config. So events are forwarded
   * as soon as a relay hello has named the generation, until an explicit stop halts them. Gating
   * forwarding on `startLive()` having run would silently drop every boot-enabled observation.
   */
  private eventsHalted = false;

  constructor(
    private readonly onEvent: (event: unknown) => void,
    private readonly request?: (command: ObserverCommand, payload?: unknown) => Promise<unknown>,
    private readonly relayRunning?: () => boolean,
  ) {}

  async start(): Promise<void> {
    // Boot-time observer enablement is driven by the relay child config. When the relay is
    // already live (an explicit restart), drive the real worker through IPC.
    if (this.relayRunning?.() !== true) return;
    await this.startLive();
  }

  /** Explicit control-plane start; failures are surfaced instead of returning a false ack. */
  async startLive(): Promise<void> {
    const generation = ++this.generation;
    if (this.relayRunning && !this.relayRunning()) throw new Error('relay-not-running');
    if (!this.request) throw new Error('observer-control-unavailable');
    const result = await this.send('start-observer') as ObserverCommandResult | undefined;
    if (generation !== this.generation) throw new Error('observer-control-superseded');
    if (result?.completed !== true) {
      this.stopped = true;
      this.stateValue = stoppedObserverState();
      throw new Error('observer-start-not-completed');
    }
    this.stopped = false;
    // An explicit start also resumes forwarding for the current generation.
    this.eventsHalted = false;
    if (result.observer !== undefined) this.stateValue = result.observer;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.eventsHalted = true;
    this.generation += 1;
    this.stateValue = stoppedObserverState();
    if (this.relayRunning?.() !== true) return;
    try { await this.send('stop-observer'); } catch { /* relay teardown owns the worker */ }
  }

  /** Explicit control-plane stop; reports failure rather than claiming a worker stopped. */
  async stopLive(): Promise<void> {
    const generation = ++this.generation;
    if (this.relayRunning && !this.relayRunning()) {
      this.stopped = true;
      this.eventsHalted = true;
      this.stateValue = stoppedObserverState();
      return;
    }
    if (!this.request) throw new Error('observer-control-unavailable');
    const result = await this.send('stop-observer') as ObserverCommandResult | undefined;
    if (generation !== this.generation) throw new Error('observer-control-superseded');
    if (result?.completed !== true) throw new Error('observer-stop-not-completed');
    this.stopped = true;
    this.eventsHalted = true;
    this.stateValue = result.observer !== undefined ? result.observer : stoppedObserverState();
  }

  state(): unknown { return this.stateValue; }
  onFailure(listener: (reason: string) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }
  forceStop(): void { this.stopped = true; this.eventsHalted = true; this.stateValue = stoppedObserverState(); }

  handle(message: unknown): void {
    const value = message as {
      type?: string;
      process?: string;
      event?: string;
      sessionEpoch?: string;
      payload?: unknown;
      reason?: string;
    } | undefined;
    if (!value) return;
    if (value.type === 'hello' && value.process === 'relay' && typeof value.sessionEpoch === 'string') {
      if (this.epoch !== undefined && this.epoch !== value.sessionEpoch) {
        // A new relay generation cannot inherit the old worker's state. A restart re-arms the
        // worker from the relay config, so forwarding resumes for the new generation.
        this.epoch = value.sessionEpoch;
        this.generation += 1;
        this.eventsHalted = false;
        if (!this.stopped) this.stateValue = AWAITING_RELAY_STATE;
      } else if (this.epoch === undefined) {
        this.epoch = value.sessionEpoch;
      }
      return;
    }
    if (value.type !== 'event') return;
    // Events are forwarded for the live relay generation (named by a hello) until an explicit
    // stop halts them. Boot-enabled observation never calls startLive, so this must not depend
    // on it. Events from an older relay generation are still dropped by the epoch check below.
    if (this.eventsHalted || this.epoch === undefined) return;
    if (typeof value.sessionEpoch === 'string' && value.sessionEpoch !== this.epoch) return;
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

  private async send(command: ObserverCommand): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { return await this.request!(command, {}); }
      catch (error) {
        lastError = error;
        // The supervisor may still be promoting its just-spawned child; retry briefly.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('supervisor-not-running:starting')) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
  stop(reason?: string): Promise<{ stopped: boolean; forced: boolean; error?: string }>;
};

export type ServiceCommandReply =
  | { kind: 'reply'; ok: boolean; result?: unknown; error?: { code: string; message: string } }
  | { kind: 'shutdown' }
  | { kind: 'start-observer' }
  | { kind: 'stop-observer' }
  | { kind: 'observe' }
  | { kind: 'arm' };

/**
 * Real capability report for the configured service. Target/network come from the relay
 * configuration actually handed to this child; profile is reported only when the caller
 * supplied it (`unspecified` otherwise, never a guessed profile). A hardcoded
 * `client-offline`/`disabled` reply would misreport an explicitly upstream-gated service.
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
      const decision = context.service.armControl('operator-ipc-arm');
      const refusal = decision.reasons.length > 0 ? decision.reasons.join(',') : undefined;
      const status = context.service.status();
      return decision.allowed
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
  let stopPromise: Promise<{ stopped: boolean; forced: boolean; error?: string }> | undefined;
  let service!: BridgeService;
  const observerEnabled = config.observer?.enabled !== false;
  const relay = new ProcessSupervisor({
    spawn: () => spawnRelayProcess({ ...config.relay, observer: config.relay.observer ?? { enabled: observerEnabled } }),
    maxRestarts: 0,
    ipcTimeoutMs: config.helloTimeoutMs ?? 5_000,
  });
  // The monitor drives the worker through the same supervised child, so a start/stop ack
  // reflects the relay's real worker state rather than a local flag.
  const observer = observerEnabled
    ? new RelayObserverMonitor(
        event => service?.publishObserver(event),
        (command, payload) => relay.request(command, payload),
        () => relay.state === 'running',
      )
    : undefined;
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

  const stop = async (reason = 'shutdown'): Promise<{ stopped: boolean; forced: boolean; error?: string }> => {
    if (stopPromise) return stopPromise;
    // Stop accepting commands while shutdown is in flight; the shutdown reply itself is sent
    // only after the service reports its real stop outcome.
    stopped = true;
    stopPromise = (async () => {
      await service.stop(reason);
      service.flush();
      try { ipc.off?.('message', onMessage); ipc.off?.('disconnect', onDisconnect); } catch { /* best effort */ }
      // The service never reports a clean stop it did not achieve: any per-child failure or
      // forced escalation is surfaced as `stopped:false` with the exact reason.
      const shutdown = service.status().shutdown;
      const error = shutdown.errors.at(-1);
      return { stopped: !shutdown.forced && error === undefined, forced: shutdown.forced, ...(error === undefined ? {} : { error }) };
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
    if (reply.kind === 'reply') {
      respond(request, reply.ok, reply.result, reply.error);
      return;
    }
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
      void observer!.startLive().then(
        () => respond(request, true, { accepted: true, completed: true, observer: observer!.state() }),
        error => respond(request, false, undefined, { code: 'observer-recovery-failed', message: errorText(error) }),
      );
      return;
    }
    if (reply.kind === 'stop-observer') {
      void observer!.stopLive().then(
        () => respond(request, true, { accepted: true, completed: true, observer: observer!.state() }),
        error => respond(request, false, undefined, { code: 'observer-stop-failed', message: errorText(error) }),
      );
      return;
    }
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
  }
  // Advertise the session only after the service actually reached running/degraded.
  // Advertise only capabilities this entry implements. `observe` is not a service command
  // (the observer is passive and `observe` is rejected as unsupported), and `observer` is only
  // advertised when an observer monitor is actually configured.
  if (process.exitCode !== 1) {
    ipc.send({
      type: 'hello', protocolVersion: 1, process: 'runtime', sessionEpoch, bootEpoch,
      capabilities: ['control', 'relay', ...(observer === undefined ? [] : ['observer'])],
    });
  }

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
