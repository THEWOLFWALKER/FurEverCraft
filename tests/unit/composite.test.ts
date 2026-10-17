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
      ? { requestId: request.requestId, ok: true, result: { exists: true, focused: true, visible: true } }
      : { requestId: request.requestId, ok: true, result: { command: request.command } });
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
      ? { requestId: request.requestId, ok: true, result: { focused, visible: true } }
      : { requestId: request.requestId, ok: true, result: { mimeType: 'image/png', data: 'fixture' } });
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
});
