import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { SystemClock } from '../../src/contracts/index.js';
import { ProcessSupervisor } from '../../src/bridge/supervisor.js';
import { spawnRelayProcess } from '../../src/bridge/relay/spawn.js';
import { spawnBridgeServiceProcess } from '../../src/bridge/service/spawn.js';
import { BridgeService } from '../../src/bridge/service/orchestrator.js';
import type { BridgeServiceEntryConfig } from '../../src/bridge/service/entry.js';
import { ScriptedModelProvider } from '../../src/providers/scripted/index.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { createRuntime } from '../../src/execution/factory.js';

const relayEntry = new URL('../../dist/bridge/relay/entry.js', import.meta.url);
const serviceEntry = new URL('../../dist/bridge/service/entry.js', import.meta.url);
const built = existsSync(fileURLToPath(relayEntry)) && existsSync(fileURLToPath(serviceEntry));

const listen = (server: net.Server) => new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve());
});
const closeServer = (server: net.Server) => new Promise<void>(resolve => server.close(() => resolve()));
const freePort = async () => {
  const server = net.createServer();
  await listen(server);
  const port = (server.address() as net.AddressInfo).port;
  await closeServer(server);
  return port;
};
const peer = (port: number) => new Promise<net.Socket>(resolve => {
  const socket = net.createConnection(port, '127.0.0.1', () => resolve(socket));
});
const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const waitFor = async (predicate: () => boolean, timeoutMs: number, label: string) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timeout:${label}`);
};
const echo = async (port: number, payload: Buffer) => {
  const client = await peer(port);
  try {
    const reply = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      client.on('data', chunk => {
        chunks.push(Buffer.from(chunk));
        if (Buffer.concat(chunks).length >= payload.length) resolve(Buffer.concat(chunks));
      });
      client.once('error', reject);
    });
    client.write(payload);
    return await reply;
  } finally {
    client.destroy();
  }
};

function serviceConfig(listenPort: number, targetPort: number): BridgeServiceEntryConfig {
  return {
    relay: { listenHost: '127.0.0.1', listenPort, targetHost: '127.0.0.1', targetPort, allowMinecraftUpstream: true, heartbeatMs: 40 },
    observer: { enabled: true },
    shutdownGraceMs: 1_000,
    helloTimeoutMs: 4_000,
    maxRestarts: 1,
    backoffBaseMs: 5,
  };
}

describe('P23 real child-process faults', () => {
  it.skipIf(!built)('kills the relay child, revokes control, restarts within budget and shuts down cleanly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-p23-relay-'));
    const upstream = net.createServer(socket => socket.on('data', chunk => socket.write(chunk)));
    await listen(upstream);
    const targetPort = (upstream.address() as net.AddressInfo).port;
    const supervisor = new ProcessSupervisor({
      spawn: () => spawnRelayProcess(
        { listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort, allowMinecraftUpstream: true, heartbeatMs: 40 },
        { entryUrl: relayEntry, cwd: dir },
      ),
      ipcTimeoutMs: 4_000,
    });
    const fatal: string[] = [];
    const service = new BridgeService({
      relay: supervisor,
      maxRestarts: 2,
      restartWindowMs: 60_000,
      backoffBaseMs: 5,
      backoffMaxMs: 10,
      helloTimeoutMs: 4_000,
      onFatal: reason => fatal.push(reason),
    });
    const pids: number[] = [];
    try {
      await service.start();
      service.armControl('fresh-observation');
      expect(service.status()).toMatchObject({ admissionOpen: true, controlRevoked: false });

      for (const attempt of [1, 2]) {
        const pid = supervisor.pid!;
        pids.push(pid);
        process.kill(pid, 'SIGKILL');
        await waitFor(() => service.state === 'running' && supervisor.pid !== undefined && supervisor.pid !== pid, 5_000, `relay-restart-${attempt}`);
        // Killing the relay revokes control and a restart is not fresh evidence: no silent re-arm.
        expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true, restarts: { attempts: attempt, max: 2 } });
        const status = await supervisor.request<{ address?: { port?: number } }>('status');
        const port = status?.address?.port;
        expect(typeof port).toBe('number');
        // Forwarding resumes; the fault is confined to control/observation.
        const payload = Buffer.from(`relay-after-crash-${attempt}`);
        expect(await echo(port!, payload)).toEqual(payload);
      }

      // A third unexpected exit exceeds the two-restart budget instead of looping forever.
      const pid = supervisor.pid!;
      pids.push(pid);
      process.kill(pid, 'SIGKILL');
      await waitFor(() => service.state === 'failed', 5_000, 'restart-budget');
      expect(fatal).toContain('restart-budget-exhausted');
      expect(service.controlRevoked).toBe(true);

      await service.stop('test-quit');
      expect(service.state).toBe('stopped');
      for (const exited of pids) await waitFor(() => !isAlive(exited), 3_000, `child-exit-${exited}`);
    } finally {
      await service.stop('test-cleanup').catch(() => undefined);
      await closeServer(upstream);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(!built)('propagates an unexpected service-child exit to its supervisor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-p23-service-'));
    const upstream = net.createServer(socket => socket.on('data', chunk => socket.write(chunk)));
    await listen(upstream);
    const targetPort = (upstream.address() as net.AddressInfo).port;
    const supervisor = new ProcessSupervisor({
      spawn: () => spawnBridgeServiceProcess(serviceConfig(0, targetPort), { entryUrl: serviceEntry, cwd: dir }),
      ipcTimeoutMs: 5_000,
    });
    let pid: number | undefined;
    let relayPid: number | undefined;
    try {
      await supervisor.start();
      expect(await supervisor.waitForHello(5_000)).toMatch(/^bridge_/);
      pid = supervisor.pid;
      expect(pid).toBeGreaterThan(0);
      // Capture the relay grandchild so its exit-on-parent-loss can be verified.
      const readyBy = Date.now() + 5_000;
      while (Date.now() < readyBy) {
        const status = await supervisor.request<{ relay?: { pid?: number } }>('status').catch(() => undefined);
        relayPid = status?.relay?.pid;
        if (relayPid !== undefined) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(relayPid).toBeGreaterThan(0);
      process.kill(pid!, 'SIGKILL');
      await waitFor(() => supervisor.state === 'failed', 5_000, 'service-exit');
      expect(supervisor.lastExitReason).toBe('unexpected-exit');
      // The relay child must not be orphaned when its owning service dies abruptly.
      await waitFor(() => !isAlive(relayPid!), 5_000, 'relay-grandchild-exit');
      await supervisor.stop();
      expect(supervisor.state).toBe('stopped');
      await waitFor(() => !isAlive(pid!), 3_000, 'service-child-exit');
    } finally {
      await supervisor.stop().catch(() => undefined);
      if (pid !== undefined) { await waitFor(() => !isAlive(pid!), 3_000, 'service-cleanup').catch(() => undefined); }
      if (relayPid !== undefined) { await waitFor(() => !isAlive(relayPid!), 3_000, 'relay-cleanup').catch(() => undefined); }
      await closeServer(upstream);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it.skipIf(!built)('runs a short wall-clock service smoke with real timers and clean shutdown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-p23-smoke-'));
    const upstream = net.createServer(socket => socket.on('data', chunk => socket.write(chunk)));
    await listen(upstream);
    const targetPort = (upstream.address() as net.AddressInfo).port;
    // Tiny heartbeat/backoff only; no artificial sleeps pad the duration.
    const listenPort = await freePort();
    const config = { ...serviceConfig(listenPort, targetPort), relay: { ...serviceConfig(listenPort, targetPort).relay, heartbeatMs: 20 } };
    const supervisor = new ProcessSupervisor({
      spawn: () => spawnBridgeServiceProcess(config, { entryUrl: serviceEntry, cwd: dir }),
      ipcTimeoutMs: 5_000,
    });
    const started = Date.now();
    let pid: number | undefined;
    let relayPid: number | undefined;
    try {
      await supervisor.start();
      expect(await supervisor.waitForHello(5_000)).toMatch(/^bridge_/);
      pid = supervisor.pid;
      let status: { state?: string; relay?: { state?: string; pid?: number } } | undefined;
      const readyBy = Date.now() + 5_000;
      while (Date.now() < readyBy) {
        status = await supervisor.request<{ state?: string; relay?: { state?: string; pid?: number } }>('status').catch(() => undefined);
        if (status?.state === 'running') { relayPid = status.relay?.pid; break; }
        // Wait for IPC state changes; this is polling, not padding the measured duration.
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(status?.state).toBe('running');
      expect(relayPid).toBeGreaterThan(0);

      const payload = Buffer.from('wall-clock-smoke');
      expect(await echo(listenPort, payload)).toEqual(payload);

      const shutdown = await supervisor.request<{ stopped: boolean }>('shutdown');
      expect(shutdown.stopped).toBe(true);
      await supervisor.stop();
      expect(supervisor.state).toBe('stopped');
      expect(Date.now() - started).toBeLessThan(10_000);
      await waitFor(() => !isAlive(pid!), 3_000, 'smoke-child-exit');
      await waitFor(() => !isAlive(relayPid!), 3_000, 'smoke-relay-exit');
    } finally {
      await supervisor.stop().catch(() => undefined);
      if (pid !== undefined) { await waitFor(() => !isAlive(pid!), 3_000, 'smoke-cleanup').catch(() => undefined); }
      if (relayPid !== undefined) { await waitFor(() => !isAlive(relayPid!), 3_000, 'smoke-relay-cleanup').catch(() => undefined); }
      await closeServer(upstream);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('runs the runtime scheduler and shutdown on the real clock without virtual-time padding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-p23-runtime-'));
    const runtime = createRuntime({
      db: join(dir, 'runtime.sqlite'),
      clock: new SystemClock(),
      bridge: new FakeClientBridge(),
      provider: new ScriptedModelProvider([{ text: 'smoke ok', stopReason: 'end_turn' }]),
    });
    const started = Date.now();
    try {
      runtime.session.start();
      const woke = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { unsubscribe(); reject(new Error('scheduler-wake-timeout')); }, 2_000);
        const unsubscribe = runtime.session.events.subscribe(event => {
          if (event.kind === 'scheduler.woke') { clearTimeout(timer); unsubscribe(); resolve(); }
        });
      });
      const goal = await runtime.control.command({ requestId: 'wallclock-goal', command: 'goal.set', payload: { goalId: 'g-wallclock', text: 'wall clock smoke' } });
      expect(goal.state).toBe('terminal');
      await woke;
      const quit = await runtime.control.command({ requestId: 'wallclock-quit', command: 'quit', payload: {} });
      expect(quit.state).toBe('accepted');
      expect(runtime.control.status().closed).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
