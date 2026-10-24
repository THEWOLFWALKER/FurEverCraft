import { describe, expect, it } from 'vitest';
import { BridgeService, type HelperMonitor, type ObserverMonitor, type RelayMonitor } from '../../src/bridge/service/orchestrator.js';
import { BoundedIpcOutbox } from '../../src/bridge/service/ipc-outbox.js';

const flush = async (times = 6) => { for (let index = 0; index < times; index += 1) await new Promise(resolve => setImmediate(resolve)); };

class FakeRelay implements RelayMonitor {
  state = 'stopped';
  pid = 100;
  starts = 0;
  stops: string[] = [];
  failNextStart = false;
  private readonly exits = new Set<(reason: string) => void>();
  async start(): Promise<void> { this.starts += 1; if (this.failNextStart) { this.failNextStart = false; throw new Error('spawn-failed'); } this.state = 'running'; }
  async stop(reason = 'stop'): Promise<void> { this.stops.push(reason); this.state = 'stopped'; }
  onExit(listener: (reason: string) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
  emitExit(reason: string): void { for (const listener of this.exits) listener(reason); }
}

class FakeObserver implements ObserverMonitor {
  started = 0;
  stopped = 0;
  failures = new Set<(reason: string) => void>();
  start(): void { this.started += 1; }
  async stop(): Promise<void> { this.stopped += 1; }
  state(): unknown { return { running: this.started > this.stopped }; }
  onFailure(listener: (reason: string) => void): () => void { this.failures.add(listener); return () => this.failures.delete(listener); }
  fail(reason: string): void { for (const listener of this.failures) listener(reason); }
}

class FakeHelper implements HelperMonitor {
  shutdowns = 0;
  releases = 0;
  hangShutdown = false;
  private readonly exits = new Set<(reason: string) => void>();
  async shutdown(): Promise<void> { this.shutdowns += 1; if (this.hangShutdown) await new Promise<void>(() => undefined); }
  async releaseOwnedInputs(): Promise<unknown> { this.releases += 1; return { released: true }; }
  onExit(listener: (reason: string) => void): () => void { this.exits.add(listener); return () => this.exits.delete(listener); }
  emitExit(reason: string): void { for (const listener of this.exits) listener(reason); }
  state(): unknown { return { running: true }; }
}

describe('P09 process orchestration', () => {
  it('starts and stops relay, observer and helper in order with a graceful shutdown', async () => {
    const relay = new FakeRelay();
    const observer = new FakeObserver();
    const helper = new FakeHelper();
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
    const service = new BridgeService({ relay, ipc: { send: message => { if (accept) sent.push(message); return accept; } }, maxIpcMessages: 2 });
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
    expect(service.status().ipc).toMatchObject({ messages: 0, bytes: 0 });
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

  it('stops duty flushing on backpressure and preserves order', () => {
    const outbox = new BoundedIpcOutbox({ maxMessages: 8 });
    outbox.push({ type: 'observer-event', payload: 'a' });
    outbox.push({ type: 'observer-event', payload: 'b' });
    outbox.push({ type: 'observer-event', payload: 'c' });
    const attempted: unknown[] = [];
    const first = outbox.flush(message => { attempted.push(message); return false; });
    expect(first.sent).toBe(0);
    expect(first.queued).toBe(3);
    const drained: unknown[] = [];
    const second = outbox.flush(message => { drained.push(message); return true; });
    expect(second.sent).toBe(3);
    expect(drained.map(message => (message as { payload: string }).payload)).toEqual(['a', 'b', 'c']);
    expect(outbox.queued()).toMatchObject({ messages: 0, bytes: 0 });
  });

  it('rejects a message larger than the byte budget', () => {
    const outbox = new BoundedIpcOutbox({ maxBytes: 16 });
    const result = outbox.push({ type: 'state', blob: 'x'.repeat(100) });
    expect(result.accepted).toBe(false);
    expect(result.controlLost).toBe(true);
  });
});
