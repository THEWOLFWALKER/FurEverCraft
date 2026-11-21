import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnRelayProcess } from '../../src/bridge/relay/spawn.js';
import { ProcessSupervisor } from '../../src/bridge/supervisor.js';
import net from 'node:net';

const entryUrl = new URL('../../dist/bridge/relay/entry.js', import.meta.url);
// The forked child runs compiled JS; this integration test requires a prior build.
const built = existsSync(fileURLToPath(entryUrl));

/**
 * Real child_process fork of the relay entry against a loopback echo target. No Minecraft
 * engine is involved: this proves process separation, hello/session epoch, request correlation
 * and byte forwarding of the supervised relay, not live-server compatibility.
 */
const peer = (port: number) => new Promise<net.Socket>(resolve => { const socket = net.createConnection(port, '127.0.0.1', () => resolve(socket)); });

describe('B06 supervised relay child', () => {
  it.skipIf(!built)('forks the relay, correlates status, forwards bytes and stops cleanly', async () => {
    const upstream = net.createServer(socket => socket.on('data', chunk => socket.write(chunk)));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
    const targetPort = (upstream.address() as net.AddressInfo).port;
    const supervisor = new ProcessSupervisor({
      spawn: () => spawnRelayProcess({ listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort, allowMinecraftUpstream: true, heartbeatMs: 50 }, { entryUrl: new URL('../../dist/bridge/relay/entry.js', import.meta.url) }),
      ipcTimeoutMs: 4_000,
    });
    try {
      await supervisor.start();
      const epoch = await supervisor.waitForHello(4_000);
      expect(epoch).toMatch(/^relay_session_/);
      const relayPort = await waitForRelayPort(supervisor);
      const client = await peer(relayPort);
      const reply = new Promise<Buffer>(resolve => { client.once('data', chunk => resolve(Buffer.from(chunk))); });
      client.write(Buffer.from('supervised-relay'));
      expect((await reply).toString()).toBe('supervised-relay');
      client.destroy();
      await supervisor.stop();
      expect(supervisor.state).toBe('stopped');
    } finally {
      await supervisor.stop().catch(() => undefined);
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }, 20_000);
});

async function waitForRelayPort(supervisor: ProcessSupervisor): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const status = await supervisor.request<{ address?: { port?: number } }>('status').catch(() => undefined);
    const port = status?.address?.port;
    if (typeof port === 'number' && port > 0) return port;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('relay-port-unavailable');
}
