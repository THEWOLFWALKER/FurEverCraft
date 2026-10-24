import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { createRawTcpRelay } from '../../src/bridge/relay/raw.js';
import {
  RelayObserverSupervisor,
  createRelayObserverPublisher,
  type RelayObserverHost,
  type RelayObserverHostFactory,
} from '../../src/bridge/relay/entry.js';
import { ObserverWorkerHost, type WorkerLike } from '../../src/bridge/observer/host.js';
import { createBoundedObserver, type ObserverDirection, type ObserverEvent } from '../../src/bridge/observer/bounded.js';
import { BridgeService, type ObserverMonitor } from '../../src/bridge/service/orchestrator.js';
import { runBridgeServiceEntry, serviceCommandReply, type BridgeServiceEntryConfig } from '../../src/bridge/service/entry.js';
import { ProcessSupervisor, type ChildProcessLike } from '../../src/bridge/supervisor.js';
import { IpcRequestSchema, type IpcRequest } from '../../src/bridge/ipc/protocol.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

afterEach(() => {
  vi.useRealTimers();
});

const frame = (body: Buffer) => Buffer.concat([Buffer.from([body.length]), body]);

const observation = (frameSequence: string, direction: ObserverDirection = 'client-to-server'): ObserverEvent => ({
  kind: 'observation', source: 'client', sessionEpoch: 'observer_synthetic', direction, frameSequence,
  phase: 'UNKNOWN', compression: 'unknown', availability: 'degraded',
  payload: { kind: 'frame-metadata', bytes: 2, payloadBytes: 1, offsetStart: '0', offsetEnd: '2', compressed: false },
});

const request = (command: string, sessionEpoch = 'epoch'): IpcRequest => IpcRequestSchema.parse({
  type: 'request', protocolVersion: 1, requestId: `request-${command}`, sessionEpoch, command, payload: {},
});

class FakeWorker implements WorkerLike {
  readonly posted: unknown[] = [];
  terminated = false;
  private readonly handlers = new Map<string, Set<(value?: unknown) => void>>();
  postMessage(value: unknown) { this.posted.push(value); }
  on(event: 'message' | 'error' | 'exit', listener: (value?: unknown) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(listener); this.handlers.set(event, set); return this; }
  emit(event: 'message' | 'error' | 'exit', value?: unknown) { for (const listener of this.handlers.get(event) ?? []) listener(value); }
  async terminate() { this.terminated = true; return 0; }
}

type FakeHostRecord = {
  options: Parameters<RelayObserverHostFactory>[0];
  host: RelayObserverHost;
  attached: Buffer[];
  frames: number;
  stopped: boolean;
  parked: boolean;
  emit: (event: ObserverEvent) => void;
};

/** A host factory that records per-session isolation without spawning real workers. */
function fakeHostFactory() {
  const records: FakeHostRecord[] = [];
  const createHost: RelayObserverHostFactory = options => {
    let sequence = 0;
    const record: FakeHostRecord = {
      options, attached: [], frames: 0, stopped: false, parked: false,
      emit: event => options.onEvent(event),
      host: undefined as unknown as RelayObserverHost,
    };
    record.host = {
      sessionEpoch: `observer_host_test_${records.length + 1}`,
      start: () => undefined,
      attach: (direction, bytes) => {
        if (record.stopped || record.parked) return false;
        record.attached.push(Buffer.from(bytes));
        record.frames += 1;
        sequence += 1;
        options.onEvent(observation(String(sequence), direction));
        return true;
      },
      state: () => ({ running: !record.stopped, availability: record.stopped || record.parked ? 'unknown' : 'degraded', frameSequence: String(record.frames) }),
      stop: async () => { record.stopped = true; },
    };
    records.push(record);
    return record.host;
  };
  return { records, createHost };
}

const peer = (port: number) => new Promise<net.Socket>(resolve => {
  const socket = net.createConnection(port, '127.0.0.1', () => resolve(socket));
});
const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timeout:${label}`);
};

describe('Round 5 — observer state is per TCP session', () => {
  it('isolates two concurrent and a later sequential loopback session (epochs, frames, reset)', async () => {
    const upstream = net.createServer(socket => socket.on('data', () => undefined));
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
    const targetPort = (upstream.address() as net.AddressInfo).port;
    const sent: Array<Record<string, any>> = [];
    const ipc = { send: (message: unknown) => { sent.push(message as Record<string, any>); return false; } };
    const factory = fakeHostFactory();
    const manager = new RelayObserverSupervisor(ipc, 'relay_entry_epoch', { enabled: true, createHost: factory.createHost });
    const relay = createRawTcpRelay({
      listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort,
      allowMinecraftUpstream: true,
      onChunk: (direction, chunk, session) => { manager.attach(session.sessionEpoch, direction, chunk); },
    });
    relay.onSession(session => {
      manager.bindSession(session.sessionEpoch);
      session.onClose(() => manager.closeSession(session.sessionEpoch));
    });
    const clients: net.Socket[] = [];
    try {
      await relay.start();

      // Two concurrent sessions.
      const first = await peer(relay.address.port);
      const second = await peer(relay.address.port);
      clients.push(first, second);
      const firstPayload = Buffer.from('session-one');
      const secondPayload = Buffer.from('session-two');
      first.write(firstPayload);
      second.write(secondPayload);
      await waitFor(() => manager.state().sessions.length === 2 && factory.records.length === 2, 'two-concurrent-hosts');
      await waitFor(() => sent.filter(message => message.payload?.kind === 'observation').length >= 2, 'two-concurrent-observations');

      const sessions = manager.state().sessions.map(session => session.relaySessionEpoch);
      expect(new Set(sessions).size).toBe(2);
      expect(new Set(factory.records.map(record => record.host.sessionEpoch)).size).toBe(2);
      // Each session's decoder only ever saw its own bytes; no cross-session frames.
      const byEpoch = new Map(sessions.map((epoch, index) => [epoch, factory.records[index]!]));
      for (const session of manager.state().sessions) {
        const record = byEpoch.get(session.relaySessionEpoch)!;
        expect(record.frames).toBeGreaterThan(0);
      }
      const attachedPayloads = factory.records.map(record => Buffer.concat(record.attached).toString());
      expect(attachedPayloads.sort()).toEqual([firstPayload.toString(), secondPayload.toString()].sort());
      // Every observation carries the owning relay session identity.
      const observations = sent.filter(message => message.payload?.kind === 'observation');
      expect(observations.length).toBeGreaterThanOrEqual(2);
      const firstPerSession = new Map<string, Record<string, any>>();
      for (const message of observations) {
        expect(sessions).toContain(message.payload.relaySessionEpoch);
        expect(message.relaySessionEpoch).toBe(message.payload.relaySessionEpoch);
        if (!firstPerSession.has(message.payload.relaySessionEpoch)) firstPerSession.set(message.payload.relaySessionEpoch, message);
      }
      expect(firstPerSession.size).toBe(2);
      for (const message of firstPerSession.values()) expect(message.payload.frameSequence).toBe('1');

      // Close both concurrent sessions; their observer state must be discarded.
      first.destroy();
      second.destroy();
      await waitFor(() => manager.state().sessions.length === 0, 'concurrent-sessions-closed');
      await waitFor(() => factory.records.every(record => record.stopped), 'concurrent-hosts-stopped');

      // A sequential third session gets a brand-new host and frame sequence.
      const third = await peer(relay.address.port);
      clients.push(third);
      third.write(Buffer.from('session-three'));
      await waitFor(() => factory.records.length === 3 && manager.state().sessions.length === 1, 'sequential-host');
      const thirdSession = manager.state().sessions[0]!;
      expect(sessions).not.toContain(thirdSession.relaySessionEpoch);
      expect(factory.records[2]!.host.sessionEpoch).not.toBe(factory.records[0]!.host.sessionEpoch);
      await waitFor(() => sent.filter(message => message.payload?.kind === 'observation' && message.payload.relaySessionEpoch === thirdSession.relaySessionEpoch).length > 0, 'sequential-observation');
      const sequential = sent.find(message => message.payload?.kind === 'observation' && message.payload.relaySessionEpoch === thirdSession.relaySessionEpoch)!;
      // Fresh framing state: the first observed frame is sequence 1, not a continuation.
      expect(sequential.payload.frameSequence).toBe('1');
      expect(Buffer.concat(factory.records[2]!.attached).toString()).toBe('session-three');
    } finally {
      for (const client of clients) client.destroy();
      await relay.stop();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it('gives a recovered observer a fresh host and epoch after attach backpressure', async () => {
    const sent: Array<Record<string, any>> = [];
    const ipc = { send: (message: unknown) => { sent.push(message as Record<string, any>); return false; } };
    const workers: FakeWorker[] = [];
    const factory: RelayObserverHostFactory = options => new ObserverWorkerHost({
      createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
      onEvent: options.onEvent,
      onFailure: options.onFailure,
      maxUnackedFrames: 1,
    });
    const manager = new RelayObserverSupervisor(ipc, 'relay_entry_epoch', { enabled: true, createHost: factory });
    try {
      manager.bindSession('relay_session_1');
      expect(manager.attach('relay_session_1', 'client-to-server', new Uint8Array([1]))).toBe(true);
      // Second unacked chunk stops the direction and emits a global gap.
      expect(manager.attach('relay_session_1', 'client-to-server', new Uint8Array([2]))).toBe(false);
      expect(sent.some(message => message.payload?.gap?.reason === 'observer-attach-backpressure')).toBe(true);
      const before = manager.observerEpoch;
      const observerBefore = manager.state().sessions[0]!.observerEpoch;
      expect(manager.state().availability).toBe('unknown');

      const recovered = await manager.startObservation();
      expect(recovered).toMatchObject({ supported: true, recovered: true, reset: 'all-directions' });
      expect(manager.observerEpoch).not.toBe(before);
      expect(manager.state().sessions[0]!.relaySessionEpoch).toBe('relay_session_1');
      expect(manager.state().sessions[0]!.observerEpoch).not.toBe(observerBefore);
      // The fresh host accepts bytes again and emitted events carry the new epoch.
      expect(manager.attach('relay_session_1', 'client-to-server', new Uint8Array([3]))).toBe(true);
      workers.at(-1)!.emit('message', {
        type: 'event',
        event: { ...observation('1'), sessionEpoch: 'observer_recovered' },
      });
      await tick();
      const latest = sent.filter(message => message.payload?.kind === 'observation').at(-1)!;
      expect(latest.payload).toMatchObject({ frameSequence: '1', relaySessionEpoch: 'relay_session_1', sessionEpoch: 'observer_recovered' });
      expect(latest.payload.relaySessionEpoch).toBe('relay_session_1');
    } finally {
      await manager.stop();
    }
  });

  it('recovers from an ack timeout with a new epoch and observations resume', async () => {
    vi.useFakeTimers();
    const sent: Array<Record<string, any>> = [];
    const ipc = { send: (message: unknown) => { sent.push(message as Record<string, any>); return false; } };
    const workers: FakeWorker[] = [];
    const factory: RelayObserverHostFactory = options => new ObserverWorkerHost({
      createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; },
      onEvent: options.onEvent,
      onFailure: options.onFailure,
      ackTimeoutMs: 20,
    });
    const manager = new RelayObserverSupervisor(ipc, 'relay_entry_epoch', { enabled: true, createHost: factory });
    try {
      manager.bindSession('relay_session_ack');
      expect(manager.attach('relay_session_ack', 'client-to-server', new Uint8Array([1]))).toBe(true);
      await vi.advanceTimersByTimeAsync(20);
      expect(workers[0]!.terminated).toBe(true);
      expect(sent.some(message => message.payload?.gap?.reason === 'observer-ack-timeout')).toBe(true);
      const before = manager.observerEpoch;

      await manager.startObservation();
      expect(manager.observerEpoch).not.toBe(before);
      expect(manager.attach('relay_session_ack', 'client-to-server', new Uint8Array([2]))).toBe(true);
      expect(workers.length).toBe(2);
      workers[1]!.emit('message', { type: 'ack', direction: 'client-to-server', bytes: 1, frames: 1 });
      await vi.advanceTimersByTimeAsync(50);
      expect(workers[1]!.terminated).toBe(false);
      workers[1]!.emit('message', { type: 'event', event: { ...observation('1'), sessionEpoch: 'observer_after_recovery' } });
      expect(sent.filter(message => message.payload?.kind === 'observation').at(-1)!.payload).toMatchObject({
        relaySessionEpoch: 'relay_session_ack', sessionEpoch: 'observer_after_recovery',
      });
    } finally {
      await manager.stop();
    }
  });

  it('reports observer commands as unsupported when observation is disabled', async () => {
    const manager = new RelayObserverSupervisor({ send: () => true }, 'relay_entry_epoch', { enabled: false });
    const result = await manager.startObservation();
    expect(result).toMatchObject({ supported: false, recovered: false });
    expect(manager.attach('relay_session_1', 'client-to-server', new Uint8Array([1]))).toBe(false);
  });
});

describe('Round 5 — IPC channel contract (false means queued)', () => {
  it('relay publisher treats false as queued exactly once and reports no false gap', () => {
    const delivered: Array<Record<string, any>> = [];
    const publisher = createRelayObserverPublisher(
      { send: message => { delivered.push(message as Record<string, any>); return false; } },
      'relay_entry_epoch',
      'relay_session_queued',
    );
    publisher.event(observation('1'));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      relaySessionEpoch: 'relay_session_queued',
      payload: { kind: 'observation', frameSequence: '1', relaySessionEpoch: 'relay_session_queued' },
    });
    expect(publisher.pending()).toBeUndefined();
    publisher.event(observation('2'));
    expect(delivered).toHaveLength(2);
    expect(delivered.some(message => message.payload?.kind === 'observer_gap')).toBe(false);
  });

  it('supervisor does not reject a request because send() returned false; one request is sent', async () => {
    class QueueingChild implements ChildProcessLike {
      readonly pid = 999;
      readonly sent: unknown[] = [];
      private readonly handlers = new Map<string, Set<(value?: unknown) => void>>();
      send(message: unknown) { this.sent.push(message); return false; }
      on(event: 'message' | 'exit' | 'error', listener: (value?: unknown) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(listener); this.handlers.set(event, set); return this; }
      kill() { return true; }
      emit(event: 'message' | 'exit' | 'error', value?: unknown) { for (const listener of this.handlers.get(event) ?? []) listener(value); }
    }
    const child = new QueueingChild();
    const supervisor = new ProcessSupervisor({ spawn: () => child, ipcTimeoutMs: 200 });
    try {
      await supervisor.start();
      child.emit('message', { type: 'hello', protocolVersion: 1, process: 'relay', sessionEpoch: 'child-epoch', bootEpoch: 'boot', capabilities: [] });
      await tick();
      const pending = supervisor.request<{ sessions: number }>('status');
      await tick();
      const requests = child.sent.filter(message => (message as { type?: string }).type === 'request');
      expect(requests).toHaveLength(1);
      const sentRequest = requests[0] as { requestId: string };
      child.emit('message', { type: 'response', protocolVersion: 1, requestId: sentRequest.requestId, sessionEpoch: 'child-epoch', ok: true, result: { sessions: 0 } });
      await expect(pending).resolves.toEqual({ sessions: 0 });
      expect(child.sent.filter(message => (message as { type?: string }).type === 'request')).toHaveLength(1);
    } finally {
      await supervisor.stop();
    }
  });

  it('service does not report overflow/backpressure for a false/queued channel and delivers once', () => {
    const delivered: unknown[] = [];
    const events: string[] = [];
    const service = new BridgeService({
      ipc: { send: message => { delivered.push(message); return false; } },
      maxIpcMessages: 1,
    });
    service.on(event => events.push(event.type));
    return service.start().then(async () => {
      expect(service.status().ipc).toMatchObject({ globalUnknown: false, backpressured: false });
      service.publishObserver(observation('1'));
      service.publishObserver(observation('2'));
      expect(delivered.filter(message => (message as { type?: string }).type === 'observer-event')).toHaveLength(2);
      expect(events.filter(type => type === 'ipc-overflow')).toHaveLength(0);
      expect(service.status().ipc).toMatchObject({ globalUnknown: false, backpressured: false });
      await service.stop();
    });
  });
});

describe('Round 5 — arm is refused during an active IPC episode', () => {
  it('refuses arm while global unknown and revokes again for a later drop after recovery', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const sent: unknown[] = [];
    const service = new BridgeService({
      ipc: { send: message => { if (mode === 'fail') throw new Error('channel-unavailable'); sent.push(message); return true; } },
      maxIpcMessages: 1,
    });
    const events: string[] = [];
    service.on(event => events.push(event.type));
    try {
      await service.start();
      expect(service.armControl('initial')).toBe(true);
      expect(service.status().admissionOpen).toBe(true);

      mode = 'fail';
      service.publishObserver(observation('1')); // fills the single slot; flush fails
      service.publishObserver(observation('2')); // drop in the same episode
      expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true, ipc: { globalUnknown: true, backpressured: true } });
      expect(events.filter(type => type === 'ipc-overflow')).toHaveLength(1);

      // Re-arming must not reopen admission while the channel is still failing.
      expect(service.armControl('during-episode')).toBe(false);
      expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true });
      const refused = serviceCommandReply(request('arm'), { sessionEpoch: 'epoch', service });
      expect(refused).toMatchObject({ kind: 'reply', ok: false, error: { code: 'control-arm-refused' } });

      // Successful drain ends the episode; arm is allowed again.
      mode = 'ok';
      service.flush();
      expect(service.status().ipc).toMatchObject({ globalUnknown: false, backpressured: false });
      expect(service.armControl('after-recovery')).toBe(true);
      expect(service.status().admissionOpen).toBe(true);

      // A later drop is a new episode and revokes admission again.
      mode = 'fail';
      service.publishObserver(observation('3'));
      service.publishObserver(observation('4'));
      expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true, ipc: { globalUnknown: true } });
      expect(events.filter(type => type === 'ipc-overflow')).toHaveLength(2);
    } finally {
      mode = 'ok';
      service.flush();
      await service.stop();
    }
  });
});

describe('Round 5 — stopped directions stop producing observations', () => {
  it('drops worker observations and gaps for a direction stopped by attach backpressure', () => {
    const worker = new FakeWorker();
    const events: ObserverEvent[] = [];
    const host = new ObserverWorkerHost({
      createWorker: () => worker,
      onEvent: event => events.push(event),
      maxUnackedFrames: 1,
    });
    host.start();
    expect(host.attach('client-to-server', new Uint8Array([1]))).toBe(true);
    expect(host.attach('client-to-server', new Uint8Array([2]))).toBe(false);
    const stopEvents = events.length;
    // Late worker traffic for the stopped direction must not be forwarded...
    worker.emit('message', { type: 'event', event: observation('9', 'client-to-server') });
    worker.emit('message', {
      type: 'event',
      event: { kind: 'observer_gap', source: 'client', sessionEpoch: 's', gap: { scope: 'domain', reason: 'late-gap', direction: 'client-to-server' } },
    });
    expect(events).toHaveLength(stopEvents);
    // ...while the other direction still reports normally.
    worker.emit('message', { type: 'event', event: observation('1', 'server-to-client') });
    expect(events.at(-1)).toMatchObject({ kind: 'observation', direction: 'server-to-client' });
    // A late state report cannot make the stopped direction look available again.
    worker.emit('message', { type: 'state', direction: 'client-to-server', state: { availability: 'degraded', phase: 'PLAY' } });
    expect(host.state().directions['client-to-server'].availability).toBe('unknown');
    expect(host.state().availability).toBe('unknown');
  });
});

describe('Round 5 — ack deadlines track progress, not absolute post time', () => {
  it('keeps a worker that acknowledges slowly but steadily', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const failures: string[] = [];
    const host = new ObserverWorkerHost({
      createWorker: () => worker,
      onEvent: () => {},
      onFailure: reason => failures.push(reason),
      ackTimeoutMs: 100,
    });
    host.start();
    // Eight chunks are posted immediately; each ack arrives only 40ms apart. Every chunk's
    // absolute post deadline would be ~100ms, but progress resets the idle deadline.
    for (let index = 0; index < 8; index += 1) expect(host.attach('client-to-server', new Uint8Array([index]))).toBe(true);
    for (let index = 0; index < 8; index += 1) {
      await vi.advanceTimersByTimeAsync(40);
      worker.emit('message', { type: 'ack', direction: 'client-to-server', bytes: 1, frames: 1 });
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(failures).toEqual([]);
    expect(worker.terminated).toBe(false);
    expect(host.state()).toMatchObject({ running: true });
    await host.stop();
  });
});

describe('Round 5 — global park anchoring', () => {
  it('does not resume the un-anchored direction when only one direction is reset', async () => {
    const observer = createBoundedObserver({ maxQueuedFrames: 1 });
    const observations: Array<Extract<ObserverEvent, { kind: 'observation' }>> = [];
    observer.subscribe(event => { if (event.kind === 'observation') observations.push(event); });
    // Overflow parks both directions globally.
    observer.attach('client-to-server', Buffer.from([1, 1, 1, 2]));
    expect(observer.health).toBe('unknown');
    observer.reset('client-to-server');
    observer.attach('client-to-server', frame(Buffer.from([1])));
    observer.attach('server-to-client', frame(Buffer.from([2])));
    await tick();
    expect(observations.map(event => event.direction)).toEqual(['client-to-server']);
    expect(observer.state().upstream.availability).toBe('unknown');
    observer.resetAll();
    observer.attach('server-to-client', frame(Buffer.from([3])));
    await tick();
    expect(observations.map(event => event.direction)).toEqual(['client-to-server', 'server-to-client']);
  });
});

describe('Round 5 — service command and capability truthfulness', () => {
  const config: BridgeServiceEntryConfig = {
    relay: {
      listenHost: '127.0.0.1', listenPort: 0, targetHost: '10.20.30.40', targetPort: 25_565,
      allowMinecraftUpstream: true, rewriteHandshake: true, heartbeatMs: 50,
    },
    observer: { enabled: true },
    profile: 'client-offline',
    network: 'upstream-explicit',
  };

  it('reports the real configured profile, network and target instead of hardcoded values', () => {
    const service = new BridgeService();
    const reply = serviceCommandReply(request('capabilities'), { sessionEpoch: 'epoch', service, config });
    expect(reply).toMatchObject({
      kind: 'reply', ok: true,
      result: {
        profile: 'client-offline',
        network: 'upstream-explicit',
        target: { host: '10.20.30.40', port: 25_565, source: 'configured-target' },
        upstream: { enabled: true, rewriteHandshake: true },
      },
    });
  });

  it('does not invent a profile when the caller did not supply one', () => {
    const service = new BridgeService();
    const relayOnly: BridgeServiceEntryConfig = { ...config, profile: undefined, network: undefined };
    const reply = serviceCommandReply(request('capabilities'), { sessionEpoch: 'epoch', service, config: relayOnly });
    expect(reply).toMatchObject({ kind: 'reply', ok: true, result: { profile: 'unspecified', network: 'upstream-explicit', target: { host: '10.20.30.40', port: 25_565 } } });
    expect(reply.kind === 'reply' ? reply.result : undefined).not.toMatchObject({ profile: 'client-offline' });
  });

  it('returns explicit command-unsupported for observer commands with no observer', () => {
    const service = new BridgeService();
    expect(serviceCommandReply(request('start-observer'), { sessionEpoch: 'epoch', service }))
      .toMatchObject({ kind: 'reply', ok: false, error: { code: 'command-unsupported' } });
    expect(serviceCommandReply(request('stop-observer'), { sessionEpoch: 'epoch', service }))
      .toMatchObject({ kind: 'reply', ok: false, error: { code: 'command-unsupported' } });
    const observer: ObserverMonitor = { start: () => undefined, stop: async () => undefined, state: () => ({ running: false }) };
    expect(serviceCommandReply(request('start-observer'), { sessionEpoch: 'epoch', service, observer }))
      .toMatchObject({ kind: 'start-observer' });
  });
});

describe('Round 5 — service start failure is not reported as success', () => {
  it('forwards start-observer to the relay child and returns the new observer epoch', async () => {
    class RespondingRelayChild implements ChildProcessLike {
      readonly pid = 4321;
      readonly sent: Array<Record<string, any>> = [];
      private readonly handlers = new Map<string, Set<(value?: unknown) => void>>();
      send(message: unknown) {
        const request = message as Record<string, any>;
        this.sent.push(request);
        queueMicrotask(() => {
          if (request.type === 'hello') {
            this.emit('message', { type: 'hello', protocolVersion: 1, process: 'relay', sessionEpoch: 'relay_child_epoch', bootEpoch: 'relay_boot', capabilities: [] });
          } else if (request.type === 'request' && request.command === 'start-observer') {
            this.emit('message', {
              type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch: 'relay_child_epoch', ok: true,
              result: { supported: true, recovered: true, reset: 'all-directions', observerEpoch: 'observer_new_epoch', observer: { running: true, availability: 'degraded', observerEpoch: 'observer_new_epoch', sessions: [] } },
            });
          } else if (request.type === 'request' && request.command === 'shutdown') {
            this.emit('message', { type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch: 'relay_child_epoch', ok: true, result: { stopped: true } });
            this.emit('exit', 0);
          }
        });
        // queued, not rejected: the service must still wait for the correlated response.
        return false;
      }
      on(event: 'message' | 'exit' | 'error', listener: (value?: unknown) => void) {
        const set = this.handlers.get(event) ?? new Set(); set.add(listener); this.handlers.set(event, set); return this;
      }
      kill() { return true; }
      emit(event: 'message' | 'exit' | 'error', value?: unknown) { for (const listener of this.handlers.get(event) ?? []) listener(value); }
    }
    const child = new RespondingRelayChild();
    relaySpawnState.child = child;
    const sent: Array<Record<string, any>> = [];
    let onMessage: ((value?: unknown) => void) | undefined;
    const ipc = {
      send: (message: unknown) => { sent.push(message as Record<string, any>); return true; },
      on: (event: 'message' | 'disconnect', listener: (value?: unknown) => void) => { if (event === 'message') onMessage = listener; return undefined; },
      off: () => undefined,
    };
    const handle = await runBridgeServiceEntry({
      relay: { listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort: 25565, allowMinecraftUpstream: true },
      observer: { enabled: true },
      helloTimeoutMs: 500,
    }, ipc, { log: () => undefined });
    try {
      expect(sent.some(message => message.type === 'hello')).toBe(true);
      expect(onMessage).toBeDefined();
      onMessage!({ type: 'request', protocolVersion: 1, requestId: 'recover-1', sessionEpoch: handle.sessionEpoch, command: 'start-observer', payload: {} });
      await waitFor(() => sent.some(message => message.type === 'response' && message.requestId === 'recover-1'), 'observer-recovery-response');
      const recovery = sent.find(message => message.type === 'response' && message.requestId === 'recover-1')!;
      expect(recovery).toMatchObject({ ok: true, result: { recovered: true, observerEpoch: 'observer_new_epoch', observer: { observerEpoch: 'observer_new_epoch' } } });
      // The service forwarded a real relay command rather than returning a local no-op success.
      expect(child.sent.some(message => message.type === 'request' && message.command === 'start-observer')).toBe(true);
    } finally {
      await handle.stop('test-cleanup');
    }
  });

  it('never sends hello when the service never reaches running and rejects the entry', async () => {
    const handlers = new Map<string, Set<(value?: unknown) => void>>();
    const fakeChild = {
      pid: 1234,
      send: (_message: unknown) => false,
      on: (event: string, listener: (value?: unknown) => void) => {
        const set = handlers.get(event) ?? new Set(); set.add(listener); handlers.set(event, set); return fakeChild;
      },
      kill: () => true,
    };
    relaySpawnState.child = fakeChild;
    const sent: Array<Record<string, any>> = [];
    const ipc = {
      send: (message: unknown) => { sent.push(message as Record<string, any>); return true; },
      on: () => undefined,
      off: () => undefined,
    };
    const failingConfig: BridgeServiceEntryConfig = {
      relay: { listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort: 25565, allowMinecraftUpstream: true },
      observer: { enabled: false },
      helloTimeoutMs: 50,
    };
    await expect(runBridgeServiceEntry(failingConfig, ipc, { log: () => undefined })).rejects.toThrow(/ipc-hello-timeout|supervisor/);
    expect(sent.filter(message => message.type === 'hello')).toHaveLength(0);
  });
});

/**
 * `runBridgeServiceEntry` forks the relay through this module. The start-failure test
 * replaces the spawner with a child that never sends its hello, so no real process is
 * launched while the failure path itself stays real.
 */
const relaySpawnState = vi.hoisted(() => ({ child: undefined as ChildProcessLike | undefined }));
vi.mock('../../src/bridge/relay/spawn.js', () => ({
  spawnRelayProcess: () => {
    if (!relaySpawnState.child) throw new Error('relay-spawn-not-configured');
    return relaySpawnState.child;
  },
}));
