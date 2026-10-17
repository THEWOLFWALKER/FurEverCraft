import { describe, expect, it } from 'vitest';
import { FakeHelperTransport, WindowsHelperDriver } from '../../src/bridge/windows/driver.js';

describe('Windows helper driver offline contract', () => {
  it('enforces profile gates, bound identity, focus and visible state', async () => {
    const transport = new FakeHelperTransport(request => ({ requestId: request.requestId, ok: true, result: { exists: true, focused: false, visible: true } }));
    const driver = new WindowsHelperDriver(transport, true, () => 100);
    expect(() => driver.moveRelative(1, 2, 'm1', 200)).toThrow('window-not-actionable');
    await expect(driver.bindWindow(0, '0x2a')).rejects.toThrow('window-identity-required');
    const boundTransport = new FakeHelperTransport(request => ({ requestId: request.requestId, ok: true, result: request.command === 'getWindowState' ? { exists: true, focused: false, visible: true } : undefined }));
    const bound = new WindowsHelperDriver(boundTransport, true, () => 100);
    await bound.bindWindow(42, '0x2a');
    await bound.getWindowState();
    expect(() => bound.moveRelative(1, 2, 'm1', 200)).toThrow('window-not-actionable');
    await bound.shutdown();
    const disabled = new WindowsHelperDriver(new FakeHelperTransport());
    expect(() => disabled.captureWindow()).toThrow('os-input-disabled');
  });

  it('rejects expired leases and NUL text, deduplicates effects and validates response IDs', async () => {
    let now = 1_000;
    const transport = new FakeHelperTransport(request => ({ requestId: request.requestId, ok: true, result: { command: request.command, dryRun: true } }));
    const driver = new WindowsHelperDriver(transport, true, () => now);
    await driver.bindWindow(12, '0xc');
    await driver.getWindowState();
    expect(() => driver.click('left', 'click-1', 1_000)).toThrow('input-expired');
    await expect(driver.typeText('a\0b', 'text-1', 2_000)).rejects.toThrow('invalid-text');
    const firstText = await driver.typeText('hello', 'text-id', 2_000);
    const secondText = await driver.typeText('hello', 'text-id', 2_000);
    expect(firstText).toEqual({ command: 'typeText', dryRun: true });
    expect(secondText).toEqual({ duplicate: true });
    expect(transport.requests.filter(request => request.command === 'typeText')).toHaveLength(1);
    now = 2_000;
    expect(() => driver.setHeldInputs({}, 3, 2_000)).toThrow('input-expired');
    await driver.shutdown();

    const bad = new FakeHelperTransport(request => ({ requestId: 'wrong', ok: true }));
    await expect(new WindowsHelperDriver(bad, false).probe()).rejects.toThrow('helper-response-id-mismatch');
    const failed = new FakeHelperTransport(request => ({ requestId: request.requestId, ok: false, error: 'stale-generation' }));
    await expect(new WindowsHelperDriver(failed, false).probe()).rejects.toThrow('stale-generation');
  });

  it('releases owned inputs after focus loss and shutdown', async () => {
    let focused = true;
    const transport = new FakeHelperTransport(request => ({ requestId: request.requestId, ok: true, result: request.command === 'getWindowState' ? { exists: true, focused, visible: true } : undefined }));
    const driver = new WindowsHelperDriver(transport, true);
    await driver.bindWindow(12, '0xc');
    focused = false;
    await driver.getWindowState();
    expect(transport.requests.some(request => request.command === 'releaseOwnedInputs')).toBe(true);
    focused = true;
    await driver.getWindowState();
    await driver.shutdown();
    expect(transport.requests.at(-2)?.command).toBe('releaseOwnedInputs');
    expect(transport.requests.at(-1)?.command).toBe('shutdown');
  });
});
