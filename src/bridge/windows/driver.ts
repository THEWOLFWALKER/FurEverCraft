import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * Windows helper transport/driver.
 *
 * Safety rules encoded here:
 *  - every request has a bounded response deadline (default 500ms) and fails with the
 *    typed `helper-response-timeout` code instead of hanging forever;
 *  - mouse moves, clicks and text are never retried automatically;
 *  - release and shutdown use their own shorter deadlines (a slow helper cannot block
 *    shutdown indefinitely);
 *  - stdout is capped per JSONL line, stderr is drained into a bounded buffer;
 *  - dedup is bounded by capacity/TTL and scoped to the helper epoch, with a monotonic
 *    commandSequence high-water mark; a new epoch/bind clears both;
 *  - `setHeldInputs` is sent as a *full replacement* with generation/epoch/pulse TTL.
 */

export type HelperCommand =
  | 'probe'
  | 'bindWindow'
  | 'getWindowState'
  | 'getState'
  | 'configure'
  | 'setHeldInputs'
  | 'moveRelative'
  | 'click'
  | 'typeText'
  | 'captureWindow'
  | 'releaseOwnedInputs'
  | 'heartbeat'
  | 'shutdown'
  | 'setFocus';

export type HelperRequest = { requestId: string; command: HelperCommand; [key: string]: unknown };
export type HelperResponse = {
  requestId: string | null;
  ok: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
};

export class HelperError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'HelperError';
  }
}

export function isHelperError(error: unknown): error is HelperError {
  return error instanceof HelperError;
}

export interface HelperTransport {
  send(request: HelperRequest, signal?: AbortSignal): Promise<HelperResponse>;
  close(): Promise<void>;
  /** Reports transport/process death so orchestration can revoke control before restart. */
  onExit?(listener: (reason: string) => void): () => void;
  /** Escalation path for bounded shutdown. */
  forceStop?(): void;
  /** Sanitized, bounded diagnostics captured from stderr. */
  drainStderr?(): string;
  state?(): unknown;
}

export type JsonlHelperTransportOptions = {
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  maxInFlight?: number;
  stderrLimitBytes?: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 500;
const MAX_JSONL_LINE_BYTES = 64 * 1024;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HelperError(code)), timeoutMs);
    timer.unref?.();
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function sanitizeDiagnostic(value: string): string {
  // Keep diagnostics one-line and free of control characters before they are stored.
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 4096);
}

export class FakeHelperTransport implements HelperTransport {
  readonly requests: HelperRequest[] = [];
  private readonly seen = new Set<string>();
  private readonly exitListeners = new Set<(reason: string) => void>();
  constructor(private readonly responder: (request: HelperRequest) => HelperResponse | Promise<HelperResponse> = request => ({ requestId: request.requestId, ok: true, result: { command: request.command, dryRun: true } })) {}
  onExit(listener: (reason: string) => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  emitExit(reason = 'fake-helper-exit'): void { for (const listener of this.exitListeners) listener(reason); }
  async send(request: HelperRequest): Promise<HelperResponse> {
    this.requests.push(request);
    if (this.seen.has(request.requestId) && ['moveRelative', 'click', 'typeText'].includes(request.command)) return { requestId: request.requestId, ok: true, result: { duplicate: true } };
    this.seen.add(request.requestId);
    return this.responder(request);
  }
  async close() {}
}

export class JsonlHelperTransport implements HelperTransport {
  private readonly pending = new Map<string, {
    resolve: (response: HelperResponse) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  private readonly exitListeners = new Set<(reason: string) => void>();
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private readonly maxInFlight: number;
  private readonly stderrLimitBytes: number;
  private stdoutBuffer = '';
  private discardingLongLine = false;
  private overflowLines = 0;
  private stderr = '';
  private stderrDropped = 0;
  private closed = false;
  private exitNotified = false;

  constructor(private readonly process: ChildProcessWithoutNullStreams, options: JsonlHelperTransportOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxLineBytes = options.maxLineBytes ?? MAX_JSONL_LINE_BYTES;
    this.maxInFlight = options.maxInFlight ?? 32;
    this.stderrLimitBytes = options.stderrLimitBytes ?? 8 * 1024;
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (chunk: string) => this.onStderr(chunk));
    const fail = (reason: string) => {
      for (const waiter of this.pending.values()) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new HelperError('helper-exited', reason));
      }
      this.pending.clear();
      if (this.exitNotified) return;
      this.exitNotified = true;
      for (const listener of this.exitListeners) { try { listener(reason); } catch { /* listeners are isolated */ } }
    };
    process.once('exit', () => fail('helper-process-exit'));
    process.once('error', () => fail('helper-process-error'));
  }

  onExit(listener: (reason: string) => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }

  static start(scriptPath: string, dryRun = false, options: JsonlHelperTransportOptions = {}): JsonlHelperTransport {
    if (process.platform !== 'win32') throw new Error('windows-helper-requires-windows');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
    if (dryRun) args.push('-DryRun');
    return new JsonlHelperTransport(spawn('powershell.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }), options);
  }

  private onStdout(chunk: string): void {
    let text = this.stdoutBuffer + chunk;
    while (text.length > 0) {
      if (this.discardingLongLine) {
        const newline = text.indexOf('\n');
        if (newline === -1) { this.stdoutBuffer = ''; return; }
        text = text.slice(newline + 1);
        this.discardingLongLine = false;
      }
      const newline = text.indexOf('\n');
      if (newline === -1) {
        if (text.length > this.maxLineBytes) {
          this.overflowLines += 1;
          this.discardingLongLine = true;
          this.stdoutBuffer = '';
          text = '';
        }
        break;
      }
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      if (line.length > this.maxLineBytes) { this.overflowLines += 1; continue; }
      this.handleLine(line.replace(/\r$/, ''));
    }
    if (!this.discardingLongLine) this.stdoutBuffer = text;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let response: HelperResponse;
    try { response = JSON.parse(line) as HelperResponse; }
    catch { return; /* malformed helper output is ignored; request timeout handles it */ }
    if (!response || typeof response.requestId !== 'string') return;
    const waiter = this.pending.get(response.requestId);
    if (!waiter) return;
    this.pending.delete(response.requestId);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(response);
  }

  private onStderr(chunk: string): void {
    const sanitized = sanitizeDiagnostic(chunk);
    const combined = this.stderr + sanitized;
    if (combined.length > this.stderrLimitBytes) {
      this.stderrDropped += combined.length - this.stderrLimitBytes;
      this.stderr = combined.slice(combined.length - this.stderrLimitBytes);
    } else {
      this.stderr = combined;
    }
  }

  drainStderr(): string {
    const value = this.stderr;
    this.stderr = '';
    return value;
  }

  state() {
    return {
      pending: this.pending.size,
      requestTimeoutMs: this.requestTimeoutMs,
      maxLineBytes: this.maxLineBytes,
      overflowLines: this.overflowLines,
      stderrBytes: this.stderr.length,
      stderrDropped: this.stderrDropped,
      closed: this.closed,
    };
  }

  send(request: HelperRequest, signal?: AbortSignal): Promise<HelperResponse> {
    if (this.closed) return Promise.reject(new HelperError('helper-closed'));
    if (signal?.aborted) return Promise.reject(new HelperError('helper-aborted'));
    if (this.pending.has(request.requestId)) return Promise.reject(new HelperError('duplicate-request-id'));
    if (this.pending.size >= this.maxInFlight) return Promise.reject(new HelperError('helper-inflight-limit'));
    return new Promise<HelperResponse>((resolve, reject) => {
      const settle = (error?: Error, response?: HelperResponse) => {
        const waiter = this.pending.get(request.requestId);
        if (!waiter) return;
        this.pending.delete(request.requestId);
        if (waiter.timer) clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else if (response) resolve(response);
      };
      const abort = () => settle(new HelperError('helper-aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => settle(new HelperError('helper-response-timeout')), this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(request.requestId, { resolve: response => settle(undefined, response), reject: error => settle(error), timer });
      try { this.process.stdin.write(`${JSON.stringify(request)}\n`); }
      catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  forceStop(): void {
    try { this.process.kill(); } catch { /* already gone */ }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new HelperError('helper-closed');
    for (const waiter of this.pending.values()) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    try { this.process.stdin.end(); } catch { /* best effort */ }
    try { this.process.kill(); } catch { /* best effort */ }
  }
}

export type WindowState = { exists: boolean; focused: boolean; visible: boolean; pid?: number; hwnd?: string };

export type WindowsHelperDriverOptions = {
  /** Connection/helper epoch; a new epoch clears dedup and the command-sequence high-water. */
  epoch?: string;
  /** Per-request response deadline. Default 500ms. */
  requestTimeoutMs?: number;
  /** Bounded release deadline used by releaseOwnedInputs and shutdown. Default 250ms. */
  releaseTimeoutMs?: number;
  /** Bounded shutdown command deadline. Default 500ms. */
  shutdownTimeoutMs?: number;
  /** Dedup cache bounds. Defaults: 4096 entries / 10 minutes. */
  dedupCapacity?: number;
  dedupTtlMs?: number;
  /** Maximum outstanding helper requests. Default 32. */
  inFlightLimit?: number;
  /** Full-replacement held-input pulse TTL. The helper clamps to <=150ms. */
  pulseTtlMs?: number;
  /** Node-side liveness window for the helper heartbeat. Default 500ms. */
  heartbeatTimeoutMs?: number;
};

type DedupRecord = { hash: string; sequence: number; at: number; status: 'receipt' | 'attempted' };

const SAFETY_COMMANDS: ReadonlySet<HelperCommand> = new Set(['probe', 'releaseOwnedInputs', 'shutdown']);
const NON_IDEMPOTENT: ReadonlySet<HelperCommand> = new Set(['moveRelative', 'click', 'typeText']);

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

type HelperResultRecord = { [key: string]: unknown };

export class WindowsHelperDriver {
  private requestSequence = 0;
  private commandSequence = 0;
  private highWater = 0;
  private generation = -1;
  private epoch: string;
  private bound = false;
  private windowState?: WindowState;
  private boundIdentity?: { pid: number; hwnd: string };
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastHeartbeatAt = Number.NEGATIVE_INFINITY;
  private releasedForStaleHeartbeat = false;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly options: Required<WindowsHelperDriverOptions>;
  private readonly dedup = new Map<string, DedupRecord>();
  private inFlight = 0;

  constructor(
    private readonly transport: HelperTransport,
    private readonly enabled = false,
    now: () => number = () => Date.now(),
    heartbeatMs = 250,
    options: WindowsHelperDriverOptions = {},
  ) {
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.options = {
      epoch: options.epoch ?? '',
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      releaseTimeoutMs: options.releaseTimeoutMs ?? 250,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 500,
      dedupCapacity: options.dedupCapacity ?? 4096,
      dedupTtlMs: options.dedupTtlMs ?? 10 * 60_000,
      inFlightLimit: options.inFlightLimit ?? 32,
      pulseTtlMs: Math.min(options.pulseTtlMs ?? 150, 150),
      heartbeatTimeoutMs: Math.min(options.heartbeatTimeoutMs ?? 500, 500),
    };
    this.epoch = this.options.epoch;
  }

  /** Helper transport/process death. The orchestrator revokes control before any restart. */
  onExit(listener: (reason: string) => void): () => void {
    return this.transport.onExit?.(reason => {
      this.stopWatchdog();
      this.bound = false;
      this.windowState = undefined;
      listener(reason);
    }) ?? (() => undefined);
  }

  /** Monitor state used by BridgeService.status(). */
  state() {
    const stale = this.now() - this.lastHeartbeatAt > this.options.heartbeatTimeoutMs;
    return {
      enabled: this.enabled,
      bound: this.bound,
      window: this.windowState ?? null,
      epoch: this.epoch,
      generation: this.generation,
      heartbeat: { armed: Number.isFinite(this.lastHeartbeatAt), stale },
      dedup: { size: this.dedup.size, capacity: this.options.dedupCapacity, ttlMs: this.options.dedupTtlMs, highWater: this.highWater, commandSequence: this.commandSequence },
      inFlight: this.inFlight,
      requestTimeoutMs: this.options.requestTimeoutMs,
      releaseTimeoutMs: this.options.releaseTimeoutMs,
      shutdownTimeoutMs: this.options.shutdownTimeoutMs,
      transport: this.transport.state?.() ?? null,
    };
  }

  /** Backwards-compatible monitor accessor. */
  helperState() { return this.state(); }

  /**
   * Switch epoch. Old held input is released and dedup/sequence state is cleared so an
   * expired command id can never be mistaken for a fresh action after a helper restart.
   */
  setEpoch(epoch: string): void {
    if (!epoch || epoch === this.epoch) return;
    this.epoch = epoch;
    this.resetEpochState();
    if (this.enabled && this.bound) void this.releaseOwnedInputs().catch(() => undefined);
  }

  private resetEpochState(): void {
    this.dedup.clear();
    this.highWater = 0;
    this.commandSequence = 0;
    this.generation = -1;
  }

  private nextCommandSequence(): number {
    this.commandSequence += 1;
    return this.commandSequence;
  }

  private pruneDedup(): void {
    const cutoff = this.now() - this.options.dedupTtlMs;
    for (const [commandId, record] of this.dedup) if (record.at < cutoff) this.dedup.delete(commandId);
    while (this.dedup.size > this.options.dedupCapacity) {
      const oldest = this.dedup.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.dedup.delete(oldest);
    }
  }

  private payloadHash(command: string, fields: Record<string, unknown>): string {
    return createHash('sha256').update(`${command}:${canonicalJson(fields)}`).digest('hex');
  }

  private commandIdResult(commandId: string, payloadHash: string): HelperResultRecord | undefined {
    this.pruneDedup();
    const record = this.dedup.get(commandId);
    if (!record) return undefined;
    if (record.hash !== payloadHash) throw new HelperError('duplicate-command-payload-mismatch');
    // The helper returns the original receipt for a same-payload duplicate. From the
    // driver's point of view the caller must not resend either way.
    return record.status === 'receipt' ? { duplicate: true } : { duplicate: true, ambiguous: true, attempted: true };
  }

  private recordCommand(commandId: string, payloadHash: string, sequence: number, status: 'receipt' | 'attempted'): void {
    this.dedup.set(commandId, { hash: payloadHash, sequence, at: this.now(), status });
    if (sequence > this.highWater) this.highWater = sequence;
    this.pruneDedup();
  }

  private async command(
    command: HelperCommand,
    fields: Record<string, unknown> = {},
    control: { timeoutMs?: number; timeoutCode?: string } = {},
  ): Promise<unknown> {
    // Safety operations remain available even when OS input is disabled.
    if (!this.enabled && !SAFETY_COMMANDS.has(command)) throw new HelperError('os-input-disabled');
    if (this.inFlight >= this.options.inFlightLimit) throw new HelperError('helper-inflight-limit');
    const requestId = `${command}_${++this.requestSequence}`;
    this.inFlight += 1;
    try {
      const response = await withTimeout(
        this.transport.send({ requestId, command, ...fields }),
        control.timeoutMs ?? this.options.requestTimeoutMs,
        control.timeoutCode ?? 'helper-response-timeout',
      );
      if (response.requestId !== requestId) throw new HelperError('helper-response-id-mismatch');
      if (!response.ok) {
        const code = response.errorCode ?? response.error ?? 'helper-error';
        throw new HelperError(code, response.error ?? code);
      }
      return response.result;
    } finally {
      this.inFlight -= 1;
    }
  }

  private assertInputAllowed(): void {
    if (!this.bound) throw new HelperError('window-not-actionable');
    if (!this.windowState) throw new HelperError('window-state-required');
    if (!this.windowState.exists || !this.windowState.focused || !this.windowState.visible || this.windowState.pid !== this.boundIdentity?.pid || this.windowState.hwnd !== this.boundIdentity?.hwnd) throw new HelperError('window-not-actionable');
  }

  private assertFresh(leaseUntil: number): void {
    if (!Number.isFinite(leaseUntil)) throw new HelperError('invalid-lease');
    if (leaseUntil <= this.now()) throw new HelperError('input-expired');
    this.assertInputAllowed();
  }

  private assertCommandId(commandId: string): void {
    if (!commandId || commandId.length > 256) throw new HelperError('command-id-required');
  }

  private assertFinite(...values: number[]): void {
    if (values.some(value => !Number.isFinite(value))) throw new HelperError('invalid-input');
  }

  // Liveness is the caller's heartbeat confirmation, not a release timestamp: releasing once
  // per missed window must not repeat while the link stays stale, and active input alone
  // must not trigger a release.
  private startWatchdog(): void {
    this.stopWatchdog();
    this.heartbeatTimer = setInterval(() => {
      const stale = this.now() - this.lastHeartbeatAt > this.options.heartbeatTimeoutMs;
      if (stale && !this.releasedForStaleHeartbeat) {
        this.releasedForStaleHeartbeat = true;
        void this.releaseOwnedInputs().catch(() => undefined);
      }
    }, Math.min(this.heartbeatMs, 250));
  }

  private stopWatchdog(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  probe() { return this.command('probe'); }

  async bindWindow(pid: number, hwnd: string, epoch?: string) {
    if (!Number.isInteger(pid) || pid <= 0 || !hwnd) throw new HelperError('window-identity-required');
    if (epoch && epoch !== this.epoch) this.epoch = epoch;
    const result = await this.command('bindWindow', { pid, hwnd, epoch: this.epoch }) as { bound?: unknown; pid?: unknown; hwnd?: unknown; epoch?: unknown } | undefined;
    // The helper must confirm the same identity it was asked to bind.
    if (!result || result.bound !== true) throw new HelperError('window-bind-unconfirmed');
    if (result.pid !== undefined && Number(result.pid) !== pid) throw new HelperError('window-pid-mismatch');
    if (result.hwnd !== undefined && String(result.hwnd).toLowerCase() !== String(hwnd).toLowerCase()) throw new HelperError('window-hwnd-mismatch');
    this.bound = true;
    this.boundIdentity = { pid, hwnd };
    this.windowState = { exists: true, focused: true, visible: true, pid, hwnd };
    this.lastHeartbeatAt = this.now();
    this.releasedForStaleHeartbeat = false;
    this.resetEpochState();
    this.startWatchdog();
    return result;
  }

  async getWindowState() {
    if (!this.bound) throw new HelperError('window-not-bound');
    const raw = await this.command('getWindowState') as Partial<WindowState>;
    // Missing identity fields are unknown, never silently filled from the local binding.
    const state: WindowState = {
      exists: raw.exists === true,
      focused: raw.focused === true,
      visible: raw.visible === true,
      ...(raw.pid === undefined ? {} : { pid: raw.pid }),
      ...(raw.hwnd === undefined ? {} : { hwnd: raw.hwnd }),
    };
    this.windowState = state;
    const identityVerified = raw.pid !== undefined && raw.hwnd !== undefined && String(raw.pid) === String(this.boundIdentity?.pid) && String(raw.hwnd).toLowerCase() === String(this.boundIdentity?.hwnd).toLowerCase();
    if (!state.exists || !state.focused || !state.visible || !identityVerified) await this.releaseOwnedInputs().catch(() => undefined);
    if (!identityVerified) throw new HelperError('window-identity-unverified');
    return state;
  }

  moveRelative(dx: number, dy: number, commandId: string, leaseUntil: number, generation = 0) {
    this.assertFinite(dx, dy);
    this.assertCommandId(commandId);
    const payload = { dx, dy, leaseUntil, generation };
    const payloadHash = this.payloadHash('moveRelative', payload);
    // A same-payload duplicate returns the original receipt even if its lease has expired.
    const duplicate = this.commandIdResult(commandId, payloadHash);
    if (duplicate) return Promise.resolve(duplicate);
    this.assertFresh(leaseUntil);
    const sequence = this.nextCommandSequence();
    this.generation = Math.max(this.generation, generation);
    return this.command('moveRelative', { ...payload, commandId, commandSeq: sequence, epoch: this.epoch })
      .then(result => { this.recordCommand(commandId, payloadHash, sequence, 'receipt'); return result; },
        error => { this.recordCommand(commandId, payloadHash, sequence, 'attempted'); throw error; });
  }

  click(button: string, commandId: string, leaseUntil: number, generation = 0) {
    this.assertCommandId(commandId);
    if (!['left', 'right', 'middle'].includes(button)) throw new HelperError('invalid-mouse-button');
    const payload = { button, leaseUntil, generation };
    const payloadHash = this.payloadHash('click', payload);
    const duplicate = this.commandIdResult(commandId, payloadHash);
    if (duplicate) return Promise.resolve(duplicate);
    this.assertFresh(leaseUntil);
    const sequence = this.nextCommandSequence();
    this.generation = Math.max(this.generation, generation);
    return this.command('click', { ...payload, commandId, commandSeq: sequence, epoch: this.epoch })
      .then(result => { this.recordCommand(commandId, payloadHash, sequence, 'receipt'); return result; },
        error => { this.recordCommand(commandId, payloadHash, sequence, 'attempted'); throw error; });
  }

  setHeldInputs(inputs: Record<string, boolean>, generation: number, leaseUntil: number) {
    if (Object.entries(inputs).some(([key, value]) => !this.validHeldKey(key) || typeof value !== 'boolean')) throw new HelperError('invalid-held-input');
    if (!Number.isInteger(generation) || generation < 0) throw new HelperError('invalid-generation');
    this.assertFresh(leaseUntil);
    const sequence = this.nextCommandSequence();
    this.generation = Math.max(this.generation, generation);
    // Full replacement, not a patch: the helper releases every key/button missing from
    // this object (an empty object releases all).
    return this.command('setHeldInputs', {
      inputs,
      generation,
      leaseUntil,
      commandSeq: sequence,
      epoch: this.epoch,
      pulseTtlMs: this.options.pulseTtlMs,
    });
  }

  async typeText(text: string, commandId: string, leaseUntil: number, generation = 0) {
    this.assertCommandId(commandId);
    if (text.includes('\0')) throw new HelperError('invalid-text');
    const payload = { text, leaseUntil, generation };
    const payloadHash = this.payloadHash('typeText', payload);
    const duplicate = this.commandIdResult(commandId, payloadHash);
    if (duplicate) return duplicate;
    this.assertFresh(leaseUntil);
    const sequence = this.nextCommandSequence();
    this.generation = Math.max(this.generation, generation);
    try {
      const result = await this.command('typeText', { ...payload, commandId, commandSeq: sequence, epoch: this.epoch });
      const record = result as HelperResultRecord | undefined;
      // A structured partial/ambiguous receipt still means characters may have reached the
      // OS. Mark it attempted so this command id is never retried; the caller must decide
      // explicitly how to reconcile, not blindly resend the rest.
      const attempted = Boolean(record && (record.partial === true || record.ambiguous === true));
      this.recordCommand(commandId, payloadHash, sequence, attempted ? 'attempted' : 'receipt');
      return result;
    } catch (error) {
      this.recordCommand(commandId, payloadHash, sequence, 'attempted');
      throw error;
    }
  }

  captureWindow() {
    if (!this.enabled) throw new HelperError('os-input-disabled');
    if (!this.bound) throw new HelperError('window-not-bound');
    return this.command('captureWindow');
  }

  releaseOwnedInputs() {
    return this.command('releaseOwnedInputs', {}, { timeoutMs: this.options.releaseTimeoutMs, timeoutCode: 'helper-release-timeout' });
  }

  async heartbeat() {
    const result = await this.command('heartbeat');
    this.lastHeartbeatAt = this.now();
    this.releasedForStaleHeartbeat = false;
    return result;
  }

  async shutdown() {
    this.stopWatchdog();
    let releaseError: unknown;
    try {
      if (this.enabled && this.bound) await this.releaseOwnedInputs();
    } catch (error) {
      releaseError = error;
    } finally {
      this.bound = false;
      this.boundIdentity = undefined;
      this.windowState = undefined;
    }
    try {
      await this.command('shutdown', {}, { timeoutMs: this.options.shutdownTimeoutMs, timeoutCode: 'helper-shutdown-timeout' });
    } catch (error) {
      if (!releaseError) releaseError = error;
    } finally {
      await this.transport.close().catch(() => undefined);
    }
    if (releaseError) throw releaseError;
  }

  /** Hard stop used after the graceful shutdown deadline expires. Never waits unbounded. */
  forceStop(): void {
    this.stopWatchdog();
    this.bound = false;
    this.boundIdentity = undefined;
    this.windowState = undefined;
    try { this.transport.forceStop?.(); } catch { /* best effort */ }
    void this.transport.close().catch(() => undefined);
  }

  private validHeldKey(key: string): boolean {
    if (/^[0-9]{1,3}$/.test(key)) return Number(key) <= 255;
    if (key === 'mouse:left' || key === 'mouse:right' || key === 'mouse:middle') return true;
    return /^scan:[0-9]{1,5}(?::ext)?$/.test(key) && Number(key.startsWith('scan:') ? key.slice(5).replace(':ext', '') : '0') <= 65535;
  }
}
