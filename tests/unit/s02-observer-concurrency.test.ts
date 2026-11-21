import { describe, expect, it } from 'vitest';
import { createBoundedObserver } from '../../src/bridge/observer/bounded.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const frame = (payload: number[]) => Buffer.from([payload.length, ...payload]);
const frames = (count: number) => Buffer.concat(Array.from({ length: count }, (_, index) => frame([index % 250])));

describe('S02 observer task timeout and concurrency slots', () => {
  it('does not release a slot while the timed-out listener is still running', async () => {
    const observer = createBoundedObserver({ maxConcurrency: 1, taskTimeoutMs: 10, maxQueuedFrames: 64 });
    let invocations = 0;
    observer.subscribe(() => {
      invocations += 1;
      return new Promise<void>(() => undefined);
    });
    observer.attach('client-to-server', frames(8));
    await sleep(60);
    // A timeout marks the subscriber isolated but the single slot remains owned by it.
    expect(invocations).toBe(1);
    observer.attach('client-to-server', frames(4));
    await tick();
    expect(invocations).toBe(1);
  });

  it('stops invoking an isolated subscriber but releases the slot when it settles', async () => {
    const observer = createBoundedObserver({ maxConcurrency: 1, taskTimeoutMs: 15, maxQueuedFrames: 16 });
    let hangingCalls = 0;
    let healthyCalls = 0;
    observer.subscribe(async () => {
      hangingCalls += 1;
      if (hangingCalls === 1) await sleep(80);
    });
    observer.subscribe(() => { healthyCalls += 1; return Promise.resolve(); });
    observer.attach('client-to-server', frames(1));
    await sleep(30);
    expect(hangingCalls).toBe(1);
    expect(healthyCalls).toBe(1);
    // The slot is still occupied by the timed-out listener, so no new dispatch yet.
    observer.attach('client-to-server', frames(1));
    await sleep(20);
    expect(healthyCalls).toBe(1);
    // Once the hung invocation settles the slot is released and the isolated listener is
    // no longer invoked for later frames.
    await sleep(70);
    observer.attach('client-to-server', frames(1));
    await sleep(30);
    expect(hangingCalls).toBe(1);
    expect(healthyCalls).toBeGreaterThanOrEqual(2);
  });

  it('never dispatches over maxConcurrency and stop() resolves hung listeners', async () => {
    const observer = createBoundedObserver({ maxConcurrency: 2, taskTimeoutMs: 5, maxQueuedFrames: 64 });
    let active = 0;
    let maxActive = 0;
    observer.subscribe(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<void>(() => undefined);
    });
    observer.attach('client-to-server', frames(10));
    await sleep(60);
    expect(maxActive).toBe(2);
    const started = Date.now();
    await Promise.race([
      observer.stop(),
      sleep(500).then(() => { throw new Error('stop-did-not-resolve'); }),
    ]);
    expect(Date.now() - started).toBeLessThan(400);
    expect(observer.health).toBe('stopped');
  });
});
