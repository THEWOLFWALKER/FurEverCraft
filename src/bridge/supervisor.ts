import { randomUUID } from 'node:crypto';
import type { IpcMessage } from './ipc/protocol.js';

/**
 * Local process supervisor. It owns child process lifecycle separately from the Runtime so a
 * Runtime crash cannot hand relay ownership to a new controller. All spawning is injected so
 * offline tests never launch a real child process.
 */
export type ChildProcessLike = {
  send(message: unknown): boolean;
  on(event: 'message' | 'exit' | 'error', listener: (value?: unknown) => void): unknown;
  kill(signal?: string): boolean;
  readonly pid?: number;
};

export type SupervisorState = 'idle' | 'starting' | 'running' | 'paused' | 'stopping' | 'stopped' | 'failed';
export type SupervisorOptions = {
  spawn: () => ChildProcessLike;
  now?: () => number;
  maxRestarts?: number;
  restartWindowMs?: number;
  heartbeatMs?: number;
  ownerLossMs?: number;
  ipcTimeoutMs?: number;
};

export type OwnerLossResult = { ownerLost: boolean; revoked: boolean; reason?: string };
type PendingRequest = { timer: ReturnType<typeof setTimeout>; resolve: (value: unknown) => void; reject: (error: Error) => void; epoch?: string };

export class ProcessSupervisor {
  readonly ownerEpoch = `owner_${randomUUID()}`;
  private child?: ChildProcessLike;
  private childEpoch?: string;
  private childBootEpoch?: string;
  private stateValue: SupervisorState = 'idle';
  private restarts: number[] = [];
  private lastHeartbeat: number;
  private readonly now: () => number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly ownerLossMs: number;
  private readonly heartbeatMs: number;
  private readonly ipcTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly helloWaiters = new Set<(epoch: string) => void>();

  constructor(private readonly options: SupervisorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxRestarts = options.maxRestarts ?? 3;
    this.restartWindowMs = options.restartWindowMs ?? 60_000;
    this.ownerLossMs = options.ownerLossMs ?? 1_000;
    this.heartbeatMs = options.heartbeatMs ?? 250;
    this.ipcTimeoutMs = options.ipcTimeoutMs ?? 5_000;
    this.lastHeartbeat = this.now();
  }

  get state(): SupervisorState { return this.stateValue; }
  get pid(): number | undefined { return this.child?.pid; }
  get heartbeatIntervalMs(): number { return this.heartbeatMs; }

  async start(): Promise<void> {
    if (this.stateValue === 'running' || this.stateValue === 'starting') return;
    if (this.stateValue === 'stopped' || this.stateValue === 'stopping') throw new Error('supervisor-stopped');
    this.stateValue = 'starting';
    this.childEpoch = undefined;
    this.childBootEpoch = undefined;
    const child = this.options.spawn();
    this.child = child;
    child.on('message', message => {
      if (this.child !== child) return;
      if (isHello(message)) {
        // Adopt the first hello as the child's session identity; an in-flight identity
        // change means ownership was taken over and must not be adopted silently.
        if (!this.childEpoch) { this.childEpoch = message.sessionEpoch; this.childBootEpoch = message.bootEpoch; }
        else if (message.sessionEpoch !== this.childEpoch || (message.bootEpoch && this.childBootEpoch && message.bootEpoch !== this.childBootEpoch)) { this.stateValue = 'failed'; child.kill(); return; }
        else if (message.bootEpoch && this.childBootEpoch === undefined) this.childBootEpoch = message.bootEpoch;
        for (const waiter of this.helloWaiters) waiter(this.childEpoch!);
        this.helloWaiters.clear();
      }
      if (isResponse(message)) {
        const waiter = this.pending.get(message.requestId);
        // A response without an epoch, or for another session/boot, must not settle a request.
        if (waiter && message.sessionEpoch && message.sessionEpoch === this.childEpoch) {
          this.pending.delete(message.requestId); clearTimeout(waiter.timer);
          message.ok ? waiter.resolve(message.result) : waiter.reject(new Error(message.error?.code ?? 'ipc-request-failed'));
        }
      }
      this.lastHeartbeat = this.now();
    });
    child.on('exit', () => { if (this.child === child) { this.child = undefined; if (this.stateValue !== 'stopping' && this.stateValue !== 'stopped') this.stateValue = 'failed'; } });
    child.on('error', () => { if (this.child === child && this.stateValue !== 'stopping' && this.stateValue !== 'stopped') this.stateValue = 'failed'; });
    const hello: IpcMessage = { type: 'hello', protocolVersion: 1, process: 'runtime', sessionEpoch: this.ownerEpoch, bootEpoch: randomUUID(), capabilities: ['control', 'observe'] };
    if (!child.send(hello)) { this.stateValue = 'failed'; throw new Error('supervisor-hello-backpressure'); }
    this.stateValue = 'running';
  }

  /** Wait for the child's hello so a request is not sent before the session epoch is known. */
  waitForHello(timeoutMs = this.ipcTimeoutMs): Promise<string> {
    if (this.childEpoch) return Promise.resolve(this.childEpoch);
    if (!this.child) return Promise.reject(new Error('supervisor-no-child'));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.helloWaiters.delete(waiter); reject(new Error('ipc-hello-timeout')); }, timeoutMs);
      const waiter = (epoch: string) => { clearTimeout(timer); resolve(epoch); };
      this.helloWaiters.add(waiter);
    });
  }

  /** Send a control request to the child and await its correlated response. */
  async request<T = unknown>(command: 'status' | 'shutdown' | 'capabilities' | 'observe' | 'start-observer' | 'stop-observer', payload: unknown = {}): Promise<T> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('supervisor-no-child'));
    // Owner loss revokes control: a paused/failed supervisor must not keep driving the child.
    if (this.stateValue !== 'running') return Promise.reject(new Error(`supervisor-not-running:${this.stateValue}`));
    // A request before the child hello would carry the owner epoch and be rejected as stale.
    const epoch = await this.waitForHello().catch(() => { throw new Error('supervisor-hello-unavailable'); });
    if (this.child !== child) return Promise.reject(new Error('supervisor-child-replaced'));
    const requestId = `sup_${randomUUID()}`;
    const message = { type: 'request', protocolVersion: 1, requestId, sessionEpoch: epoch, command, payload, timeoutMs: this.ipcTimeoutMs } satisfies IpcMessage;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('ipc-timeout')); }, this.ipcTimeoutMs);
      this.pending.set(requestId, { timer, resolve: value => resolve(value as T), reject });
      if (!child.send(message)) { clearTimeout(timer); this.pending.delete(requestId); reject(new Error('ipc-backpressure')); }
    });
  }

  /** Called on each heartbeat. Returns whether the owner link is still alive. */
  heartbeat(): boolean {
    if (this.stateValue !== 'running') return false;
    this.lastHeartbeat = this.now();
    return true;
  }

  /** Explicit owner-loss check driven by the caller's clock. */
  checkOwner(now = this.now()): OwnerLossResult {
    if (this.stateValue !== 'running') return { ownerLost: false, revoked: false };
    if (now - this.lastHeartbeat <= this.ownerLossMs) return { ownerLost: false, revoked: false };
    this.stateValue = 'paused';
    void this.stopChild('owner-loss');
    return { ownerLost: true, revoked: true, reason: 'owner-heartbeat-expired' };
  }

  /** Restart with a 3-per-60s budget; exceeding it pauses instead of looping. */
  async restart(): Promise<boolean> {
    if (this.stateValue === 'stopped' || this.stateValue === 'stopping') return false;
    const now = this.now();
    this.restarts = this.restarts.filter(at => now - at < this.restartWindowMs);
    if (this.restarts.length >= this.maxRestarts) { this.stateValue = 'paused'; return false; }
    this.restarts.push(now);
    await this.stopChild('restart');
    this.stateValue = 'idle';
    await this.start();
    return true;
  }

  async stop(reason = 'quit'): Promise<void> {
    if (this.stateValue === 'stopped') return;
    this.stateValue = 'stopping';
    await this.stopChild(reason);
    this.stateValue = 'stopped';
  }

  private async stopChild(reason: string): Promise<void> {
    const child = this.child;
    const epoch = this.childEpoch;
    this.child = undefined;
    this.childEpoch = undefined;
    this.childBootEpoch = undefined;
    for (const [id, waiter] of this.pending) { clearTimeout(waiter.timer); waiter.reject(new Error('ipc-disconnected')); this.pending.delete(id); }
    if (!child) return;
    // The relay only accepts its own session epoch; fall back to kill when no hello was seen.
    if (epoch) { try { child.send({ type: 'request', protocolVersion: 1, requestId: `stop-${reason}`, sessionEpoch: epoch, command: 'shutdown', payload: {}, timeoutMs: 1_000 } satisfies IpcMessage); } catch { /* best effort */ } }
    try { child.kill(); } catch { /* best effort */ }
  }
}

function isHello(value: unknown): value is { type: 'hello'; sessionEpoch: string; bootEpoch?: string } {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'hello' && typeof (value as { sessionEpoch?: unknown }).sessionEpoch === 'string';
}

function isResponse(value: unknown): value is { type: 'response'; requestId: string; sessionEpoch?: string; ok: boolean; result?: unknown; error?: { code?: string } } {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'response' && typeof (value as { requestId?: unknown }).requestId === 'string' && typeof (value as { ok?: unknown }).ok === 'boolean';
}
