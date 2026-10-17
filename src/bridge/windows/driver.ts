import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type HelperCommand = 'probe'|'bindWindow'|'getWindowState'|'setHeldInputs'|'moveRelative'|'click'|'typeText'|'captureWindow'|'releaseOwnedInputs'|'heartbeat'|'shutdown';
export type HelperRequest = { requestId: string; command: HelperCommand; [key: string]: unknown };
export type HelperResponse = { requestId: string; ok: boolean; result?: unknown; error?: string };
export interface HelperTransport { send(request: HelperRequest, signal?: AbortSignal): Promise<HelperResponse>; close(): Promise<void> }
export type WindowState = { exists: boolean; focused: boolean; visible: boolean; pid?: number; hwnd?: string };

export class FakeHelperTransport implements HelperTransport {
  readonly requests: HelperRequest[] = [];
  private readonly seen = new Set<string>();
  constructor(private readonly responder: (request: HelperRequest) => HelperResponse = request => ({ requestId: request.requestId, ok: true, result: { command: request.command, dryRun: true } })) {}
  async send(request: HelperRequest): Promise<HelperResponse> {
    this.requests.push(request);
    if (this.seen.has(request.requestId) && ['moveRelative','click','typeText'].includes(request.command)) return { requestId: request.requestId, ok: true, result: { duplicate: true } };
    this.seen.add(request.requestId); return this.responder(request);
  }
  async close() {}
}

export class JsonlHelperTransport implements HelperTransport {
  private readonly pending = new Map<string, { resolve: (response: HelperResponse) => void; reject: (error: Error) => void }>();
  private readonly lines;
  private closed = false;
  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: process.stdout });
    this.lines.on('line', line => {
      try { const response = JSON.parse(line) as HelperResponse; const waiter = this.pending.get(response.requestId); if (waiter) { this.pending.delete(response.requestId); waiter.resolve(response); } }
      catch { /* malformed helper output is ignored; request timeout handles it */ }
    });
    const fail = () => { for (const waiter of this.pending.values()) waiter.reject(new Error('helper-exited')); this.pending.clear(); };
    process.once('exit', fail); process.once('error', fail);
  }
  static start(scriptPath: string, dryRun = false): JsonlHelperTransport {
    if (process.platform !== 'win32') throw new Error('windows-helper-requires-windows');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
    if (dryRun) args.push('-DryRun');
    return new JsonlHelperTransport(spawn('powershell.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
  }
  send(request: HelperRequest, signal?: AbortSignal): Promise<HelperResponse> {
    if (this.closed) return Promise.reject(new Error('helper-closed'));
    return new Promise((resolve, reject) => {
      const abort = () => { this.pending.delete(request.requestId); reject(new Error('helper-aborted')); };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(request.requestId, { resolve: value => { signal?.removeEventListener('abort', abort); resolve(value); }, reject });
      this.process.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }
  async close() { if (this.closed) return; this.closed = true; this.lines.close(); this.process.stdin.end(); this.process.kill(); }
}

export class WindowsHelperDriver {
  private sequence = 0;
  private bound = false;
  private state?: WindowState;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastHeartbeat = 0;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly completedCommands = new Set<string>();
  constructor(private readonly transport: HelperTransport, private readonly enabled = false, now: () => number = () => Date.now(), heartbeatMs = 2_000) { this.now = now; this.heartbeatMs = heartbeatMs; }
  private commandIdResult(commandId: string) { return this.completedCommands.has(commandId) ? { duplicate: true } : undefined; }
  private markCommand(commandId: string) { this.completedCommands.add(commandId); }
  private async command(command: HelperCommand, fields: Record<string, unknown> = {}) {
    if (!this.enabled && !['probe', 'shutdown'].includes(command)) throw new Error('os-input-disabled');
    const response = await this.transport.send({ requestId: `${command}_${++this.sequence}`, command, ...fields });
    if (response.requestId !== `${command}_${this.sequence}`) throw new Error('helper-response-id-mismatch');
    if (!response.ok) throw new Error(response.error ?? 'helper-error'); return response.result;
  }
  private assertInputAllowed() { if (!this.bound) throw new Error('window-not-actionable'); if (!this.state) throw new Error('window-state-required'); if (!this.state.exists || !this.state.focused || !this.state.visible) throw new Error('window-not-actionable'); }
  private assertFresh(leaseUntil: number) { if (leaseUntil <= this.now()) throw new Error('input-expired'); this.assertInputAllowed(); }
  private startWatchdog() { this.stopWatchdog(); this.lastHeartbeat = this.now(); this.heartbeatTimer = setInterval(() => { if (this.now() - this.lastHeartbeat > this.heartbeatMs * 2) void this.releaseOwnedInputs().catch(() => undefined); }, this.heartbeatMs); }
  private stopWatchdog() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  probe() { return this.command('probe'); }
  async bindWindow(pid: number, hwnd: string) { if (!Number.isInteger(pid) || pid <= 0 || !hwnd) throw new Error('window-identity-required'); const result = await this.command('bindWindow', { pid, hwnd }); this.bound = true; this.state = { exists: true, focused: true, visible: true, pid, hwnd }; this.startWatchdog(); return result; }
  async getWindowState() {
    if (!this.bound) throw new Error('window-not-bound');
    const raw = await this.command('getWindowState') as Partial<WindowState>;
    // Minimal dry-run helpers may omit state fields; only explicit false is non-actionable.
    const state: WindowState = {
      exists: raw.exists !== false,
      focused: raw.focused !== false,
      visible: raw.visible !== false,
      ...(raw.pid === undefined ? {} : { pid: raw.pid }),
      ...(raw.hwnd === undefined ? {} : { hwnd: raw.hwnd }),
    };
    this.state = state;
    if (!state.exists || !state.focused || !state.visible) await this.releaseOwnedInputs();
    return state;
  }
  moveRelative(dx: number, dy: number, commandId: string, leaseUntil: number, generation = 0) { const duplicate = this.commandIdResult(commandId); if (duplicate) return Promise.resolve(duplicate); this.assertFresh(leaseUntil); this.markCommand(commandId); return this.command('moveRelative', { dx, dy, commandId, leaseUntil, generation }); }
  click(button: string, commandId: string, leaseUntil: number, generation = 0) { const duplicate = this.commandIdResult(commandId); if (duplicate) return Promise.resolve(duplicate); this.assertFresh(leaseUntil); this.markCommand(commandId); return this.command('click', { button, commandId, leaseUntil, generation }); }
  setHeldInputs(inputs: Record<string, boolean>, generation: number, leaseUntil: number) { this.assertFresh(leaseUntil); return this.command('setHeldInputs', { inputs, generation, leaseUntil }); }
  async typeText(text: string, commandId: string, leaseUntil: number, generation = 0) { if (text.includes('\0')) throw new Error('invalid-text'); await this.assertFresh(leaseUntil); return this.command('typeText', { text, commandId, leaseUntil, generation }); }
  captureWindow() { if (!this.enabled) throw new Error('os-input-disabled'); if (!this.bound) throw new Error('window-not-bound'); return this.command('captureWindow'); }
  releaseOwnedInputs() { return this.command('releaseOwnedInputs'); }
  async heartbeat() { this.lastHeartbeat = this.now(); return this.command('heartbeat'); }
  async shutdown() { this.stopWatchdog(); if (this.enabled && this.bound) await this.releaseOwnedInputs(); this.bound = false; this.state = undefined; await this.command('shutdown'); await this.transport.close(); }
}
