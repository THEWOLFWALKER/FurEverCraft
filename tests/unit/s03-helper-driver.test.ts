import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { FakeHelperTransport, JsonlHelperTransport, WindowsHelperDriver, isHelperError } from '../../src/bridge/windows/driver.js';

function hangingChild(source: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
}

describe('S03 helper driver hardening', () => {
  it('times out a live helper child that never replies (FEC-16)', async () => {
    const child = hangingChild('process.stdin.resume(); setInterval(function(){}, 1000);');
    const transport = new JsonlHelperTransport(child, { requestTimeoutMs: 40 });
    try {
      const error = await transport.send({ requestId: 'never', command: 'probe' }).then(() => undefined, value => value);
      expect(isHelperError(error)).toBe(true);
      expect((error as Error & { code: string }).code).toBe('helper-response-timeout');
      expect(transport.state()).toMatchObject({ pending: 0, closed: false });
    } finally {
      await transport.close();
    }
  });

  it('bounds the driver request timeout and never retries a non-idempotent click (FEC-16)', async () => {
    let clickAttempts = 0;
    const transport = new FakeHelperTransport(request => {
      if (request.command === 'bindWindow') return { requestId: request.requestId, ok: true, result: { bound: true, pid: request.pid, hwnd: request.hwnd } };
      if (request.command === 'click') { clickAttempts += 1; return new Promise(() => undefined); }
      return { requestId: request.requestId, ok: true, result: { command: request.command } };
    });
    const driver = new WindowsHelperDriver(transport, true, () => 1_000, 250, { requestTimeoutMs: 30 });
    await driver.bindWindow(1, 'h');
    await expect(driver.click('left', 'click-timeout', 5_000)).rejects.toMatchObject({ code: 'helper-response-timeout' });
    expect(clickAttempts).toBe(1);
    // The same command id returns an ambiguous "already attempted" marker instead of
    // sending the mouse action again.
    await expect(driver.click('left', 'click-timeout', 5_000)).resolves.toMatchObject({ duplicate: true, ambiguous: true });
    expect(clickAttempts).toBe(1);
    expect(driver.state().inFlight).toBe(0);
    driver.forceStop();
  });

  it('bounds dedup capacity/TTL and clears it on a new epoch or bind (FEC-19)', async () => {
    let now = 1_000;
    const transport = new FakeHelperTransport(request => request.command === 'bindWindow'
      ? { requestId: request.requestId, ok: true, result: { bound: true, pid: request.pid, hwnd: request.hwnd } }
      : { requestId: request.requestId, ok: true, result: { command: request.command } });
    const driver = new WindowsHelperDriver(transport, true, () => now, 250, { dedupCapacity: 2, dedupTtlMs: 1_000 });
    await driver.bindWindow(1, 'h');
    const sentClicks = () => transport.requests.filter(request => request.command === 'click').length;
    await driver.click('left', 'c1', 9_000); now = 1_010;
    await driver.click('left', 'c2', 9_000); now = 1_020;
    await driver.click('left', 'c3', 9_000);
    expect(driver.state().dedup).toMatchObject({ size: 2, capacity: 2 });
    expect(sentClicks()).toBe(3);
    await expect(driver.click('left', 'c2', 9_000)).resolves.toMatchObject({ duplicate: true });
    expect(sentClicks()).toBe(3);
    // c1 was evicted by the bounded cache, so it is treated as a new effect.
    await driver.click('left', 'c1', 9_000);
    expect(sentClicks()).toBe(4);

    driver.setEpoch('epoch-2');
    expect(driver.state()).toMatchObject({ epoch: 'epoch-2' });
    expect(driver.state().dedup).toMatchObject({ size: 0, highWater: 0, commandSequence: 0 });
    driver.forceStop();
  });

  it('validates leaseUntil is finite and uses a separate bounded release/shutdown deadline', async () => {
    const transport = new FakeHelperTransport(request => {
      if (request.command === 'bindWindow') return { requestId: request.requestId, ok: true, result: { bound: true, pid: request.pid, hwnd: request.hwnd } };
      if (request.command === 'releaseOwnedInputs') return new Promise(() => undefined);
      if (request.command === 'shutdown') return { requestId: request.requestId, ok: true, result: { stopped: true } };
      return { requestId: request.requestId, ok: true, result: {} };
    });
    const driver = new WindowsHelperDriver(transport, true, () => 1_000, 250, { releaseTimeoutMs: 20, shutdownTimeoutMs: 20 });
    await driver.bindWindow(1, 'h');
    expect(() => driver.click('left', 'bad-lease', Number.NaN)).toThrow('invalid-lease');
    expect(() => driver.setHeldInputs({}, 0, Number.POSITIVE_INFINITY)).toThrow('invalid-lease');
    await expect(driver.shutdown()).rejects.toMatchObject({ code: 'helper-release-timeout' });
    expect(transport.requests.some(request => request.command === 'shutdown')).toBe(true);
  });

  it('caps an overlong JSONL line and drains bounded stderr (FEC-16)', async () => {
    const child = hangingChild("process.stderr.write('x'.repeat(200)); process.stdout.write('y'.repeat(70000) + '\\n'); setInterval(function(){}, 1000);");
    const transport = new JsonlHelperTransport(child, { requestTimeoutMs: 30, maxLineBytes: 1_024, stderrLimitBytes: 32 });
    try {
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(transport.state()).toMatchObject({ overflowLines: 1 });
      const drained = transport.drainStderr();
      expect(drained.length).toBeLessThanOrEqual(32);
      expect(transport.state().stderrDropped).toBeGreaterThan(0);
      expect(transport.drainStderr()).toBe('');
    } finally {
      await transport.close();
    }
  });
});
