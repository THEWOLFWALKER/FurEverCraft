import { describe, expect, it } from 'vitest';
import {
  createRawTcpRelay,
  type RelayConfig,
  type RelayNetwork,
  type RelayServer,
  type RelaySocket,
} from '../../src/bridge/relay/raw.js';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Listener = (...args: any[]) => void;

class FakeSocket implements RelaySocket {
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  remotePort?: number;
  private paused = false;
  private readonly handlers = new Map<string, Set<Listener>>();
  constructor(remotePort?: number) { this.remotePort = remotePort; }
  write(chunk: Buffer): boolean { if (this.destroyed) return false; this.writableLength += chunk.length; return true; }
  end(): void { this.writableEnded = true; }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.emit('close'); }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  isPaused(): boolean { return this.paused; }
  on(event: string, listener: Listener): this {
    const set = this.handlers.get(event) ?? new Set<Listener>();
    set.add(listener);
    this.handlers.set(event, set);
    return this;
  }
  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args) => { this.handlers.get(event)?.delete(wrapper); listener(...args); };
    return this.on(event, wrapper);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.handlers.get(event) ?? [])]) listener(...args);
  }
}

class FakeServer implements RelayServer {
  private errorListener?: Listener;
  once(event: 'error' | 'listening', listener: (error?: Error) => void): this {
    if (event === 'error') this.errorListener = listener;
    return this;
  }
  on(_event: 'error', _listener: (error?: Error) => void): this { return this; }
  listen(_port: number, _host: string, callback: () => void): this { callback(); return this; }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: 25565 }; }
  close(callback?: (error?: Error) => void): this { callback?.(); return this; }
}

class FakeNetwork implements RelayNetwork {
  server = new FakeServer();
  connectCalls = 0;
  readonly upstreams: FakeSocket[] = [];
  readonly clients: FakeSocket[] = [];
  private onConnection?: (socket: RelaySocket) => void;
  createServer(_options: { allowHalfOpen: boolean }, onConnection: (socket: RelaySocket) => void): RelayServer {
    this.onConnection = onConnection;
    return this.server;
  }
  connect(options: { host: string; port: number; allowHalfOpen: boolean }): RelaySocket {
    this.connectCalls += 1;
    const socket = new FakeSocket(options.port);
    this.upstreams.push(socket);
    return socket;
  }
  accept(): FakeSocket {
    const socket = new FakeSocket();
    this.clients.push(socket);
    this.onConnection?.(socket);
    return socket;
  }
}

const makeRelay = (network: FakeNetwork, overrides: Partial<RelayConfig> = {}) => createRawTcpRelay({
  listenPort: 0,
  targetHost: '127.0.0.1',
  targetPort: 25565,
  allowMinecraftUpstream: true,
  network,
  ...overrides,
});

describe('S02 relay connection quota', () => {
  it('rejects excess downstream connections before opening an upstream socket', async () => {
    const network = new FakeNetwork();
    const relay = makeRelay(network, { maxConnections: 1, maxUpstreamConnections: 1 });
    await relay.start();
    try {
      const first = network.accept();
      expect(first.destroyed).toBe(false);
      expect(network.connectCalls).toBe(1);
      expect(relay.sessions()).toHaveLength(1);

      const second = network.accept();
      expect(second.destroyed).toBe(true);
      expect(network.connectCalls).toBe(1);
      expect(relay.sessions()).toHaveLength(1);
      expect(relay.quota()).toMatchObject({
        maxConnections: 1, maxUpstreamConnections: 1, activeConnections: 1, rejectedConnections: 1,
      });
    } finally {
      await relay.stop();
    }
  });

  it('enforces the upstream quota independently and restores it after close', async () => {
    const network = new FakeNetwork();
    const relay = makeRelay(network, { maxConnections: 4, maxUpstreamConnections: 1 });
    await relay.start();
    try {
      network.accept();
      const rejected = network.accept();
      expect(rejected.destroyed).toBe(true);
      expect(network.connectCalls).toBe(1);
      expect(relay.quota().rejectedConnections).toBe(1);

      await relay.sessions()[0]!.close();
      network.accept();
      expect(network.connectCalls).toBe(2);
      expect(relay.quota()).toMatchObject({ activeConnections: 1, rejectedConnections: 1 });
    } finally {
      await relay.stop();
    }
  });

  it('arms the half-close timer when the client EOFs before the upstream connects', async () => {
    const network = new FakeNetwork();
    const relay = makeRelay(network, { budgets: { halfCloseMs: 40, closeFlushMs: 10, connectTimeoutMs: 10_000 } });
    await relay.start();
    try {
      const client = network.accept();
      expect(network.upstreams).toHaveLength(1);
      // Upstream has not emitted 'connect' and will never end.
      client.emit('end');
      await sleep(15);
      expect(relay.sessions()).toHaveLength(1);
      await sleep(80);
      expect(relay.sessions()).toHaveLength(0);
      expect(relay.quota().activeConnections).toBe(0);
    } finally {
      await relay.stop();
    }
  });

  it('passes the per-connection epoch to the tap and reports session close exactly once', async () => {
    const network = new FakeNetwork();
    const taps: Array<{ direction: string; bytes: number; epoch: string }> = [];
    const closed: string[] = [];
    const relay = makeRelay(network, {
      onChunk: (direction: string, chunk: Buffer, epoch: string) => taps.push({ direction, bytes: chunk.length, epoch }),
      onSessionClose: (epoch: string) => closed.push(epoch),
    });
    await relay.start();
    try {
      const first = network.accept();
      const second = network.accept();
      first.emit('data', Buffer.from([1, 2]));
      second.emit('data', Buffer.from([3]));
      const epochs = relay.sessions().map(session => session.sessionEpoch);
      expect(new Set(taps.map(tap => tap.epoch))).toEqual(new Set(epochs));
      expect(taps.map(tap => tap.direction)).toEqual(['client-to-server', 'client-to-server']);

      const closing = relay.sessions()[0]!.sessionEpoch;
      await relay.sessions()[0]!.close();
      expect(closed).toEqual([closing]);
    } finally {
      await relay.stop();
    }
  });
});
