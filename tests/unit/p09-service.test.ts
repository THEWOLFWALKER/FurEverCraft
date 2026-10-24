import { describe, expect, it } from 'vitest';
import { BridgeService, type BridgeServiceEvent, type HelperMonitor, type ObserverMonitor, type RelayMonitor } from '../../src/bridge/service/orchestrator.js';
import { BoundedIpcOutbox } from '../../src/bridge/service/ipc-outbox.js';
import { serviceCommandReply } from '../../src/bridge/service/entry.js';
import { IpcRequestSchema, type IpcRequest } from '../../src/bridge/ipc/protocol.js';

const flush = async (times = 6) => { for (let index = 0; index < times; index += 1) await new Promise(resolve => setImmediate(resolve)); };

class FakeRelay implements RelayMonitor {
  state = 'stopped';
  pid = 100;
  starts = 0;
  stops: string[] = [];
  failNextStart = false;
  private readonly exits = new Set<(reason: string) => void>();
  constructor(private readonly order?: string[]) {}
  async start(): Promise<void> { this.starts += 1; this.order?.push('relay:start'); if (this.failNextStart) { this.failNextStart = false; throw new Error('spawn-failed'); } this.state = 'running'; }
  async stop(reason = 'stop'): Promise<void> { this.stops.push(reason); this.order?.push(`relay:stop:${reason}`); this.state = 'stopped'; }
  onExit(listener: (reason: string) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
  emitExit(reason: string): void { for (const listener of this.exits) listener(reason); }
}

class FakeObserver implements ObserverMonitor {
  started = 0;
  stopped = 0;
  failures = new Set<(reason: string) => void>();
  constructor(private readonly order?: string[]) {}
  start(): void { this.started += 1; this.order?.push('observer:start'); }
  async stop(): Promise<void> { this.stopped += 1; this.order?.push('observer:stop'); }
  state(): unknown { return { running: this.started > this.stopped }; }
  onFailure(listener: (reason: string) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }
  fail(reason: string): void { for (const listener of this.failures) listener(reason); }
}

class FakeHelper implements HelperMonitor {
  shutdowns = 0;
  releases = 0;
  hangShutdown = false;
  private readonly exits = new Set<(reason: string) => void>();
  constructor(private readonly order?: string[]) {}
  async shutdown(): Promise<void> { this.shutdowns += 1; this.order?.push('helper:shutdown'); if (this.hangShutdown) await new Promise<void>(() => undefined); }
  async releaseOwnedInputs(): Promise<unknown> { this.releases += 1; this.order?.push('helper:release'); return { released: true }; }
  onExit(listener: (reason: string) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
  emitExit(reason: string): void { for (const listener of this.exits) listener(reason); }
  state(): unknown { return { running: true }; }
}

describe('P09 process orchestration', () => {
  it('starts and stops relay, observer and helper in order with a graceful shutdown', async () => {
    const order: string[] = [];
    const relay = new FakeRelay(order);
    const observer = new FakeObserver(order);
    const helper = new FakeHelper(order);
    const service = new BridgeService({ relay, observer, helper });
    await service.start();
    expect(observer.started).toBe(1);
    expect(relay.starts).toBe(1);
    expect(service.state).toBe('running');
    // Control starts revoked; an explicit fresh-observation arm is required.
    expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true });
    service.armControl('fresh-observation');
    expect(service.status()).toMatchObject({ admissionOpen: true, controlRevoked: false });
    await service.stop('quit');
    expect(relay.stops).toEqual(['quit']);
    expect(observer.stopped).toBe(1);
    expect(helper.releases).toBe(1);
    expect(helper.shutdowns).toBe(1);
    expect(service.state).toBe('stopped');
    // Exact lifecycle order: observer before relay on start; held input is released before the
    // relay/observer/helper are shut down, and the helper shutdown is last.
    expect(order).toEqual([
      'observer:start',
      'relay:start',
      'helper:release',
      'relay:stop:quit',
      'observer:stop',
      'helper:shutdown',
    ]);
    expect(order.indexOf('helper:release')).toBeLessThan(order.indexOf('helper:shutdown'));
  });

  it('revokes control on unexpected relay exit and restarts with backoff without re-arming', async () => {
    const relay = new FakeRelay();
    const helper = new FakeHelper();
    const delays: number[] = [];
    const service = new BridgeService({ relay, helper, maxRestarts: 2, backoffBaseMs: 10, backoffMaxMs: 30, sleep: async ms => { delays.push(ms); } });
    await service.start();
    service.armControl('operator');
    relay.emitExit('unexpected-exit');
    await flush();
    expect(service.status()).toMatchObject({ controlRevoked: true, admissionOpen: false, restarts: { attempts: 1, lastDelayMs: 10 } });
    expect(relay.starts).toBe(2);
    expect(service.state).toBe('running');
    // A restart is not fresh observation evidence: admission stays closed until armControl.
    expect(service.status().admissionOpen).toBe(false);
    expect(delays).toEqual([10]);
  });

  it('propagates a fatal event after exhausting the restart budget', async () => {
    const relay = new FakeRelay();
    const fatals: string[] = [];
    const service = new BridgeService({ relay, maxRestarts: 2, restartWindowMs: 60_000, backoffBaseMs: 1, sleep: async () => undefined, onFatal: reason => fatals.push(reason) });
    await service.start();
    relay.emitExit('unexpected-exit'); await flush();
    relay.emitExit('unexpected-exit'); await flush();
    relay.emitExit('unexpected-exit'); await flush();
    expect(fatals).toEqual(['restart-budget-exhausted']);
    expect(service.state).toBe('failed');
    expect(relay.starts).toBe(3); // initial + two budgeted restarts
  });

  it('revokes control before helper restart handling and never restores old held input', async () => {
    const relay = new FakeRelay();
    const helper = new FakeHelper();
    const events: string[] = [];
    const service = new BridgeService({ relay, helper, maxRestarts: 2, backoffBaseMs: 1, sleep: async () => undefined, onEvent: event => events.push(event.type) });
    await service.start();
    service.armControl('operator');
    helper.emitExit('helper-crash');
    await flush();
    expect(helper.releases).toBe(1);
    expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true });
    expect(events).toContain('helper-exit');
    expect(events).toContain('control-revoked');
    // A later relay restart does not resurrect the previous helper's held input.
    relay.emitExit('unexpected-exit');
    await flush();
    expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true });
  });

  it('keeps a bounded IPC queue, reports overflow and drains in order', async () => {
    const relay = new FakeRelay();
    const sent: unknown[] = [];
    let accept = false;
    // A throw means the channel rejected the hand-off (as opposed to false = queued).
    const service = new BridgeService({ relay, ipc: { send: message => { if (!accept) throw new Error('channel-unavailable'); sent.push(message); return true; } }, maxIpcMessages: 2 });
    await service.start();
    expect(service.status().ipc.messages).toBe(2);
    service.publishObserver({ kind: 'observation', frameSequence: '1' });
    service.publishObserver({ kind: 'observation', frameSequence: '2' });
    service.publishObserver({ kind: 'observation', frameSequence: '3' });
    const overflow = service.status().ipc;
    expect(overflow.messages).toBe(2);
    expect(overflow.dropped).toBeGreaterThan(0);
    expect(overflow.controlLost).toBe(true);
    expect(overflow.globalUnknown).toBe(true);
    accept = true;
    service.flush();
    expect(sent).toHaveLength(2);
    expect(service.status().ipc).toMatchObject({ messages: 0, bytes: 0, globalUnknown: false, backpressured: false });
  });

  it('closes admission synchronously on observer failure without stopping forwarding', async () => {
    const relay = new FakeRelay();
    const observer = new FakeObserver();
    const helper = new FakeHelper();
    const events: string[] = [];
    const service = new BridgeService({ relay, observer, helper, onEvent: event => events.push(event.type) });
    const listenerEvents: string[] = [];
    service.on(event => listenerEvents.push(event.type));
    await service.start();
    service.armControl('fresh-observation');
    expect(service.status()).toMatchObject({ admissionOpen: true, controlRevoked: false });

    // No await: observer failure must close admission synchronously.
    observer.fail('observer-crash');
    expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true });
    expect(helper.releases).toBe(1);
    expect(events).toContain('observer-failure');
    expect(events).toContain('control-revoked');
    expect(listenerEvents).toContain('control-revoked');
    // Relay forwarding is not stopped by observation loss.
    expect(relay.state).toBe('running');

    // A restart/explicit arm is the only way back open; stale observation is not re-armed.
    service.armControl('fresh-observation-after-failure');
    expect(service.status()).toMatchObject({ admissionOpen: true, controlRevoked: false });
    await service.stop();
  });

  it('revokes control for global observer gaps (and unknown availability) while forwarding continues', async () => {
    const relay = new FakeRelay();
    const service = new BridgeService({ relay });
    const events: BridgeServiceEvent[] = [];
    service.on(event => events.push(event));
    await service.start();
    service.armControl('fresh-observation');

    // A scoped domain gap with known availability does not by itself invalidate control.
    service.publishObserver({ kind: 'observer_gap', source: 'client', sessionEpoch: 's', gap: { scope: 'domain', reason: 'client-frame-gap', direction: 'client-to-server' } });
    expect(service.status()).toMatchObject({ admissionOpen: true, controlRevoked: false });

    service.publishObserver({ kind: 'observer_gap', source: 'client', sessionEpoch: 's', gap: { scope: 'global', reason: 'queue-overflow' } });
    expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true });
    expect(events.filter(event => event.type === 'control-revoked')).toHaveLength(1);
    expect(relay.state).toBe('running');

    service.armControl('fresh-observation-after-global-gap');
    // Availability unknown is also a control invalidating report, even for a domain gap.
    service.publishObserver({ kind: 'observer_gap', source: 'client', sessionEpoch: 's', availability: 'unknown', gap: { scope: 'domain', reason: 'availability-lost' } });
    expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true });
    expect(relay.state).toBe('running');
    await service.stop();
  });

  it('notifies exactly once per IPC overflow episode, closes admission and drains on recovery', async () => {
    let accept = false;
    const sent: unknown[] = [];
    const service = new BridgeService({
      ipc: { send: message => { if (!accept) throw new Error('channel-unavailable'); sent.push(message); return true; } },
      maxIpcMessages: 1,
    });
    const overflow: BridgeServiceEvent[] = [];
    service.on(event => { if (event.type === 'ipc-overflow') overflow.push(event); });

    await service.start();
    // Starting emits two state control messages into a one-slot queue: the first control
    // loss must close admission and reach runtime listeners directly, not just the log.
    expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true, ipc: { controlLost: true, globalUnknown: true } });
    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toMatchObject({ type: 'ipc-overflow', controlLost: true, globalUnknown: true });

    // Further drops in the same backed-up episode do not spam listeners.
    for (let index = 0; index < 10; index += 1) service.publishObserver({ kind: 'observation', frameSequence: String(index) });
    expect(overflow).toHaveLength(1);

    // Draining ends the episode; a later overflow is a new episode.
    accept = true;
    service.flush();
    expect(service.status().ipc).toMatchObject({ messages: 0, bytes: 0 });
    // The runtime notification was delivered directly, not re-enqueued into the same outbox.
    expect(sent.some(message => (message as { type?: string }).type === 'ipc-overflow')).toBe(false);
    accept = false;
    service.publishObserver({ kind: 'observation', frameSequence: 'drain-1' });
    service.publishObserver({ kind: 'observation', frameSequence: 'drain-2' });
    expect(overflow).toHaveLength(2);
    accept = true;
    service.flush();
    await service.stop();
  });

  it('treats an observation-only IPC overflow as global uncertainty with a synthesized gap', async () => {
    let accept = true;
    const service = new BridgeService({ ipc: { send: () => { if (!accept) throw new Error('channel-unavailable'); return true; } }, maxIpcMessages: 1 });
    const events: BridgeServiceEvent[] = [];
    service.on(event => events.push(event));
    service.armControl('fresh-observation');
    expect(service.status().admissionOpen).toBe(true);
    accept = false;

    service.publishObserver({ kind: 'observation', frameSequence: '1' });
    service.publishObserver({ kind: 'observation', frameSequence: '2' });
    expect(service.status()).toMatchObject({ admissionOpen: false, controlRevoked: true, ipc: { controlLost: false, globalUnknown: true } });
    expect(events.filter(event => event.type === 'ipc-overflow')).toHaveLength(1);
    expect(events.find(event => event.type === 'ipc-overflow')).toMatchObject({ controlLost: false, globalUnknown: true });
    const synthesized = events.find(event => event.type === 'observer-event' && (event.event as { kind?: string } | undefined)?.kind === 'observer_gap');
    expect(synthesized).toBeDefined();
    expect((synthesized as { event: { gap: unknown } }).event.gap).toMatchObject({ scope: 'global', reason: 'ipc-queue-overflow' });

    // Same episode: no duplicate runtime notification.
    for (let index = 0; index < 5; index += 1) service.publishObserver({ kind: 'observation', frameSequence: String(index + 3) });
    expect(events.filter(event => event.type === 'ipc-overflow')).toHaveLength(1);
    accept = true;
    service.flush();
    await service.stop();
  });

  it('enforces a graceful shutdown deadline', async () => {
    const relay = new FakeRelay();
    const helper = new FakeHelper();
    helper.hangShutdown = true;
    const service = new BridgeService({ relay, helper, shutdownGraceMs: 25 });
    await service.start();
    const started = Date.now();
    await service.stop('deadline');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(service.status().shutdown.forced).toBe(true);
    expect(service.state).toBe('stopped');
  });

  it('redacts secrets in orchestration logs', async () => {
    const relay = new FakeRelay();
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const service = new BridgeService({ relay, log: (_level, event, fields) => logs.push({ event, fields }) });
    await service.start();
    await service.revokeControl('Bearer sk-secret-value');
    const revoked = logs.find(entry => entry.event === 'control-revoked');
    expect(JSON.stringify(revoked)).not.toContain('sk-secret-value');
    expect(JSON.stringify(revoked)).toContain('[REDACTED]');
    await service.stop();
  });
});

describe('P09 bounded IPC outbox', () => {
  it('drops oldest entries at the count limit and reports control loss', () => {
    const outbox = new BoundedIpcOutbox({ maxMessages: 2 });
    outbox.push({ type: 'observer-event', payload: 1 });
    outbox.push({ type: 'observer-event', payload: 2 });
    const result = outbox.push({ type: 'state', state: 'running' }); // control
    expect(result.dropped).toBe(1);
    expect(result.controlLost).toBe(false);
    outbox.push({ type: 'observer-event', payload: 3 });
    outbox.push({ type: 'fatal', reason: 'x' });
    expect(outbox.queued()).toMatchObject({ messages: 2, controlLost: true });
  });

  it('treats false as queued exactly once and preserves order without duplicates', () => {
    const outbox = new BoundedIpcOutbox({ maxMessages: 8 });
    outbox.push({ type: 'observer-event', payload: 'a' });
    outbox.push({ type: 'observer-event', payload: 'b' });
    outbox.push({ type: 'observer-event', payload: 'c' });
    const attempted: unknown[] = [];
    // Node returns false when it accepted the message onto a backed-up channel. It was
    // still handed off, so the outbox must drop its copy and stop for this duty cycle.
    const first = outbox.flush(message => { attempted.push(message); return false; });
    expect(first).toMatchObject({ sent: 1, queued: 2, transportError: false });
    expect(attempted.map(message => (message as { payload: string }).payload)).toEqual(['a']);
    const drained: unknown[] = [];
    const second = outbox.flush(message => { drained.push(message); return true; });
    expect(second).toMatchObject({ sent: 2, queued: 0, transportError: false });
    expect(drained.map(message => (message as { payload: string }).payload)).toEqual(['b', 'c']);
    // Every message crossed exactly once: no duplicate of the queued-accepted `a`.
    expect([...attempted, ...drained].map(message => (message as { payload: string }).payload)).toEqual(['a', 'b', 'c']);
    expect(outbox.queued()).toMatchObject({ messages: 0, bytes: 0 });
  });

  it('retains an entry only when the channel throws (not handed off) and reports the transport error', () => {
    const outbox = new BoundedIpcOutbox({ maxMessages: 8 });
    outbox.push({ type: 'observer-event', payload: 'a' });
    const failed = outbox.flush(() => { throw new Error('ipc-closed'); });
    expect(failed).toMatchObject({ sent: 0, queued: 1, transportError: true });
    const drained: unknown[] = [];
    expect(outbox.flush(message => { drained.push(message); return false; })).toMatchObject({ sent: 1, queued: 0 });
    expect(drained.map(message => (message as { payload: string }).payload)).toEqual(['a']);
  });

  it('rejects a message larger than the byte budget', () => {
    const outbox = new BoundedIpcOutbox({ maxBytes: 16 });
    const result = outbox.push({ type: 'state', blob: 'x'.repeat(100) });
    expect(result.accepted).toBe(false);
    expect(result.controlLost).toBe(true);
  });
});

describe('P09 IPC command truthfulness', () => {
  const request = (command: string, sessionEpoch = 'epoch'): IpcRequest => IpcRequestSchema.parse({
    type: 'request', protocolVersion: 1, requestId: `request-${command}`, sessionEpoch, command, payload: {},
  });

  it('accepts the arm command and applies it only for the owning session epoch', () => {
    const service = new BridgeService();
    const armed = serviceCommandReply(request('arm'), { sessionEpoch: 'epoch', service });
    expect(armed).toMatchObject({ kind: 'reply', ok: true, result: { armed: true, controlRevoked: false } });
    expect(service.status()).toMatchObject({ admissionOpen: true, controlRevoked: false });
    if (armed.kind === 'reply') expect(armed.result).toMatchObject({ status: { admissionOpen: true } });

    const stale = serviceCommandReply(request('arm', 'old-epoch'), { sessionEpoch: 'epoch', service });
    expect(stale).toMatchObject({ kind: 'reply', ok: false, error: { code: 'stale-session' } });
  });

  it('returns precise unsupported codes instead of unconditional acceptance', () => {
    const service = new BridgeService();
    expect(serviceCommandReply(request('observe'), { sessionEpoch: 'epoch', service }))
      .toMatchObject({ kind: 'reply', ok: false, error: { code: 'observe-unsupported' } });
    const future = { ...request('status'), command: 'future-command' } as unknown as IpcRequest;
    expect(serviceCommandReply(future, { sessionEpoch: 'epoch', service }))
      .toMatchObject({ kind: 'reply', ok: false, error: { code: 'command-unsupported' } });
    // No fallback claims acceptance.
    expect(service.status().admissionOpen).toBe(false);
  });
});
