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
  readonly state: string;
  readonly pid?: number;
  onExit(listener: (reason: string) => void): () => void;
  waitForHello?(timeoutMs?: number): Promise<string>;
};

export type ObserverMonitor = {
  start(): void;
  stop(): Promise<void>;
  state(): unknown;
  onFailure?(listener: (reason: string) => void): () => void;
};

export type HelperMonitor = {
  shutdown(): Promise<void>;
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
  ipc: { messages: number; bytes: number; dropped: number; controlLost: boolean; globalUnknown: boolean };
  shutdown: { forced: boolean; graceMs: number };
};

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
  private readonly outbox: BoundedIpcOutbox;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly unsubscribeRelay: (() => void) | undefined;
  private readonly unsubscribeObserver: (() => void) | undefined;
  private readonly unsubscribeHelper: (() => void) | undefined;

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

  /** Explicit control re-arm after a new, trusted observation; restart is not enough. */
  armControl(reason = 'operator-arm'): void {
    this.controlRevokedValue = false;
    this.admissionOpenValue = true;
    this.log('info', 'control-armed', { reason });
    this.emitState();
  }

  /** Revoke held input and close admission without stopping forwarding. */
  async revokeControl(reason: string): Promise<void> {
    this.controlRevokedValue = true;
    this.admissionOpenValue = false;
    try { await this.options.helper?.releaseOwnedInputs?.(); } catch { /* best effort */ }
    this.emit({ type: 'control-revoked', reason });
    this.log('warn', 'control-revoked', { reason });
  }

  onObserverFailure(reason: string): void {
    this.emit({ type: 'observer-failure', reason });
    this.log('warn', 'observer-worker-failure', { reason });
    if (this.stateValue === 'running') this.stateValue = 'degraded';
    this.emitState();
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
    this.emit({ type: 'observer-event', event });
  }

  async stop(reason = 'quit'): Promise<void> {
    if (this.stateValue === 'stopped' || this.stateValue === 'stopping') return;
    this.stateValue = 'stopping';
    this.emitState();
    await this.revokeControl(`stop:${reason}`);
    const graceMs = this.options.shutdownGraceMs ?? 3_000;
    const work = (async () => {
      if (this.options.relay) await this.options.relay.stop(reason).catch(error => this.log('warn', 'relay-stop-failed', { error: errorText(error) }));
      if (this.options.observer) await this.options.observer.stop().catch(error => this.log('warn', 'observer-stop-failed', { error: errorText(error) }));
      if (this.options.helper) await this.options.helper.shutdown().catch(error => this.log('warn', 'helper-stop-failed', { error: errorText(error) }));
    })();
    const completed = await withDeadline(work, graceMs);
    if (!completed) {
      this.forcedShutdown = true;
      this.log('error', 'shutdown-deadline-exceeded', { reason, graceMs });
    }
    this.stateValue = 'stopped';
    this.admissionOpenValue = false;
    this.emit({ type: 'state', state: 'stopped' });
    this.flush();
    this.unsubscribeRelay?.();
    this.unsubscribeObserver?.();
    this.unsubscribeHelper?.();
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
      ipc: { ...this.outbox.queued(), globalUnknown: this.globalUnknown },
      shutdown: { forced: this.forcedShutdown, graceMs: this.options.shutdownGraceMs ?? 3_000 },
    };
  }

  /** Queue a message for the parent. Control loss is surfaced as global uncertainty. */
  emit(event: BridgeServiceEvent | IpcMessageLike, control?: boolean): void {
    const before = this.outbox.queued().dropped;
    this.outbox.push(event, control);
    const after = this.outbox.queued();
    if (after.dropped > before) {
      this.globalUnknown = this.globalUnknown || after.controlLost;
      this.log('warn', 'ipc-queue-overflow', { dropped: after.dropped - before, controlLost: after.controlLost });
    }
    this.flush();
    try { this.options.onEvent?.(event as BridgeServiceEvent); } catch { /* listeners isolated */ }
  }

  /** Attempt to drain queued IPC without blocking. */
  flush(): void {
    if (!this.options.ipc) return;
    this.outbox.flush(message => {
      try { return this.options.ipc!.send(message); } catch { return false; }
    });
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

async function withDeadline(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  const result = await Promise.race([work.then(() => true).catch(() => true), deadline]);
  if (timer) clearTimeout(timer);
  return result;
}

function errorText(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)) as string;
}
