import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const harnessPath = join(repoRoot, 'tests/e2e/server-harness.mjs');
const cliMainPath = join(repoRoot, 'dist/cli/main.js');

const liveChildren = new Set<ChildProcess>();
const temporaryDirs = new Set<string>();

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export const isProcessAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

type HarnessLogs = { stdout: string; stderr: string };

function collectLogs(child: ChildProcess): HarnessLogs {
  const logs: HarnessLogs = { stdout: '', stderr: '' };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { logs.stdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { logs.stderr += chunk; });
  return logs;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    liveChildren.delete(child);
    return;
  }
  child.kill('SIGTERM');
  const exited = await Promise.race([once(child, 'exit').then(() => true), delay(5_000).then(() => false)]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), delay(2_000)]);
  }
  liveChildren.delete(child);
}

async function waitForReady(child: ChildProcess, logs: HarnessLogs): Promise<{ url: string; db: string; pid: number }> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (error: Error | undefined, value?: { url: string; db: string; pid: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(value!);
    };
    const onStdout = (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let document: Record<string, unknown>;
        try { document = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (document.ready === true) {
          finish(undefined, { url: String(document.url), db: String(document.db), pid: Number(document.pid) });
          return;
        }
        if (document.ready === false) {
          finish(new Error(`server startup failed: ${String(document.error)}`));
          return;
        }
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`server exited before ready (code=${code}, signal=${signal}); stderr=${logs.stderr.trim()}`));
    };
    const timer = setTimeout(() => {
      finish(new Error(`server did not become ready within 15s; stdout=${logs.stdout.trim()} stderr=${logs.stderr.trim()}`));
    }, 15_000);
    child.stdout?.on('data', onStdout);
    child.once('exit', onExit);
  });
}

export type RunningServer = {
  url: string;
  dir: string;
  db: string;
  pairingCode: string;
  cliBearer: string;
  pid: number;
  child: ChildProcess;
  logs: HarnessLogs;
  stop(): Promise<void>;
};

export async function startServer(options: { pairingCode?: string; cliBearer?: string } = {}): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), 'furevercraft-e2e-'));
  temporaryDirs.add(dir);
  const db = join(dir, 'state.sqlite');
  const pairingCode = options.pairingCode ?? `pair-${randomBytes(6).toString('hex')}`;
  const cliBearer = options.cliBearer ?? `bearer-${randomBytes(8).toString('hex')}`;
  const child = spawn(process.execPath, [
    harnessPath,
    '--db', db,
    '--web-root', join(repoRoot, 'dist/web'),
    '--pairing-code', pairingCode,
    '--cli-bearer', cliBearer,
  ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  liveChildren.add(child);
  const logs = collectLogs(child);
  let ready: { url: string; db: string; pid: number };
  try {
    ready = await waitForReady(child, logs);
  } catch (error) {
    await stopChild(child);
    temporaryDirs.delete(dir);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const server: RunningServer = {
    url: ready.url,
    dir,
    db: ready.db,
    pairingCode,
    cliBearer,
    pid: ready.pid,
    child,
    logs,
    async stop() {
      await stopChild(child);
      temporaryDirs.delete(dir);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return server;
}

/** Start a second harness against an owned database and prove it exits non-zero. */
export async function expectServerStartupFailure(db: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const child = spawn(process.execPath, [
    harnessPath,
    '--db', db,
    '--web-root', join(repoRoot, 'dist/web'),
    '--pairing-code', `pair-${randomBytes(4).toString('hex')}`,
  ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  liveChildren.add(child);
  const logs = collectLogs(child);
  const exited = await Promise.race([
    once(child, 'exit').then(([code]) => ({ code: code as number | null, timedOut: false })),
    delay(10_000).then(() => ({ code: null as number | null, timedOut: true })),
  ]);
  if (exited.timedOut) await stopChild(child);
  else liveChildren.delete(child);
  return { ...exited, stdout: logs.stdout, stderr: logs.stderr };
}

type CliEntry =
  | { kind: 'subscription'; value: Record<string, unknown> }
  | { kind: 'event'; value: Record<string, unknown> }
  | { kind: 'response'; value: unknown };

/** Drives the compiled attach CLI over a real pipe, exactly as a terminal would. */
export class AttachClient {
  private readonly child: ChildProcess;
  private readonly entries: CliEntry[] = [];
  private readonly responses: unknown[] = [];
  private readonly waiters: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private readonly subscriptionIndex = new Map<string, number>();
  private readonly eventIndex = new Map<string, number>();
  private output = '';
  private buffer = '';

  private constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consume(chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { this.output += chunk; });
  }

  static async start(url: string, token: string): Promise<AttachClient> {
    const child = spawn(process.execPath, [cliMainPath, 'attach', '--url', url, '--token', token], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    liveChildren.add(child);
    const client = new AttachClient(child);
    return client;
  }

  private consume(chunk: string) {
    this.output += chunk;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line) as Record<string, unknown>; } catch { entry = { raw: line }; }
      if (entry.subscription !== undefined) {
        this.entries.push({ kind: 'subscription', value: entry.subscription as Record<string, unknown> });
        continue;
      }
      if (entry.event !== undefined || entry.gap !== undefined) {
        this.entries.push({ kind: 'event', value: entry });
        continue;
      }
      this.entries.push({ kind: 'response', value: entry });
      const waiter = this.waiters.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(entry); }
      else this.responses.push(entry);
    }
  }

  get transcript(): string { return this.output; }

  send(line: string) { this.child.stdin?.write(`${line}\n`); }

  command(line: string, timeoutMs = 15_000): Promise<unknown> {
    if (this.responses.length) return Promise.resolve(this.responses.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex(waiter => waiter.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`attach command timed out: ${line}`));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
      this.send(line);
    });
  }

  private async waitUntil<T>(probe: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = probe();
      if (value !== undefined) return value;
      if (Date.now() >= deadline) throw new Error(`attach wait timed out: ${what}`);
      await delay(10);
    }
  }

  waitSubscription(state: string): Promise<Record<string, unknown>> {
    return this.waitUntil(() => {
      const from = this.subscriptionIndex.get(state) ?? 0;
      for (let index = from; index < this.entries.length; index += 1) {
        const entry = this.entries[index];
        if (entry?.kind === 'subscription' && entry.value.state === state) {
          this.subscriptionIndex.set(state, index + 1);
          return entry.value;
        }
      }
      return undefined;
    }, `subscription ${state}`);
  }

  waitEvent(kind: string): Promise<Record<string, unknown>> {
    return this.waitUntil(() => {
      const from = this.eventIndex.get(kind) ?? 0;
      for (let index = from; index < this.entries.length; index += 1) {
        const entry = this.entries[index];
        const nested = entry?.kind === 'event' ? entry.value.event as Record<string, unknown> | undefined : undefined;
        if (nested?.kind === kind) {
          this.eventIndex.set(kind, index + 1);
          return nested;
        }
      }
      return undefined;
    }, `event ${kind}`);
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) { liveChildren.delete(this.child); return; }
    try { this.send('quit'); } catch { /* stdin may already be closed */ }
    const exited = await Promise.race([once(this.child, 'exit').then(() => true), delay(3_000).then(() => false)]);
    if (!exited) await stopChild(this.child);
    else liveChildren.delete(this.child);
  }
}

/** Kill every process and remove every temp directory, including after a failed assertion. */
export async function cleanupAll(): Promise<void> {
  for (const child of [...liveChildren]) await stopChild(child);
  for (const dir of temporaryDirs) rmSync(dir, { recursive: true, force: true });
  temporaryDirs.clear();
}

export function temporaryStateExists(dir: string): boolean { return existsSync(dir); }
