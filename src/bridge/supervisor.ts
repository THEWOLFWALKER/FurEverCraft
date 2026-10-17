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
};

export type OwnerLossResult = { ownerLost: boolean; revoked: boolean; reason?: string };

export class ProcessSupervisor {
  readonly ownerEpoch = `owner_${randomUUID()}`;
  private child?: ChildProcessLike;
  private childEpoch?: string;
  private stateValue: SupervisorState = 'idle';
  private restarts: number[] = [];
  private lastHeartbeat: number;
  private readonly now: () => number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly ownerLossMs: number;
  private readonly heartbeatMs: number;

  constructor(private readonly options: SupervisorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.maxRestarts = options.maxRestarts ?? 3;
    this.restartWindowMs = options.restartWindowMs ?? 60_000;
    this.ownerLossMs = options.ownerLossMs ?? 1_000;
    this.heartbeatMs = options.heartbeatMs ?? 250;
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
    const child = this.options.spawn();
    this.child = child;
    child.on('message', message => {
      if (isHello(message)) {
        // Adopt the first hello as the child's session identity; an in-flight identity
        // change means ownership was taken over and must not be adopted silently.
        if (!this.childEpoch) this.childEpoch = message.sessionEpoch;
        else if (message.sessionEpoch !== this.childEpoch) { this.stateValue = 'failed'; child.kill(); return; }
      }
      this.lastHeartbeat = this.now();
    });
    child.on('exit', () => { this.child = undefined; if (this.stateValue !== 'stopping' && this.stateValue !== 'stopped') this.stateValue = 'failed'; });
    child.on('error', () => { if (this.stateValue !== 'stopping' && this.stateValue !== 'stopped') this.stateValue = 'failed'; });
    const hello: IpcMessage = { type: 'hello', protocolVersion: 1, process: 'runtime', sessionEpoch: this.ownerEpoch, bootEpoch: randomUUID(), capabilities: ['control', 'observe'] };
    if (!child.send(hello)) { this.stateValue = 'failed'; throw new Error('supervisor-hello-backpressure'); }
    this.stateValue = 'running';
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
    this.child = undefined;
    this.childEpoch = undefined;
    if (!child) return;
    try { child.send({ type: 'request', protocolVersion: 1, requestId: `stop-${reason}`, sessionEpoch: this.ownerEpoch, command: 'shutdown', payload: {}, timeoutMs: 1_000 } satisfies IpcMessage); } catch { /* best effort */ }
    try { child.kill(); } catch { /* best effort */ }
  }
}

function isHello(value: unknown): value is { type: 'hello'; sessionEpoch: string } {
  return Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === 'hello' && typeof (value as { sessionEpoch?: unknown }).sessionEpoch === 'string';
}
