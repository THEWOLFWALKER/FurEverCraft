import { describe, expect, it, vi } from 'vitest';
import { CompositeClientBridge } from '../../src/bridge/composite.js';
import { FakeHelperTransport, WindowsHelperDriver } from '../../src/bridge/windows/driver.js';
import { ProtocolSession } from '../../src/bridge/protocol/session.js';

describe('CompositeClientBridge', () => {
  it('reports only enabled capabilities', async () => {
    const bridge = new CompositeClientBridge({ profile: { profile: 'client-offline' } });
    expect(bridge.capabilities).toMatchObject({ protocolObservation: false, nativeInput: false, screenCapture: false, authentication: false, stableNavigation: false });
    await expect(bridge.captureWindow()).rejects.toThrow('screenCapture-disabled');
  });
  it('combines protocol observations and windows under one identity', async () => {
    const protocol = new ProtocolSession('fixture-session');
    const transport = new FakeHelperTransport(request => request.command === 'getWindowState'
      ? { requestId: request.requestId, ok: true, result: { exists: true, focused: true, visible: true, pid: 1, hwnd: 'hwnd' } }
      : request.command === 'bindWindow'
        ? { requestId: request.requestId, ok: true, result: { bound: true, pid: request.pid, hwnd: request.hwnd } }
        : { requestId: request.requestId, ok: true, result: { command: request.command } }, { dryRun: false });
    const bridge = new CompositeClientBridge({ protocol, windows: new WindowsHelperDriver(transport, true), profile: { profile: 'client-offline', allowOsInput: true, allowScreenCapture: true } });
    expect(bridge.identity.connectionEpoch).toBe('fixture-session');
    protocol.observe('position', 'upstream', { x: 1 });
    await bridge.bindWindow(1, 'hwnd');
    await bridge.moveRelative(1, 0, 'move-1', Date.now() + 1000);
    expect(bridge.observe()[0].sessionEpoch).toBe('fixture-session');
    expect(transport.requests.map(request => request.command)).toContain('moveRelative');
    expect(transport.requests.filter(request => request.command === 'bindWindow')).toHaveLength(1);
    expect(transport.requests.filter(request => request.command === 'getWindowState')).toHaveLength(1);
  });
  it('releases inputs on focus loss and coordinates auth without exposing secrets', async () => {
    let focused = true;
    const transport = new FakeHelperTransport(request => request.command === 'getWindowState'
      ? { requestId: request.requestId, ok: true, result: { exists: true, focused, visible: true, pid: 1, hwnd: 'h' } }
      : request.command === 'bindWindow'
        ? { requestId: request.requestId, ok: true, result: { bound: true, pid: request.pid, hwnd: request.hwnd } }
        : { requestId: request.requestId, ok: true, result: { mimeType: 'image/png', data: 'fixture' } }, { dryRun: false });
    const auth = vi.fn(async () => undefined);
    const bridge = new CompositeClientBridge({ windows: new WindowsHelperDriver(transport, true), authExecutor: auth, credentials: () => ({ username: 'u', secret: 's' }), profile: { profile: 'client-offline', allowOsInput: true, allowScreenCapture: true, allowAuth: true } });
    await bridge.bindWindow(1, 'h'); focused = false;
    await expect(bridge.click('left', 'click-1', Date.now() + 1000)).rejects.toThrow('window-not-usable');
    expect(transport.requests.at(-1)?.command).toBe('releaseOwnedInputs');
    expect(await bridge.authenticate('unknown')).toBe('AUTH_AMBIGUOUS');
    expect(await bridge.authenticate('login')).toBe('AUTH_REQUIRED');
    expect(auth).toHaveBeenCalledOnce();
  });
  it('cleans up owned inputs on shutdown', async () => {
    const transport = new FakeHelperTransport();
    const bridge = new CompositeClientBridge({ windows: new WindowsHelperDriver(transport, true), profile: { profile: 'client-offline', allowOsInput: true } });
    await bridge.shutdown();
    expect(transport.requests.map(request => request.command)).toEqual(['releaseOwnedInputs', 'shutdown']);
    await bridge.shutdown();
  });

  it('never advertises protocol forwarding, which this composite does not implement', () => {
    const protocol = new ProtocolSession('fixture-session');
    const bridge = new CompositeClientBridge({
      protocol,
      profile: { profile: 'client-offline', allowMinecraftUpstream: true },
    });
    expect(bridge.capabilities.protocolObservation).toBe(true);
    expect(bridge.capabilities.protocolForwarding).toBe(false);
    expect(bridge.capabilities.limitations).toContain('protocol-forwarding-unavailable');
  });

  it('never grants real client actions to simulated or unsupported profiles', async () => {
    const protocol = new ProtocolSession('fixture-session');
    const simulated = new CompositeClientBridge({
      protocol,
      windows: new WindowsHelperDriver(new FakeHelperTransport(undefined, { dryRun: false }), true),
      authExecutor: vi.fn(async () => undefined),
      credentials: () => ({ username: 'u', secret: 's' }),
      profile: { profile: 'simulated', allowMinecraftUpstream: true, allowOsInput: true, allowScreenCapture: true, allowAuth: true },
    });
    expect(simulated.capabilities).toMatchObject({
      profile: 'simulated', protocolObservation: true, nativeInput: false, screenCapture: false, windowHealth: false, authentication: false, protocolForwarding: false,
    });
    expect(simulated.capabilities.limitations).toContain('offline-profile-required-for-real-client-actions');
    expect(simulated.capabilities.limitations).toContain('window-health-disabled');
    protocol.observe('position', 'upstream', { x: 1 });
    expect(simulated.observe()).toHaveLength(1);
    expect(simulated.drainObservations().observations).toHaveLength(1);
    await expect(simulated.moveRelative(1, 0, 'm', Date.now() + 1000)).rejects.toThrow('nativeInput-disabled');
    await expect(simulated.captureWindow()).rejects.toThrow('screenCapture-disabled');
    await expect(simulated.authenticate('login')).resolves.toBe('AUTH_AMBIGUOUS');

    expect(() => new CompositeClientBridge({ profile: { profile: 'unsupported' } })).toThrow('unsupported-profile');
  });
});

describe('CompositeClientBridge — driver effective gateway', () => {
  const responder = (request: { requestId: string; command: string; [key: string]: unknown }) => ({
    requestId: request.requestId,
    ok: true,
    result: request.command === 'bindWindow'
      ? { bound: true, pid: request.pid, hwnd: request.hwnd }
      : request.command === 'getWindowState'
        ? { exists: true, focused: true, visible: true, pid: 1, hwnd: 'h' }
        : { accepted: true, source: 'fixture', data: 'fixture', mimeType: 'image/png' },
  });
  const clientProfile = { profile: 'client-offline' as const, allowOsInput: true, allowScreenCapture: true };

  it('does not advertise capabilities when the driver OS-input gate is disabled', async () => {
    const bridge = new CompositeClientBridge({
      windows: new WindowsHelperDriver(new FakeHelperTransport(responder, { dryRun: false }), false),
      profile: clientProfile,
    });
    expect(bridge.capabilities).toMatchObject({ nativeInput: false, screenCapture: false, windowHealth: false, dryRun: false });
    expect(bridge.capabilities.limitations).toEqual(expect.arrayContaining([
      'windows-helper-disabled', 'native-input-disabled', 'screen-capture-disabled', 'window-health-disabled',
    ]));
    await expect(bridge.moveRelative(1, 0, 'm', Date.now() + 1_000)).rejects.toThrow('nativeInput-disabled');
    await expect(bridge.captureWindow()).rejects.toThrow('screenCapture-disabled');
    await bridge.shutdown();
  });

  it('does not advertise screen capture when only the independent capture gate is closed', async () => {
    const bridge = new CompositeClientBridge({
      windows: new WindowsHelperDriver(new FakeHelperTransport(responder, { dryRun: false }), true),
      profile: clientProfile,
    });
    expect(bridge.capabilities).toMatchObject({ nativeInput: true, screenCapture: false, windowHealth: true, dryRun: false });
    expect(bridge.capabilities.limitations).toContain('screen-capture-disabled');
    expect(bridge.capabilities.limitations).not.toContain('windows-helper-dry-run');
    await bridge.bindWindow(1, 'h');
    await expect(bridge.captureWindow()).rejects.toThrow('screenCapture-disabled');
    await bridge.shutdown();
  });

  it('labels dry-run helpers as synthetic instead of advertising real actions', async () => {
    const transport = new FakeHelperTransport(responder); // fake helpers default to dry-run
    const bridge = new CompositeClientBridge({
      windows: new WindowsHelperDriver(transport, true, () => Date.now(), 250, true),
      profile: clientProfile,
    });
    expect(bridge.capabilities).toMatchObject({ nativeInput: false, screenCapture: false, windowHealth: false, dryRun: true });
    expect(bridge.capabilities.limitations).toEqual(expect.arrayContaining([
      'windows-helper-dry-run', 'native-input-synthetic', 'screen-capture-synthetic', 'window-health-synthetic',
    ]));
    await expect(bridge.moveRelative(1, 0, 'm', Date.now() + 1_000)).rejects.toThrow('nativeInput-disabled');
    await bridge.shutdown();
  });

  it('advertises all capabilities when OS input and capture are enabled on a real helper', async () => {
    const bridge = new CompositeClientBridge({
      windows: new WindowsHelperDriver(new FakeHelperTransport(responder, { dryRun: false }), true, () => Date.now(), 250, true),
      profile: clientProfile,
    });
    expect(bridge.capabilities).toMatchObject({ nativeInput: true, screenCapture: true, windowHealth: true, dryRun: false });
    expect(bridge.capabilities.limitations).not.toEqual(expect.arrayContaining([
      'windows-helper-disabled', 'windows-helper-dry-run', 'native-input-disabled', 'screen-capture-disabled',
    ]));
    await bridge.bindWindow(1, 'h');
    await bridge.moveRelative(1, 0, 'm', Date.now() + 1_000);
    await expect(bridge.captureWindow()).resolves.toMatchObject({ source: 'fixture' });
    await bridge.shutdown();
  });
});
