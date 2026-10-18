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
    if (signal?.aborted) return Promise.reject(new Error('helper-aborted'));
    if (this.pending.has(request.requestId)) return Promise.reject(new Error('duplicate-request-id'));
    return new Promise((resolve, reject) => {
      const abort = () => { this.pending.delete(request.requestId); reject(new Error('helper-aborted')); };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(request.requestId, { resolve: value => { signal?.removeEventListener('abort', abort); resolve(value); }, reject: error => { signal?.removeEventListener('abort', abort); reject(error); } });
      try { this.process.stdin.write(`${JSON.stringify(request)}\n`); }
      catch (error) { this.pending.delete(request.requestId); signal?.removeEventListener('abort', abort); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('helper-closed');
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.lines.close();
    this.process.stdin.end();
    this.process.kill();
  }
}

export class WindowsHelperDriver {
  private sequence = 0;
  private bound = false;
  private state?: WindowState;
  private boundIdentity?: { pid: number; hwnd: string };
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastReleaseAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly heartbeatMs: number;
  private readonly completedCommands = new Set<string>();
  constructor(private readonly transport: HelperTransport, private readonly enabled = false, now: () => number = () => Date.now(), heartbeatMs = 250) { this.now = now; this.heartbeatMs = heartbeatMs; }
  private commandIdResult(commandId: string) { return this.completedCommands.has(commandId) ? { duplicate: true } : undefined; }
  private markCommand(commandId: string) { this.completedCommands.add(commandId); }
  private async command(command: HelperCommand, fields: Record<string, unknown> = {}) {
    // Safety operations remain available even when OS input is disabled.
    if (!this.enabled && !['probe', 'releaseOwnedInputs', 'shutdown'].includes(command)) throw new Error('os-input-disabled');
    const requestId = `${command}_${++this.sequence}`;
    const response = await this.transport.send({ requestId, command, ...fields });
    if (response.requestId !== requestId) throw new Error('helper-response-id-mismatch');
    if (!response.ok) throw new Error(response.error ?? 'helper-error'); return response.result;
  }
  private assertInputAllowed() { if (!this.bound) throw new Error('window-not-actionable'); if (!this.state) throw new Error('window-state-required'); if (!this.state.exists || !this.state.focused || !this.state.visible || this.state.pid !== this.boundIdentity?.pid || this.state.hwnd !== this.boundIdentity?.hwnd) throw new Error('window-not-actionable'); }
  private assertFresh(leaseUntil: number) { if (leaseUntil <= this.now()) throw new Error('input-expired'); this.assertInputAllowed(); }
  private startWatchdog() { this.stopWatchdog(); this.heartbeatTimer = setInterval(() => { if (this.now() - this.lastReleaseAt > this.heartbeatMs * 2) { this.lastReleaseAt = this.now(); void this.releaseOwnedInputs().catch(() => undefined); } }, this.heartbeatMs); }
  private stopWatchdog() { if (this.heartbeatTimer) clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined; }
  probe() { return this.command('probe'); }
  async bindWindow(pid: number, hwnd: string) {
    if (!Number.isInteger(pid) || pid <= 0 || !hwnd) throw new Error('window-identity-required');
    const result = await this.command('bindWindow', { pid, hwnd }) as { bound?: unknown; pid?: unknown; hwnd?: unknown } | undefined;
    // The helper must confirm the same identity it was asked to bind.
    if (!result || result.bound !== true) throw new Error('window-bind-unconfirmed');
    if (result.pid !== undefined && Number(result.pid) !== pid) throw new Error('window-pid-mismatch');
    if (result.hwnd !== undefined && String(result.hwnd).toLowerCase() !== String(hwnd).toLowerCase()) throw new Error('window-hwnd-mismatch');
    this.bound = true; this.boundIdentity = { pid, hwnd }; this.state = { exists: true, focused: true, visible: true, pid, hwnd }; this.lastReleaseAt = this.now(); this.startWatchdog(); return result;
  }
  async getWindowState() {
    if (!this.bound) throw new Error('window-not-bound');
    const raw = await this.command('getWindowState') as Partial<WindowState>;
    // Missing identity fields are unknown, never silently filled from the local binding.
    const state: WindowState = {
      exists: raw.exists === true,
      focused: raw.focused === true,
      visible: raw.visible === true,
      ...(raw.pid === undefined ? {} : { pid: raw.pid }),
      ...(raw.hwnd === undefined ? {} : { hwnd: raw.hwnd }),
    };
    this.state = state;
    const identityVerified = raw.pid !== undefined && raw.hwnd !== undefined && String(raw.pid) === String(this.boundIdentity?.pid) && String(raw.hwnd).toLowerCase() === String(this.boundIdentity?.hwnd).toLowerCase();
    if (!state.exists || !state.focused || !state.visible || !identityVerified) await this.releaseOwnedInputs();
    if (!identityVerified) throw new Error('window-identity-unverified');
    return state;
  }
  moveRelative(dx: number, dy: number, commandId: string, leaseUntil: number, generation = 0) {
    const duplicate = this.commandIdResult(commandId); if (duplicate) return Promise.resolve(duplicate);
    this.assertCommandId(commandId); this.assertFinite(dx, dy); this.assertFresh(leaseUntil);
    return this.command('moveRelative', { dx, dy, commandId, leaseUntil, generation }).then(result => { this.markCommand(commandId); return result; });
  }
  click(button: string, commandId: string, leaseUntil: number, generation = 0) {
    const duplicate = this.commandIdResult(commandId); if (duplicate) return Promise.resolve(duplicate);
    this.assertCommandId(commandId); if (!['left', 'right', 'middle'].includes(button)) throw new Error('invalid-mouse-button'); this.assertFresh(leaseUntil);
    return this.command('click', { button, commandId, leaseUntil, generation }).then(result => { this.markCommand(commandId); return result; });
  }
  setHeldInputs(inputs: Record<string, boolean>, generation: number, leaseUntil: number) { if (Object.entries(inputs).some(([key, value]) => !/^[0-9]{1,3}$/.test(key) || !Number.isInteger(Number(key)) || Number(key) > 255 || typeof value !== 'boolean')) throw new Error('invalid-held-input'); if (!Number.isInteger(generation) || generation < 0) throw new Error('invalid-generation'); this.assertFresh(leaseUntil); return this.command('setHeldInputs', { inputs, generation, leaseUntil }); }
  async typeText(text: string, commandId: string, leaseUntil: number, generation = 0) {
    const duplicate = this.commandIdResult(commandId); if (duplicate) return duplicate;
    this.assertCommandId(commandId); if (text.includes('\0')) throw new Error('invalid-text'); this.assertFresh(leaseUntil);
    const result = await this.command('typeText', { text, commandId, leaseUntil, generation }); this.markCommand(commandId); return result;
  }
  private assertCommandId(commandId: string) { if (!commandId || commandId.length > 256) throw new Error('command-id-required'); }
  private assertFinite(...values: number[]) { if (values.some(value => !Number.isFinite(value))) throw new Error('invalid-input'); }
  captureWindow() { if (!this.enabled) throw new Error('os-input-disabled'); if (!this.bound) throw new Error('window-not-bound'); return this.command('captureWindow'); }
  releaseOwnedInputs() { return this.command('releaseOwnedInputs'); }
  async heartbeat() { this.lastReleaseAt = this.now(); return this.command('heartbeat'); }
  async shutdown() { this.stopWatchdog(); let releaseError: unknown; try { if (this.enabled && this.bound) await this.releaseOwnedInputs(); } catch (error) { releaseError = error; } finally { this.bound = false; this.boundIdentity = undefined; this.state = undefined; } try { await this.command('shutdown'); } finally { await this.transport.close(); } if (releaseError) throw releaseError; }
}
