import { describe, expect, it, vi } from 'vitest';
import { CompositeClientBridge, type AuthChallenge } from '../../src/bridge/composite.js';

const NOW = 10_000_000;

function harness(overrides: Partial<AuthChallenge> = {}) {
  const auth = vi.fn(async () => undefined);
  const bridge = new CompositeClientBridge({
    authExecutor: auth,
    credentials: () => ({ username: 'u', secret: 's' }),
    now: () => NOW,
    profile: { profile: 'client-offline', allowAuth: true },
  });
  const challenge: AuthChallenge = {
    kind: 'login',
    sessionEpoch: bridge.identity.connectionEpoch,
    connectionEpoch: bridge.identity.connectionEpoch,
    source: 'server-login-request',
    serverChannel: 'login',
    targetServerId: 'client-offline',
    receivedAt: NOW - 1_000,
    evidenceRef: 'login-prompt:42',
    ...overrides,
  };
  return { auth, bridge, challenge };
}

describe('FEC-21 AuthChallenge provenance', () => {
  it('invokes the executor only for a classified, fresh, matching challenge', async () => {
    const { auth, bridge, challenge } = harness();
    await expect(bridge.authenticate(challenge)).resolves.toBe('AUTH_REQUIRED');
    expect(auth).toHaveBeenCalledOnce();
    expect(auth).toHaveBeenCalledWith({ action: 'login', credential: { username: 'u', secret: 's' } });

    const register = harness({ kind: 'register', source: 'server-register-request', evidenceRef: 'register-prompt:43' });
    await expect(register.bridge.authenticate(register.challenge)).resolves.toBe('AUTH_REQUIRED');
    expect(register.auth).toHaveBeenCalledWith({ action: 'register', credential: { username: 'u', secret: 's' } });

    const operator = harness({ source: 'operator' });
    await expect(operator.bridge.authenticate(operator.challenge)).resolves.toBe('AUTH_REQUIRED');
  });

  it('keeps ordinary/player/server chat out of the credential path', async () => {
    for (const source of ['server-chat', 'player-chat', 'unknown'] as const) {
      const { auth, bridge, challenge } = harness({ source });
      await expect(bridge.authenticate(challenge)).resolves.toBe('AUTH_AMBIGUOUS');
      expect(auth).not.toHaveBeenCalled();
    }
    const { auth, bridge } = harness();
    // Even a keyword-looking label is not a challenge. The method is typed to reject this,
    // but runtime callers must also fail closed.
    await expect(bridge.authenticate('login' as never)).resolves.toBe('AUTH_AMBIGUOUS');
    expect(auth).not.toHaveBeenCalled();
  });

  it('rejects a login prompt source for register and vice versa', async () => {
    const loginAsRegister = harness({ kind: 'register', source: 'server-login-request' });
    await expect(loginAsRegister.bridge.authenticate(loginAsRegister.challenge)).resolves.toBe('AUTH_AMBIGUOUS');
    expect(loginAsRegister.auth).not.toHaveBeenCalled();
    const registerAsLogin = harness({ kind: 'login', source: 'server-register-request' });
    await expect(registerAsLogin.bridge.authenticate(registerAsLogin.challenge)).resolves.toBe('AUTH_AMBIGUOUS');
    expect(registerAsLogin.auth).not.toHaveBeenCalled();
  });

  it('rejects epoch, target and freshness mismatches without invoking the executor', async () => {
    const mismatches: Partial<AuthChallenge>[] = [
      { sessionEpoch: 'other-session' },
      { connectionEpoch: 'other-connection' },
      { targetServerId: 'other-server' },
      { receivedAt: NOW - 300_001 },
      { receivedAt: NOW + 60_000 },
      { evidenceRef: '' },
      { evidenceRef: 'x'.repeat(513) },
      { evidenceRef: 'bad\nreference' },
      { serverChannel: '' },
      { challengeId: 'x'.repeat(257) },
    ];
    for (const mismatch of mismatches) {
      const { auth, bridge, challenge } = harness(mismatch);
      await expect(bridge.authenticate(challenge)).resolves.toBe('AUTH_AMBIGUOUS');
      expect(auth).not.toHaveBeenCalled();
    }
  });

  it('respects an explicit target policy and returns ambiguous when auth is disabled', async () => {
    const auth = vi.fn(async () => undefined);
    const bridge = new CompositeClientBridge({
      authExecutor: auth,
      credentials: () => ({ username: 'u', secret: 's' }),
      now: () => NOW,
      authPolicy: { targetServerId: 'trusted-server' },
      profile: { profile: 'client-offline', allowAuth: true, serverProfileId: 'client-offline' },
    });
    const challenge: AuthChallenge = {
      kind: 'login',
      sessionEpoch: bridge.identity.connectionEpoch,
      connectionEpoch: bridge.identity.connectionEpoch,
      source: 'server-login-request',
      serverChannel: 'login',
      targetServerId: 'client-offline',
      receivedAt: NOW,
      evidenceRef: 'evidence:1',
    };
    await expect(bridge.authenticate(challenge)).resolves.toBe('AUTH_AMBIGUOUS');
    await expect(bridge.authenticate({ ...challenge, targetServerId: 'trusted-server' })).resolves.toBe('AUTH_REQUIRED');
    expect(auth).toHaveBeenCalledOnce();

    const disabled = new CompositeClientBridge({ profile: { profile: 'client-offline', allowAuth: false } });
    const disabledChallenge: AuthChallenge = { ...challenge, sessionEpoch: disabled.identity.connectionEpoch, connectionEpoch: disabled.identity.connectionEpoch };
    await expect(disabled.authenticate(disabledChallenge)).resolves.toBe('AUTH_AMBIGUOUS');
  });
});
