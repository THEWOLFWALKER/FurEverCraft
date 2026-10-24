import { redact } from '../../diagnostics/redaction.js';
import { BoundedIpcOutbox, type IpcMessageLike } from './ipc-outbox.js';

/**
 * Process orchestrator for the body bridge. It owns local service lifecycle only:
 * relay supervisor, observer worker and (optionally) the Windows helper. Child exit
 * revokes control immediately, then a bounded exponential backoff may restart the
 * relay. Restarting never re-arms held input or replays unconfirmed actions.
 */
export type BridgeServiceState = 'idle' | 'starting' | 'running' | 'degraded' | 'restarting' | 'stopping' | 'stopped' | 'failed';

export type RelayMonitor = {
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  /** Escalation after the graceful deadline; must be synchronous or bounded. */
  forceStop?(): void | Promise<void>;
  readonly state: string;
  readonly pid?: number;
  onExit(listener: (reason: string) => void): () => void;
  waitForHello?(timeoutMs?: number): Promise<string>;
};

export type ObserverMonitor = {
  start(): void;
  stop(): Promise<void>;
  forceStop?(): void | Promise<void>;
  state(): unknown;
  onFailure?(listener: (reason: string) => void): () => void;
};

export type HelperMonitor = {
  shutdown(): Promise<void>;
  forceStop?(): void | Promise<void>;
  releaseOwnedInputs?(): Promise<unknown>;
  /** Reports helper death/crash. Control is revoked before any restart and never re-armed here. */
  onExit?(listener: (reason: string) => void): () => void;
  state?(): unknown;
};

export type BridgeServiceEvent = IpcMessageLike & (
  | { type: 'state'; state: BridgeServiceState }
  | { type: 'relay-exit'; reason: string; unexpected: boolean }
  | { type: 'relay-restart'; attempt: number; delayMs: number }
  | { type: 'observer-failure'; reason: string }
  | { type: 'observer-event'; event: unknown }
  | { type: 'helper-exit'; reason: string }
  | { type: 'control-revoked'; reason: string }
  | { type: 'ipc-overflow'; dropped: number; controlLost: boolean; globalUnknown: boolean }
  | { type: 'fatal'; reason: string }
);

export type BridgeServiceOptions = {
  relay?: RelayMonitor;
  observer?: ObserverMonitor;
  helper?: HelperMonitor;
  ipc?: { send(message: unknown): boolean };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>) => void;
  onFatal?: (reason: string) => void;
  onEvent?: (event: BridgeServiceEvent) => void;
  maxRestarts?: number;
  restartWindowMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  shutdownGraceMs?: number;
  maxIpcMessages?: number;
  maxIpcBytes?: number;
  helloTimeoutMs?: number;
};

export type BridgeServiceStatus = {
  state: BridgeServiceState;
  relay: { state: string; pid?: number };
  observer: unknown;
  helper: unknown;
  admissionOpen: boolean;
  controlRevoked: boolean;
  restarts: { attempts: number; max: number; lastDelayMs?: number };
  ipc: { messages: number; bytes: number; dropped: number; controlLost: boolean; globalUnknown: boolean; backpressured: boolean };
  shutdown: { forced: boolean; graceMs: number };
};

/** Outcome of a shutdown attempt. `stopped` is true only for a clean graceful stop. */
export type BridgeShutdownResult = { stopped: boolean; forced: boolean; error?: string };

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class BridgeService {
  private stateValue: BridgeServiceState = 'idle';
  private admissionOpenValue = false;
  private controlRevokedValue = true;
  private readonly restarts: number[] = [];
  private lastDelayMs?: number;
  private restarting?: Promise<boolean>;
  private forcedShutdown = false;
  private globalUnknown = false;
  /** True while the IPC channel has rejected a hand-off (a throw, not a false/queued send). */
  private transportUnavailable = false;
  /** True once the current observation-overflow episode has notified its listeners. */
  private overflowEpisodeNotified = false;
  /** Precise reason for the most recent refused arm request (for truthful IPC/CLI reporting). */
  private armRefusalReasonValue?: string;
  /** Single in-flight shutdown, so callers awaiting the same stop observe the same completion. */
  private shutdownPromise?: Promise<BridgeShutdownResult>;
  private shutdownResultValue?: BridgeShutdownResult;
  private readonly outbox: BoundedIpcOutbox;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly unsubscribeRelay: (() => void) | undefined;
  private readonly unsubscribeObserver: (() => void) | undefined;
  private readonly unsubscribeHelper: (() => void) | undefined;
  /** Runtime-side listeners for control/lifecycle integration (separate from options.onEvent). */
  private readonly eventListeners = new Set<(event: BridgeServiceEvent) => void>();

  constructor(private readonly options: BridgeServiceOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.outbox = new BoundedIpcOutbox({ maxMessages: options.maxIpcMessages, maxBytes: options.maxIpcBytes });
    this.unsubscribeRelay = options.relay?.onExit(reason => { void this.onRelayExit(reason); });
    this.unsubscribeObserver = options.observer?.onFailure?.(reason => this.onObserverFailure(reason));
    this.unsubscribeHelper = options.helper?.onExit?.(reason => { void this.onHelperExit(reason); });
  }

  get state(): BridgeServiceState { return this.stateValue; }
  get controlRevoked(): boolean { return this.controlRevokedValue; }
  /** Precise reason the last arm attempt was refused, or undefined when it was accepted. */
  get armRefusalReason(): string | undefined { return this.armRefusalReasonValue; }

  /** Subscribe a runtime consumer (admission/lifecycle). Returns an unsubscribe function. */
  on(listener: (event: BridgeServiceEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.stateValue === 'running' || this.stateValue === 'starting') return;
    if (this.stateValue === 'stopped' || this.stateValue === 'stopping') throw new Error('bridge-service-stopped');
    this.stateValue = 'starting';
    this.emitState();
    try {
      this.options.observer?.start();
      if (this.options.relay) {
        await this.options.relay.start();
        if (this.options.relay.waitForHello) await this.options.relay.waitForHello(this.options.helloTimeoutMs ?? 5_000);
      }
      this.stateValue = 'running';
      this.log('info', 'service-started', { relay: this.options.relay?.state });
      this.emitState();
    } catch (error) {
      this.stateValue = 'failed';
      this.log('error', 'service-start-failed', { error: errorText(error) });
      this.emitState();
      throw error;
    }
  }

  /**
   * Explicit control re-arm after a new, trusted observation; restart is not enough.
   *
   * Admission may only reopen when the service is actually able to carry control right now:
   * a running/degraded service with a live relay (and a live observer when one is configured).
   * IPC loss/backpressure is still checked, because reopening admission on a channel that
   * cannot carry control would silently drop the next revoke.
   */
  armControl(reason = 'operator-arm'): boolean {
    const queued = this.outbox.queued();
    // An IPC channel with our own messages still queued is backpressured even when the
    // send itself was accepted (false = queued). Arming there would reopen admission on
    // a channel that is not keeping up.
    const backpressured = this.transportUnavailable
      || (this.options.ipc !== undefined && queued.messages > 0);
    const liveness = this.controlLivenessRefusal();
    const refusal = liveness
      ?? (this.globalUnknown ? 'ipc-global-unknown'
        : this.overflowEpisodeNotified ? 'ipc-overflow-episode'
          : backpressured ? (this.transportUnavailable ? 'ipc-transport-unavailable' : 'ipc-backpressured')
            : undefined);
    if (refusal !== undefined) {
      this.armRefusalReasonValue = refusal;
      // A refused arm must leave admission closed, even if it was open before (for example
      // an operator re-arm racing a relay/observer failure).
      this.closeAdmission();
      this.log('warn', 'control-arm-refused', {
        reason,
        refusal,
        service: this.stateValue,
        relay: this.options.relay?.state ?? 'absent',
        ipc: { globalUnknown: this.globalUnknown, backpressured, dropped: queued.dropped },
      });
      return false;
    }
    this.armRefusalReasonValue = undefined;
    this.controlRevokedValue = false;
    this.admissionOpenValue = true;
    this.log('info', 'control-armed', { reason });
    this.emitState();
    return true;
  }

  /**
   * Liveness precondition for arming. Returns undefined only when control can truthfully be
   * opened: running/degraded service, a configured relay whose monitor reports running, and a
   * configured observer that reports a running worker.
   */
  private controlLivenessRefusal(): string | undefined {
    if (this.stateValue !== 'running' && this.stateValue !== 'degraded') return `service-state:${this.stateValue}`;
    if (!this.options.relay) return 'relay-not-configured';
    if (this.options.relay.state !== 'running') return `relay-state:${this.options.relay.state}`;
    if (this.options.observer) {
      let observerState: unknown;
      try { observerState = this.options.observer.state(); } catch { return 'observer-state-unavailable'; }
      if (!observerState || typeof observerState !== 'object') return 'observer-not-live';
      const value = observerState as {
        running?: unknown; enabled?: unknown; paused?: unknown; stopped?: unknown;
        sessions?: unknown; boundSessions?: unknown;
      };
      if (value.running === true) return undefined;
      // A passive observer with no bound TCP session has no worker to report running yet;
      // an enabled, unpaused supervisor is ready for the next session. A bound session that
      // has no installed host (or whose host is not running) is a real liveness failure.
      const enabled = value.enabled === true && value.paused !== true && value.stopped !== true;
      const installed = Array.isArray(value.sessions) ? value.sessions.length : undefined;
      const bound = typeof value.boundSessions === 'number' ? value.boundSessions : undefined;
      if (enabled && installed !== undefined && installed === 0 && (bound === undefined || bound === 0)) return undefined;
      return 'observer-not-live';
    }
    return undefined;
  }

  /** Revoke held input and close admission without stopping forwarding. */
  async revokeControl(reason: string): Promise<void> {
    this.closeAdmission();
    const released = this.releaseInputsBestEffort();
    this.announceRevoked(reason);
    await released;
  }

  onObserverFailure(reason: string): void {
    this.emit({ type: 'observer-failure', reason });
    this.log('warn', 'observer-worker-failure', { reason });
    // Observer loss means the controlling runtime can no longer prove body state. Admission
    // must close synchronously; releasing held input is best-effort and never blocks it.
    this.closeAdmission();
    void this.releaseInputsBestEffort();
    this.announceRevoked(`observer-failure:${reason}`);
    this.degradeIfRunning();
  }

  /**
   * Helper death revokes control before anything else. A later helper restart must be
   * followed by an explicit armControl after fresh observation; held input and unconfirmed
   * actions from the dead helper are never restored here.
   */
  async onHelperExit(reason: string): Promise<void> {
    if (this.stateValue === 'stopping' || this.stateValue === 'stopped') return;
    this.emit({ type: 'helper-exit', reason });
    this.log('error', 'helper-exit', { reason });
    await this.revokeControl(`helper-exit:${reason}`);
    if (this.stateValue === 'running') this.stateValue = 'degraded';
    this.emitState();
  }

  publishObserver(event: unknown): void {
    // Relay forwarding is independent of this consumer; the event is still reported even
    // when it also revokes control.
    this.emit({ type: 'observer-event', event });
    const gapReason = globalObserverGapReason(event);
    if (gapReason === undefined) return;
    // A global observer gap (or an explicit unknown-availability report) invalidates the
    // observation the runtime was admitted on. Close admission synchronously and require
    // an explicit armControl after fresh, trusted observation.
    this.closeAdmission();
    void this.releaseInputsBestEffort();
    this.announceRevoked(`observer-gap:${gapReason}`);
    this.degradeIfRunning();
  }

  /**
   * Stop every owned child and report what actually happened.
   *
   * A child stop failure is not swallowed: it is collected and escalated to that monitor's
   * hard stop. Exceeding the graceful deadline escalates every monitor. The returned result is
   * `stopped:true` only for a clean graceful stop; otherwise `stopped:false` carries the
   * failures and `forced:true` so no caller can report a clean shutdown that did not occur.
   */
  stop(reason = 'quit'): Promise<BridgeShutdownResult> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.stateValue === 'stopped') {
      return Promise.resolve(this.shutdownResultValue ?? { stopped: true, forced: this.forcedShutdown });
    }
    this.shutdownPromise = this.doStop(reason);
    return this.shutdownPromise;
  }

  private async doStop(reason: string): Promise<BridgeShutdownResult> {
    this.stateValue = 'stopping';
    this.emitState();
    await this.revokeControl(`stop:${reason}`);
    const graceMs = this.options.shutdownGraceMs ?? 3_000;
    const failures: string[] = [];
    const tasks: Array<{ name: string; run: () => Promise<void>; force?: () => void | Promise<void> }> = [];
    if (this.options.relay) {
      const relay = this.options.relay;
      tasks.push({
        name: 'relay',
        run: () => relay.stop(reason),
        ...(relay.forceStop ? { force: () => relay.forceStop!() } : {}),
      });
    }
    if (this.options.observer) {
      const observer = this.options.observer;
      tasks.push({
        name: 'observer',
        run: () => observer.stop(),
        ...(observer.forceStop ? { force: () => observer.forceStop!() } : {}),
      });
    }
    if (this.options.helper) {
      const helper = this.options.helper;
      tasks.push({
        name: 'helper',
        run: () => helper.shutdown(),
        ...(helper.forceStop ? { force: () => helper.forceStop!() } : {}),
      });
    }
    // Preserve lifecycle order while recording each failure instead of swallowing it.
    const work = (async () => {
      for (const task of tasks) {
        try {
          await task.run();
        } catch (error) {
          const detail = errorText(error);
          failures.push(`${task.name}-stop-failed:${detail}`);
          this.log('warn', `${task.name}-stop-failed`, { error: detail });
        }
      }
    })();
    const outcome = await withDeadline(work, graceMs);
    const escalate = new Set<(typeof tasks)[number]>();
    let forced = false;
    if (outcome.timedOut) {
      forced = true;
      failures.push(`shutdown-deadline-exceeded:${graceMs}ms`);
      this.log('error', 'shutdown-deadline-exceeded', { reason, graceMs });
      // A deadline must not leave orphaned children: escalate to every monitor's hard stop.
      for (const task of tasks) escalate.add(task);
    } else if (outcome.error !== undefined) {
      forced = true;
      failures.push(`shutdown-failed:${errorText(outcome.error)}`);
      this.log('error', 'shutdown-failed', { reason, error: errorText(outcome.error) });
      for (const task of tasks) escalate.add(task);
    } else {
      // Only the monitors whose graceful stop rejected need escalation.
      for (const task of tasks) if (failures.some(failure => failure.startsWith(`${task.name}-stop-failed:`))) escalate.add(task);
    }
    if (escalate.size > 0) {
      forced = true;
      const targets = [...escalate];
      const forceDeadline = Math.max(50, Math.min(graceMs, 500));
      const forcedOutcome = await withDeadline(Promise.all(targets.map(async task => {
        try {
          if (task.force) await task.force();
          else failures.push(`${task.name}-force-stop-unavailable`);
        } catch (error) {
          failures.push(`${task.name}-force-stop-failed:${errorText(error)}`);
        }
      })), forceDeadline);
      if (forcedOutcome.timedOut) failures.push(`force-stop-deadline-exceeded:${forceDeadline}ms`);
      else if (forcedOutcome.error !== undefined) failures.push(`force-stop-failed:${errorText(forcedOutcome.error)}`);
    }
    this.stateValue = 'stopped';
    this.admissionOpenValue = false;
    if (forced) this.forcedShutdown = true;
    const result: BridgeShutdownResult = failures.length === 0
      ? { stopped: true, forced }
      : { stopped: false, forced, error: failures.join('; ') };
    this.shutdownResultValue = result;
    this.emit({ type: 'state', state: 'stopped' });
    this.flush();
    this.unsubscribeRelay?.();
    this.unsubscribeObserver?.();
    this.unsubscribeHelper?.();
    return result;
  }

  status(): BridgeServiceStatus {
    return {
      state: this.stateValue,
      relay: { state: this.options.relay?.state ?? 'absent', ...(this.options.relay?.pid === undefined ? {} : { pid: this.options.relay.pid }) },
      observer: this.options.observer?.state() ?? null,
      helper: this.options.helper?.state?.() ?? null,
      admissionOpen: this.admissionOpenValue,
      controlRevoked: this.controlRevokedValue,
      restarts: { attempts: this.restarts.length, max: this.options.maxRestarts ?? 3, ...(this.lastDelayMs === undefined ? {} : { lastDelayMs: this.lastDelayMs }) },
      ipc: { ...this.outbox.queued(), globalUnknown: this.globalUnknown, backpressured: this.transportUnavailable },
      shutdown: { forced: this.forcedShutdown, graceMs: this.options.shutdownGraceMs ?? 3_000 },
    };
  }

  /** Queue a message for the parent. Control loss is surfaced as global uncertainty. */
  emit(event: BridgeServiceEvent | IpcMessageLike, control?: boolean): void {
    const before = this.outbox.queued();
    this.outbox.push(event, control);
    const after = this.outbox.queued();
    const droppedNow = after.dropped - before.dropped;
    if (droppedNow > 0) {
      this.globalUnknown = true;
      const controlLostNow = !before.controlLost && after.controlLost;
      this.log('warn', 'ipc-queue-overflow', { dropped: droppedNow, controlLost: after.controlLost });
      if (!this.overflowEpisodeNotified || controlLostNow) {
        this.overflowEpisodeNotified = true;
        // The outbox can no longer be trusted to carry control. Close admission and notify
        // runtime listeners directly: re-enqueueing this notification would recurse into the
        // same full queue, and each overflow episode must notify exactly once.
        this.closeAdmission();
        void this.releaseInputsBestEffort();
        this.dispatch({
          type: 'observer-event',
          event: {
            kind: 'observer_gap', source: 'client', sessionEpoch: 'ipc-outbox',
            gap: { scope: 'global', reason: 'ipc-queue-overflow', dropped: droppedNow },
          },
        } as BridgeServiceEvent);
        this.dispatch({ type: 'ipc-overflow', dropped: droppedNow, controlLost: after.controlLost, globalUnknown: true });
      }
    }
    this.flush(droppedNow === 0);
    this.dispatch(event as BridgeServiceEvent);
  }

  /**
   * Attempt to drain queued IPC without blocking.
   *
   * `endEpisodeOnDrain=false` is used right after a drop so one backed-up publish does not
   * immediately declare the episode recovered. A transport throw (not a false/queued send)
   * marks the channel unavailable; admission cannot be re-armed until a later flush hands
   * off successfully and the queue is empty.
   */
  flush(endEpisodeOnDrain = true): void {
    if (!this.options.ipc) return;
    const result = this.outbox.flush(message => {
      try { return this.options.ipc!.send(message); } catch { throw new Error('ipc-transport-failed'); }
    });
    if (result.transportError) {
      this.transportUnavailable = true;
      return;
    }
    // Every entry in this flush was handed to the channel (true = written, false = queued).
    this.transportUnavailable = false;
    // A fully drained queue ends the overflow episode; a later overflow is a new episode.
    if (result.queued === 0 && endEpisodeOnDrain) {
      this.overflowEpisodeNotified = false;
      this.globalUnknown = false;
    }
  }

  private async onRelayExit(reason: string): Promise<void> {
    if (this.stateValue === 'stopping' || this.stateValue === 'stopped' || this.stateValue === 'failed') return;
    const unexpected = reason === 'unexpected-exit';
    this.emit({ type: 'relay-exit', reason, unexpected });
    this.log(unexpected ? 'error' : 'info', 'relay-exit', { reason });
    await this.revokeControl('relay-exit');
    if (!unexpected) return;
    this.stateValue = 'degraded';
    this.emitState();
    void this.scheduleRestart();
  }

  private scheduleRestart(): Promise<boolean> {
    if (this.restarting) return this.restarting;
    this.restarting = this.doRestart().finally(() => { this.restarting = undefined; });
    return this.restarting;
  }

  private async doRestart(): Promise<boolean> {
    const now = this.now();
    const windowMs = this.options.restartWindowMs ?? 60_000;
    const maxRestarts = this.options.maxRestarts ?? 3;
    this.restarts.splice(0, Math.max(0, this.restarts.length - maxRestarts));
    const recent = this.restarts.filter(at => now - at < windowMs);
    this.restarts.length = 0;
    this.restarts.push(...recent);
    if (this.restarts.length >= maxRestarts) {
      this.stateValue = 'failed';
      this.emit({ type: 'fatal', reason: 'restart-budget-exhausted' });
      this.log('error', 'restart-budget-exhausted', { attempts: this.restarts.length, windowMs });
      this.emitState();
      this.options.onFatal?.('restart-budget-exhausted');
      return false;
    }
    const attempt = this.restarts.length + 1;
    const base = this.options.backoffBaseMs ?? 250;
    const max = this.options.backoffMaxMs ?? 5_000;
    const delayMs = Math.min(max, base * 2 ** (attempt - 1));
    this.restarts.push(this.now());
    this.lastDelayMs = delayMs;
    this.stateValue = 'restarting';
    this.emit({ type: 'relay-restart', attempt, delayMs });
    this.emitState();
    await this.sleep(delayMs);
    if (this.isStopping()) return false;
    try {
      await this.options.relay?.start();
      if (this.options.relay?.waitForHello) await this.options.relay.waitForHello(this.options.helloTimeoutMs ?? 5_000);
      this.stateValue = 'running';
      this.log('info', 'relay-restarted', { attempt, delayMs });
      this.emitState();
      return true;
    } catch (error) {
      this.log('error', 'relay-restart-failed', { attempt, error: errorText(error) });
      // A failed explicit start is itself an unexpected child failure; try again within budget.
      return this.doRestart();
    }
  }

  private isStopping(): boolean { return this.stateValue === 'stopping' || this.stateValue === 'stopped'; }

  private closeAdmission(): void {
    this.controlRevokedValue = true;
    this.admissionOpenValue = false;
  }

  private releaseInputsBestEffort(): Promise<void> {
    try {
      return Promise.resolve(this.options.helper?.releaseOwnedInputs?.()).then(() => undefined, () => undefined);
    } catch {
      return Promise.resolve();
    }
  }

  private announceRevoked(reason: string): void {
    this.emit({ type: 'control-revoked', reason });
    this.log('warn', 'control-revoked', { reason });
  }

  private degradeIfRunning(): void {
    if (this.stateValue !== 'running') return;
    this.stateValue = 'degraded';
    this.emitState();
  }

  private dispatch(event: BridgeServiceEvent | IpcMessageLike): void {
    try { this.options.onEvent?.(event as BridgeServiceEvent); } catch { /* listeners isolated */ }
    for (const listener of this.eventListeners) {
      try { listener(event as BridgeServiceEvent); } catch { /* listeners isolated */ }
    }
  }

  private emitState(): void {
    this.emit({ type: 'state', state: this.stateValue });
  }

  private log(level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>): void {
    if (!this.options.log) return;
    try {
      this.options.log(level, event, fields === undefined ? undefined : redact(fields) as Record<string, unknown>);
    } catch { /* logging must not break control */ }
  }
}

async function withDeadline(work: Promise<unknown>, ms: number): Promise<{ completed: boolean; timedOut: boolean; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ completed: false; timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ completed: false, timedOut: true }), ms); });
  const result = await Promise.race([
    work.then(
      () => ({ completed: true, timedOut: false }) as const,
      // A rejected stop is a failure, never a completed shutdown.
      (error: unknown) => ({ completed: false, timedOut: false, error }) as const,
    ),
    deadline,
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

function errorText(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)) as string;
}

/**
 * Returns the reason when an observer event invalidates control: a global gap, a domain
 * gap that also reports unknown availability, or any observation marked unavailable.
 * A scoped domain gap with known availability does not revoke on its own.
 */
function globalObserverGapReason(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const value = event as { kind?: unknown; availability?: unknown; gap?: { scope?: unknown; reason?: unknown } };
  const reason = typeof value.gap?.reason === 'string' ? value.gap.reason : undefined;
  if (value.availability === 'unknown') return reason ?? 'availability-unknown';
  if (value.kind !== 'observer_gap') return undefined;
  if (value.gap?.scope === 'domain') return undefined;
  return reason ?? 'observer-gap';
}
