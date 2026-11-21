import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { ProcessSupervisor } from '../../src/bridge/supervisor.js';
import { spawnBridgeServiceProcess } from '../../src/bridge/service/spawn.js';
import type { BridgeServiceEntryConfig } from '../../src/bridge/service/entry.js';

const entryUrl = new URL('../../dist/bridge/service/entry.js', import.meta.url);
const built = existsSync(fileURLToPath(entryUrl));

const peer = (port: number) => new Promise<net.Socket>(resolve => { const socket = net.createConnection(port, '127.0.0.1', () => resolve(socket)); });

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

type ServiceStatus = { state: string; relay: { state: string }; observer: unknown };

async function waitForServiceRunning(supervisor: ProcessSupervisor): Promise<ServiceStatus> {
  let last: ServiceStatus | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await supervisor.request<ServiceStatus>('status').catch(() => undefined);
    if (last?.state === 'running') return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`service-not-running:${last?.state ?? 'unknown'}`);
}

function configFor(listenPort: number, targetPort: number): BridgeServiceEntryConfig {
  return {
    relay: {
      listenHost: '127.0.0.1', listenPort, targetHost: '127.0.0.1', targetPort,
      allowMinecraftUpstream: true, heartbeatMs: 40,
    },
    observer: { enabled: true },
    shutdownGraceMs: 1_000,
    helloTimeoutMs: 5_000,
    maxRestarts: 1,
    backoffBaseMs: 10,
  };
}

describe('P09 bridge service child process', () => {  it.skipIf(!built)('forks the service, forwards through the relay child, observes metadata and shuts down', async () => {
    const upstream = net.createServer(socket => socket.on('data', chunk => socket.write(chunk)));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
    const targetPort = (upstream.address() as net.AddressInfo).port;
    const listenPort = await freePort();
    const supervisor = new ProcessSupervisor({
      spawn: () => spawnBridgeServiceProcess(configFor(listenPort, targetPort), { entryUrl }),
      ipcTimeoutMs: 6_000,
    });
    try {
      const observed: unknown[] = [];
      supervisor.onMessage(message => {
        const value = message as { type?: string };
        if (value.type === 'observer-event') observed.push(message);
      });
      await supervisor.start();
      expect(await supervisor.waitForHello(6_000)).toMatch(/^bridge_/);
      const status = await waitForServiceRunning(supervisor);
      expect(status.state).toBe('running');
      expect(status.relay.state).toMatch(/starting|running/);

      const client = await peer(listenPort);
      const reply = new Promise<Buffer>(resolve => { client.once('data', chunk => resolve(Buffer.from(chunk))); });
      // A complete frame, so the same bytes also produce an observer frame-metadata event.
      const frame = Buffer.from([5, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
      client.write(frame);
      expect(await reply).toEqual(frame);
      for (let index = 0; index < 100 && observed.length === 0; index += 1) await new Promise(resolve => setTimeout(resolve, 20));
      expect(observed.length).toBeGreaterThan(0);
      const event = observed[0] as { event?: { kind?: string; payload?: { kind?: string } } };
      expect(event.event?.kind).toBe('observation');
      expect(event.event?.payload?.kind).toBe('frame-metadata');
      client.destroy();

      const shutdown = await supervisor.request<{ stopped: boolean }>('shutdown');
      expect(shutdown.stopped).toBe(true);
      await supervisor.stop();
      expect(supervisor.state).toBe('stopped');
    } finally {
      await supervisor.stop().catch(() => undefined);
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 30_000);

  it.skipIf(!built)('propagates an unexpected service-child exit to the supervisor', async () => {
    const upstream = net.createServer(socket => socket.on('data', () => undefined));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
    const targetPort = (upstream.address() as net.AddressInfo).port;
    const listenPort = await freePort();
    const supervisor = new ProcessSupervisor({
      spawn: () => spawnBridgeServiceProcess(configFor(listenPort, targetPort), { entryUrl }),
      ipcTimeoutMs: 6_000,
    });
    try {
      await supervisor.start();
      await supervisor.waitForHello(6_000);
      const pid = supervisor.pid;
      expect(pid).toBeGreaterThan(0);
      process.kill(pid!, 'SIGKILL');
      for (let index = 0; index < 150 && supervisor.state !== 'failed'; index += 1) await new Promise(resolve => setTimeout(resolve, 20));
      expect(supervisor.state).toBe('failed');
      expect(supervisor.lastExitReason).toBe('unexpected-exit');
    } finally {
      await supervisor.stop().catch(() => undefined);
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 30_000);
});
