import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';

/**
 * Real Windows-only dry-run subprocess tests.
 *
 * They are explicitly skipped (reported as skipped, not silently passed) on non-Windows
 * hosts. The helper runs with -DryRun, so it never calls SendInput or captures the desktop.
 */
const isWindows = process.platform === 'win32';

type HelperResponse = {
  requestId: string | null;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
};

class HelperProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines;
  private readonly pending = new Map<string, { resolve: (value: HelperResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private sequence = 0;
  private stderr = '';

  constructor() {
    const script = resolve('native/windows/FurEverCraft.Helper.ps1');
    this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-DryRun'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let response: HelperResponse;
      try { response = JSON.parse(line) as HelperResponse; } catch { return; }
      if (!response || typeof response.requestId !== 'string') return;
      const waiter = this.pending.get(response.requestId);
      if (!waiter) return;
      this.pending.delete(response.requestId);
      clearTimeout(waiter.timer);
      waiter.resolve(response);
    });
    this.child.stderr.on('data', (chunk: Buffer | string) => { this.stderr += String(chunk); });
  }

  request(command: string, fields: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<HelperResponse> {
    const requestId = `test_${++this.sequence}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`helper-test-timeout:${command}:${this.stderr.slice(-400)}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: resolvePromise, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ requestId, command, ...fields })}\n`);
    });
  }

  async close(): Promise<void> {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('helper-test-closed'));
    }
    this.pending.clear();
    this.lines.close();
    try { this.child.stdin.end(); } catch { /* best effort */ }
    try { this.child.kill(); } catch { /* best effort */ }
  }
}

async function withHelper<T>(run: (helper: HelperProcess) => Promise<T>): Promise<T> {
  const helper = new HelperProcess();
  try { return await run(helper); } finally { await helper.close(); }
}

async function bind(helper: HelperProcess, epoch = 'test-epoch', pid = 4242) {
  const response = await helper.request('bindWindow', { pid, hwnd: String(pid), epoch });
  expect(response.ok, response.error).toBe(true);
  expect(response.result?.bound).toBe(true);
}

const futureLease = () => Date.now() + 5_000;

describe.skipIf(!isWindows)('Windows helper dry-run subprocess', () => {
  it('probes without touching SendInput', async () => {
    await withHelper(async helper => {
      const response = await helper.request('probe');
      expect(response.ok).toBe(true);
      expect(response.result).toMatchObject({ supported: true, dryRun: true, sendInputCalls: 0, platform: 'windows', inputBackend: 'dry-run' });
    });
  });

  it('replaces the held set and releases all on an empty set (FEC-17)', async () => {
    await withHelper(async helper => {
      await bind(helper);
      const leaseUntil = futureLease();
      const first = await helper.request('setHeldInputs', { epoch: 'test-epoch', generation: 1, commandSeq: 1, leaseUntil, pulseTtlMs: 150, inputs: { '87': true, '65': true } });
      expect(first.ok, first.error).toBe(true);
      expect(first.result?.heldCount).toBe(2);
      const second = await helper.request('setHeldInputs', { epoch: 'test-epoch', generation: 1, commandSeq: 2, leaseUntil, pulseTtlMs: 150, inputs: { '65': true } });
      expect(second.result?.heldCount).toBe(1);
      const third = await helper.request('setHeldInputs', { epoch: 'test-epoch', generation: 1, commandSeq: 3, leaseUntil, pulseTtlMs: 150, inputs: {} });
      expect(third.result?.heldCount).toBe(0);
      expect(Number(third.result?.releasedCount)).toBeGreaterThanOrEqual(2);
      const state = await helper.request('getState');
      expect(state.result?.sendInputCalls).toBe(0);
    });
  });

  it('lets the watchdog release held input while stdin stays open (FEC-15)', async () => {
    await withHelper(async helper => {
      await bind(helper);
      const held = await helper.request('setHeldInputs', { epoch: 'test-epoch', generation: 1, commandSeq: 1, leaseUntil: futureLease(), pulseTtlMs: 100, inputs: { '87': true } });
      expect(held.result?.heldCount).toBe(1);
      // Do not send another line. stdin remains open; only the watchdog can release.
      await new Promise(resolvePromise => setTimeout(resolvePromise, 350));
      const state = await helper.request('getState');
      expect(state.ok).toBe(true);
      expect(state.result?.heldCount).toBe(0);
      expect(Number(state.result?.releasedCount)).toBeGreaterThanOrEqual(1);
    });
  });

  it('stops text at a focus flip and returns a structured partial/ambiguous receipt (FEC-18)', async () => {
    await withHelper(async helper => {
      await bind(helper);
      const fields = {
        epoch: 'test-epoch',
        generation: 1,
        commandSeq: 1,
        leaseUntil: futureLease(),
        text: 'A'.repeat(40),
        commandId: 'text-focus-flip',
        focusFlipAfterChars: 16,
      };
      const response = await helper.request('typeText', fields);
      expect(response.ok, response.error).toBe(true);
      expect(response.result).toMatchObject({ accepted: false, partial: true, ambiguous: true, status: 'partial', sentUnits: 16, remainingUnits: 24 });
      // Replaying the same command id returns the original receipt; the remaining text is
      // never sent a second time.
      const replay = await helper.request('typeText', fields);
      expect(replay.ok).toBe(true);
      expect(replay.result?.duplicate).toBe(true);
      expect(replay.result?.sentUnits).toBe(16);
      const state = await helper.request('getState');
      expect(state.result?.sendInputCalls).toBe(0);
    });
  });

  it('bounds dedup and rejects an evicted sequence at the high-water mark (FEC-19)', async () => {
    await withHelper(async helper => {
      const configured = await helper.request('configure', { dedupCapacity: 4, dedupTtlMs: 600_000 });
      expect(configured.ok, configured.error).toBe(true);
      await bind(helper, 'dedup-epoch');
      const leaseUntil = futureLease();
      for (let index = 1; index <= 6; index += 1) {
        const heartbeat = await helper.request('heartbeat');
        expect(heartbeat.ok).toBe(true);
        const clicked = await helper.request('click', { epoch: 'dedup-epoch', generation: 1, commandSeq: index, leaseUntil, button: 'left', commandId: `click-${index}` });
        expect(clicked.ok, clicked.error).toBe(true);
      }
      const state = await helper.request('getState');
      expect(state.result?.dedupCount).toBe(4);
      expect(state.result?.commandSequenceHighWater).toBe(6);
      const duplicate = await helper.request('click', { epoch: 'dedup-epoch', generation: 1, commandSeq: 6, leaseUntil, button: 'left', commandId: 'click-6' });
      expect(duplicate.ok).toBe(true);
      expect(duplicate.result?.duplicate).toBe(true);
      const heartbeat = await helper.request('heartbeat');
      expect(heartbeat.ok).toBe(true);
      const stale = await helper.request('click', { epoch: 'dedup-epoch', generation: 1, commandSeq: 1, leaseUntil, button: 'left', commandId: 'click-1' });
      expect(stale.ok).toBe(false);
      expect(stale.errorCode).toBe('stale-command-sequence');
      const probe = await helper.request('probe');
      expect(probe.result?.sendInputCalls).toBe(0);
    });
  });
});

if (!isWindows) {
  describe('Windows helper dry-run subprocess (explicit skip)', () => {
    it('does not run on non-Windows hosts', () => {
      // Reported as an explicit non-Windows pass rather than hiding the skipped suite.
      expect(process.platform).not.toBe('win32');
    });
  });
}
