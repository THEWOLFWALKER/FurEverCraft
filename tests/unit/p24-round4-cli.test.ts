import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net, { type AddressInfo } from 'node:net';
import { runServe } from '../../src/cli/main.js';
import { RuntimeOwnershipLock } from '../../src/execution/ownership.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliMain = join(root, 'dist/cli/main.js');
const children = new Set<ChildProcess>();
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'furevercraft-round4-cli-'));
  dirs.push(dir);
  return dir;
};
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

beforeAll(() => {
  if (!existsSync(cliMain)) {
    throw new Error(`missing-built-cli: Round 4 CLI tests spawn the real CLI at ${cliMain}. Run \`npm run build\` before this test file.`);
  }
});

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  child.kill('SIGTERM');
  const exited = await Promise.race([once(child, 'exit').then(() => true), delay(5_000).then(() => false)]);
  if (!exited) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), delay(2_000)]);
  }
  children.delete(child);
}

afterEach(async () => {
  for (const child of [...children]) await stopChild(child);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type SpawnedServe = {
  child: ChildProcess;
  ready: Promise<Record<string, any>>;
  stdout: () => string;
  stderr: () => string;
};

/** Spawn the public CLI exactly as an operator would, with globals before the subcommand. */
function startServe(globalArgs: string[], serveArgs: string[]): SpawnedServe {
  const child = spawn(process.execPath, [cliMain, ...globalArgs, 'serve', ...serveArgs], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  let buffer = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
  const ready = new Promise<Record<string, any>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`serve-ready-timeout: stdout=${stdout.trim()} stderr=${stderr.trim()}`)), 20_000);
    const finish = (error: Error | undefined, value?: Record<string, any>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout!.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(value!);
    };
    const onData = (chunk: string) => {
      stdout += chunk;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let document: Record<string, any>;
        try { document = JSON.parse(line) as Record<string, any>; } catch { continue; }
        if (typeof document.listening === 'string') { finish(undefined, document); return; }
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`serve exited before ready (code=${code}, signal=${signal}); stderr=${stderr.trim()}`));
    };
    child.stdout!.on('data', onData);
    child.once('exit', onExit);
  });
  return { child, ready, stdout: () => stdout, stderr: () => stderr };
}

/** Spawn a one-shot CLI command and return its exit code plus parsed stdout lines. */
async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; documents: any[] }> {
  const child = spawn(process.execPath, [cliMain, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
  const [code] = await Promise.race([
    once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>,
    delay(20_000).then(() => { child.kill('SIGKILL'); return [null, null] as [null, null]; }),
  ]);
  children.delete(child);
  const documents = stdout.split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as any]; } catch { return []; }
  });
  return { code, stdout, stderr, documents };
}

const listen = (server: net.Server) => new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const closeServer = (server: net.Server) => new Promise<void>(resolve => server.close(() => resolve()));

describe('Round 4 — serve resolves merged --db options through the public CLI', () => {
  it('honors both serve --db and global --db, and isolated runtimes never share a lock', async () => {
    const dir = tempDir();
    const dbLocal = join(dir, 'local.sqlite');
    const dbGlobal = join(dir, 'global.sqlite');

    const local = startServe([], ['--db', dbLocal, '--port', '0', '--no-pairing']);
    const global = startServe(['--db', dbGlobal], ['--port', '0', '--no-pairing']);
    const [localReady, globalReady] = await Promise.all([local.ready, global.ready]);

    // The ready line reports the exact requested path, not the historical /tmp default.
    expect(localReady.db).toBe(dbLocal);
    expect(globalReady.db).toBe(dbGlobal);
    expect(localReady.db).not.toBe('/tmp/minecraft-agent.sqlite');
    expect(localReady.listening).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(globalReady.listening).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Each serve really opened its own database and its own ownership lock.
    expect(existsSync(dbLocal)).toBe(true);
    expect(existsSync(dbGlobal)).toBe(true);
    expect(existsSync(`${dbLocal}.owner.lock`)).toBe(true);
    expect(existsSync(`${dbGlobal}.owner.lock`)).toBe(true);
    expect(localReady.listening).not.toBe(globalReady.listening);

    // Both processes are serving concurrently; neither blocked the other's lock.
    expect(local.child.exitCode).toBeNull();
    expect(global.child.exitCode).toBeNull();

    await stopChild(local.child);
    await stopChild(global.child);
    // A clean shutdown releases the lock each Runtime wrote, not an unknown owner's lock.
    expect(existsSync(`${dbLocal}.owner.lock`)).toBe(false);
    expect(existsSync(`${dbGlobal}.owner.lock`)).toBe(false);
  }, 40_000);
});

describe('Round 4 — serve model-network gate is never inert', () => {
  it('rejects allowModelNetwork:true without a provider and reports a configured provider when selected', async () => {
    const dir = tempDir();
    const configPath = join(dir, 'serve.json');
    writeFileSync(configPath, JSON.stringify({ profile: 'simulated', allowModelNetwork: true }));

    // An open gate with no provider selection would silently stay on the scripted provider.
    const rejected = startServe([], ['--config', configPath, '--port', '0', '--no-pairing']);
    await expect(rejected.ready).rejects.toThrow(/model-provider-required/);
    await Promise.race([once(rejected.child, 'exit'), delay(5_000)]);
    children.delete(rejected.child);
    expect(existsSync(join(dir, 'state.sqlite'))).toBe(false);

    // With explicit provider selection the gate yields a real configured provider. No model
    // call is made; the startup document reports the factory's effective metadata.
    const db = join(dir, 'provider.sqlite');
    const configured = startServe([], [
      '--config', configPath, '--db', db, '--port', '0', '--no-pairing',
      '--provider', 'openai', '--model', 'offline-model',
      '--base-url', 'http://127.0.0.1:9/v1', '--api-key', 'round4-secret-key',
    ]);
    const ready = await configured.ready;
    expect(ready.provider).toMatchObject({
      requested: 'openai', model: 'offline-model', configured: true, networkEnabled: true, transport: 'network',
    });
    expect(ready.config).toMatchObject({ allowModelNetwork: true });
    // The key is never printed in the startup line.
    expect(configured.stdout()).not.toContain('round4-secret-key');
    await stopChild(configured.child);
  }, 40_000);
});

describe('Round 4 — failed serve startup releases the Runtime and listeners', () => {
  it('releases the ownership lock and removes signal listeners when the port is occupied', async () => {
    const dir = tempDir();
    const db = join(dir, 'state.sqlite');
    const blocker = net.createServer();
    await listen(blocker);
    const port = (blocker.address() as AddressInfo).port;
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    try {
      await expect(runServe({ db, host: '127.0.0.1', port: String(port), pairing: false }))
        .rejects.toThrow();
    } finally {
      await closeServer(blocker);
    }

    // No duplicate SIGINT/SIGTERM handlers remain from the failed attempt.
    expect(process.listenerCount('SIGINT')).toBe(beforeInt);
    expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
    // The Runtime was closed, so the lock it acquired is gone and a new owner can take over.
    expect(existsSync(`${db}.owner.lock`)).toBe(false);
    const probe = new RuntimeOwnershipLock(db);
    expect(probe.acquire()).toMatchObject({ pid: process.pid });
    expect(probe.release()).toBe(true);
  }, 30_000);
});

describe('Round 4 — default bridge command is runnable', () => {
  it('runs the default fixture bridge from the repository root', async () => {
    const result = await runCli(['bridge']);
    expect(result.code).toBe(0);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      mode: 'fixture',
      source: 'fixture',
      network: 'loopback-only',
      scenario: { byteEquality: true },
      config: { profile: 'simulated', allowMinecraftUpstream: true },
    });
    expect(result.documents[0].config.path).toMatch(/configs\/bridge-fixture\.example\.json$/);
    expect(result.stdout).not.toContain('client-offline.example.json');
  }, 30_000);
});
