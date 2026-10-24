import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net, { type AddressInfo } from 'node:net';
import { loadProfileConfig, parseProfileConfig } from '../../src/config/profile.js';
import {
  armBridgeService,
  runBridgeCommand,
  runBridgeServiceCommand,
  type BridgeArmSupervisor,
  type BridgeCommandOptions,
  type BridgeServiceChildConfig,
  type BridgeServiceCommandOptions,
} from '../../src/cli/main.js';
import type { BridgeServiceEntryConfig } from '../../src/bridge/service/entry.js';
import type { ChildProcessLike } from '../../src/bridge/supervisor.js';

const dirs: string[] = [];
const tempDirs = () => {
  const dir = mkdtempSync(join(tmpdir(), 'furevercraft-round3-'));
  dirs.push(dir);
  return dir;
};
const writeConfig = (value: unknown): string => {
  const file = join(tempDirs(), 'config.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/**
 * Minimal supervised child used to exercise runBridgeServiceCommand without a real fork.
 * It implements the same hello/response IPC contract and records every request it receives.
 */
type FakeServiceChild = ChildProcessLike & { readonly sent: Array<Record<string, unknown>> };
function fakeServiceChild(status: Record<string, unknown>, shutdownResult: Record<string, unknown> = { stopped: true }): FakeServiceChild {
  const listeners = new Map<string, Array<(value?: unknown) => void>>();
  const sent: Array<Record<string, unknown>> = [];
  const emit = (event: string, value?: unknown) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(value);
  };
  const child: FakeServiceChild = {
    sent,
    send(message: unknown) {
      const request = message as Record<string, unknown>;
      sent.push(request);
      const reply = (value: Record<string, unknown>) => queueMicrotask(() => emit('message', value));
      if (request.type === 'hello') {
        reply({ type: 'hello', protocolVersion: 1, process: 'runtime', sessionEpoch: 'child-epoch', bootEpoch: 'child-boot', capabilities: [] });
      } else if (request.type === 'request') {
        const base = { type: 'response', protocolVersion: 1, requestId: request.requestId, sessionEpoch: 'child-epoch', ok: true };
        if (request.command === 'status') reply({ ...base, result: status });
        else if (request.command === 'shutdown') reply({ ...base, result: shutdownResult });
        else reply({ ...base, result: {} });
      }
      return true;
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return child;
    },
    kill() { queueMicrotask(() => emit('exit')); return true; },
  };
  return child;
}

describe('Round 3 — strict profile config', () => {
  it('rejects misspelled keys and wrong types instead of ignoring them', () => {
    expect(() => parseProfileConfig({ targetProt: 25565 }, 'bridge')).toThrow(/config-key-unused:targetProt/);
    expect(() => parseProfileConfig({ targetPort: '25565' }, 'bridge')).toThrow(/config-invalid:targetPort/);
    expect(() => parseProfileConfig({ allowMinecraftUpstream: 'yes' }, 'bridge')).toThrow(/config-invalid:allowMinecraftUpstream/);
    // Keys recognized by an older surface but never honored are still refused precisely.
    expect(() => parseProfileConfig({ protocolVersion: 777 }, 'bridge')).toThrow(/config-key-unused:protocolVersion/);
  });

  it('rejects keys the selected entrypoint cannot honor', () => {
    expect(() => parseProfileConfig({ allowModelNetwork: false }, 'bridge')).toThrow(/config-key-unused:allowModelNetwork/);
    expect(() => parseProfileConfig({ targetHost: '127.0.0.1' }, 'serve')).toThrow(/config-key-unused:targetHost/);
    expect(() => parseProfileConfig({ allowMinecraftUpstream: false }, 'serve')).toThrow(/config-key-unused:allowMinecraftUpstream/);
    expect(() => parseProfileConfig({
      windowsHelper: { scriptPath: 'helper.ps1', heartbeatIntervalMs: 2000, dryRun: true },
    }, 'bridge')).toThrow(/config-key-unused:windowsHelper/);
    // serve can honor the profile and provider network gate.
    expect(parseProfileConfig({ profile: 'simulated', allowModelNetwork: false }, 'serve')).toEqual({ profile: 'simulated', allowModelNetwork: false });
  });

  it('loads the shipped example configs with only honored keys', () => {
    const bridgeExample = parseProfileConfig(JSON.parse(readFileSync('configs/client-offline.example.json', 'utf8')), 'bridge');
    expect(bridgeExample).toEqual({
      profile: 'client-offline', targetHost: '127.0.0.1', targetPort: 25565, allowMinecraftUpstream: false,
    });
    const simulated = parseProfileConfig(JSON.parse(readFileSync('configs/simulated.json', 'utf8')), 'bridge');
    expect(simulated).toMatchObject({ profile: 'simulated', allowMinecraftUpstream: true });
    // Dedicated fixture config: the explicit gate exists only so fixture mode may start its
    // own loopback echo; it carries no remote target.
    expect(parseProfileConfig(JSON.parse(readFileSync('configs/bridge-fixture.example.json', 'utf8')), 'bridge'))
      .toEqual({ profile: 'simulated', allowMinecraftUpstream: true });
    expect(parseProfileConfig(JSON.parse(readFileSync('configs/serve-offline.example.json', 'utf8')), 'serve'))
      .toEqual({ profile: 'simulated', allowModelNetwork: false });
  });
});

describe('Round 3 — bridge target and gate semantics', () => {
  it('service mode passes the configured target (not a loopback fixture) to the service child', async () => {
    const file = writeConfig({ profile: 'client-offline', targetHost: '127.0.0.1', targetPort: 24_567, allowMinecraftUpstream: true });
    let captured: { config?: BridgeServiceEntryConfig; options?: BridgeServiceCommandOptions } = {};
    const output: unknown[] = [];
    await runBridgeCommand({ config: file, mode: 'service', output: value => output.push(value) }, {
      runService: async (config, options) => {
        captured = { ...(config ? { config } : {}), ...(options ? { options } : {}) };
        return { mode: 'service', source: 'configured-target', target: options?.target, arm: { requested: false, admissionOpen: false } };
      },
    });
    expect(captured.config?.relay).toMatchObject({ targetHost: '127.0.0.1', targetPort: 24_567, allowMinecraftUpstream: true });
    // The service child is told the real loaded profile and the effective network/source
    // instead of being left to report `unspecified` or a fabricated default.
    expect(captured.config).toMatchObject({
      profile: 'client-offline',
      network: 'upstream-explicit',
      source: 'configured-target',
    });
    expect(captured.options).toMatchObject({
      source: 'configured-target',
      target: { host: '127.0.0.1', port: 24_567 },
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ mode: 'service', target: { host: '127.0.0.1', port: 24_567 } });
  });

  it('passes validated listen/handshake settings into the relay child config', async () => {
    const file = writeConfig({
      profile: 'client-offline', targetHost: '127.0.0.1', targetPort: 24_567, allowMinecraftUpstream: true,
      listenHost: '127.0.0.1', listenPort: 0, rewriteHandshake: true,
      handshakeLimitBytes: 4096, handshakeTimeoutMs: 2_500,
    });
    let captured: BridgeServiceEntryConfig | undefined;
    await runBridgeCommand({ config: file, mode: 'service', output: () => undefined }, {
      runService: async config => {
        captured = config;
        return { mode: 'service', source: 'configured-target' };
      },
    });
    // The documented optional relay settings are reachable and reach the real relay child
    // config instead of being silently dropped by the strict loader.
    expect(captured?.relay).toMatchObject({
      listenHost: '127.0.0.1',
      listenPort: 0,
      targetHost: '127.0.0.1',
      targetPort: 24_567,
      rewriteHandshake: true,
      handshakeLimitBytes: 4096,
      handshakeTimeoutMs: 2_500,
    });
  });

  it('rejects invalid listen/handshake settings instead of coercing them', () => {
    expect(() => parseProfileConfig({ rewriteHandshake: 'yes' }, 'bridge')).toThrow(/config-invalid:rewriteHandshake/);
    expect(() => parseProfileConfig({ listenHost: '' }, 'bridge')).toThrow(/config-invalid:listenHost/);
    expect(() => parseProfileConfig({ listenPort: 65_536 }, 'bridge')).toThrow(/config-invalid:listenPort/);
    expect(() => parseProfileConfig({ listenPort: -1 }, 'bridge')).toThrow(/config-invalid:listenPort/);
    expect(() => parseProfileConfig({ handshakeLimitBytes: 0 }, 'bridge')).toThrow(/config-invalid:handshakeLimitBytes/);
    expect(() => parseProfileConfig({ handshakeTimeoutMs: 0 }, 'bridge')).toThrow(/config-invalid:handshakeTimeoutMs/);
    // These keys are bridge-only; serve cannot honor them.
    expect(() => parseProfileConfig({ rewriteHandshake: true }, 'serve')).toThrow(/config-key-unused:rewriteHandshake/);
    expect(() => parseProfileConfig({ listenPort: 25565 }, 'serve')).toThrow(/config-key-unused:listenPort/);
  });

  it('refuses service mode without a configured target', async () => {
    const file = writeConfig({ profile: 'client-offline', allowMinecraftUpstream: true });
    let called = false;
    await expect(runBridgeCommand({ config: file, mode: 'service', output: () => undefined }, {
      runService: async () => { called = true; return {}; },
    })).rejects.toThrow('config-key-missing:targetHost-or-targetPort');
    expect(called).toBe(false);
  });

  it('refuses fixture mode when the upstream gate is false', async () => {
    const file = writeConfig({ profile: 'client-offline', targetHost: '127.0.0.1', targetPort: 25565, allowMinecraftUpstream: false });
    let upstreamRequested = false;
    await expect(runBridgeCommand({ config: file, mode: 'fixture', output: () => undefined }, {
      fixtureUpstream: async () => { upstreamRequested = true; throw new Error('fixture-must-not-start'); },
    })).rejects.toThrow('fixture-mode-requires-explicit-upstream-gate');
    expect(upstreamRequested).toBe(false);
  });

  it('fixture mode uses and reports the loopback fixture target, never the configured real target', async () => {
    // The configured target points somewhere that must never be contacted.
    const file = writeConfig({ profile: 'client-offline', targetHost: '10.255.255.1', targetPort: 25565, allowMinecraftUpstream: true });
    const echo = net.createServer(socket => { socket.on('data', chunk => socket.write(chunk)); });
    await new Promise<void>((resolve, reject) => { echo.once('error', reject); echo.listen(0, '127.0.0.1', resolve); });
    const echoPort = (echo.address() as AddressInfo).port;
    const output: any[] = [];
    try {
      await runBridgeCommand({ config: file, mode: 'fixture', output: value => output.push(value) }, {
        fixtureUpstream: async () => ({ port: echoPort, close: () => new Promise<void>(resolve => echo.close(() => resolve())) }),
      });
    } finally {
      await new Promise<void>(resolve => echo.close(() => resolve()));
    }
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      mode: 'fixture',
      source: 'fixture',
      network: 'loopback-only',
      target: { host: '127.0.0.1', port: echoPort, source: 'loopback-fixture' },
      configuredTarget: { host: '10.255.255.1', port: 25565, used: false },
      scenario: { byteEquality: true },
    });
    expect(output[0].target.port).not.toBe(25565);
  });

  it('ships bridge:fixture with a loopback fixture config and keeps bridge:protocol working', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const configPathOf = (scriptName: string): string => {
      const script = pkg.scripts[scriptName];
      expect(script).toBeDefined();
      const match = /--config\s+(\S+)/.exec(script!);
      expect(match).not.toBeNull();
      return match![1]!;
    };

    const fixtureConfigPath = configPathOf('bridge:fixture');
    const protocolConfigPath = configPathOf('bridge:protocol');
    expect(fixtureConfigPath).toBe('configs/bridge-fixture.example.json');
    // The script's config loads through the same strict bridge loader and has no remote
    // target: the true gate can only authorize fixture mode's own loopback echo.
    expect(loadProfileConfig(join(root, fixtureConfigPath), 'bridge'))
      .toEqual({ profile: 'simulated', allowMinecraftUpstream: true });
    expect(loadProfileConfig(join(root, protocolConfigPath), 'bridge'))
      .toMatchObject({ profile: 'simulated', allowMinecraftUpstream: true });

    const echo = net.createServer(socket => { socket.on('data', chunk => socket.write(chunk)); });
    await new Promise<void>((resolve, reject) => { echo.once('error', reject); echo.listen(0, '127.0.0.1', resolve); });
    const echoPort = (echo.address() as AddressInfo).port;
    const runFixture = async (configPath: string) => {
      const output: any[] = [];
      await runBridgeCommand({ config: join(root, configPath), mode: 'fixture', output: value => output.push(value) }, {
        fixtureUpstream: async () => ({ port: echoPort, close: async () => { /* closed below */ } }),
      });
      return output[0];
    };
    try {
      const fixtureOutput = await runFixture(fixtureConfigPath);
      expect(fixtureOutput).toMatchObject({
        mode: 'fixture', source: 'fixture', network: 'loopback-only',
        target: { host: '127.0.0.1', port: echoPort, source: 'loopback-fixture' },
        config: { allowMinecraftUpstream: true, profile: 'simulated' },
      });
      const protocolOutput = await runFixture(protocolConfigPath);
      expect(protocolOutput).toMatchObject({ mode: 'fixture', source: 'fixture', network: 'loopback-only' });
    } finally {
      await new Promise<void>(resolve => echo.close(() => resolve()));
    }

    // A false gate still refuses fixture mode, so the shipped fixture config is not a
    // blanket gate bypass.
    const falseGate = writeConfig({ profile: 'simulated', allowMinecraftUpstream: false });
    await expect(runBridgeCommand({ config: falseGate, mode: 'fixture', output: () => undefined }))
      .rejects.toThrow('fixture-mode-requires-explicit-upstream-gate');
  });
});

describe('Round 3 — explicit arming and truthful reporting', () => {
  it('sends arm only when requested and reports the resulting admission state', async () => {
    const calls: string[] = [];
    let admissionOpen = false;
    const supervisor: BridgeArmSupervisor = {
      async request<T = unknown>(command: string): Promise<T> {
        calls.push(command);
        if (command === 'arm') { admissionOpen = true; return { armed: true } as T; }
        if (command === 'status') return { admissionOpen } as T;
        throw new Error(`unexpected-command:${command}`);
      },
    };

    expect(await armBridgeService(supervisor, false)).toEqual({ requested: false, admissionOpen: false });
    expect(calls).toEqual([]);
    expect(admissionOpen).toBe(false);

    const armed = await armBridgeService(supervisor, true);
    expect(calls).toEqual(['arm', 'status']);
    expect(armed).toMatchObject({ requested: true, admissionOpen: true, result: { armed: true } });
  });

  it('reports a failed arm request without claiming admission opened', async () => {
    const report = await armBridgeService({
      async request<T = unknown>(command: string): Promise<T> {
        if (command === 'arm') throw new Error('ipc-command-not-allowed');
        return { admissionOpen: false } as T;
      },
    }, true);
    expect(report).toMatchObject({ requested: true, admissionOpen: false, error: 'ipc-command-not-allowed' });
  });

  it('refuses --arm outside service mode', async () => {
    const file = writeConfig({ profile: 'client-offline', allowMinecraftUpstream: true });
    await expect(runBridgeCommand({ config: file, mode: 'fixture', arm: true, output: () => undefined }))
      .rejects.toThrow('arm-requires-service-mode');
  });
});

describe('Round 3 — bridge service child config and readiness guard', () => {
  const relay = {
    listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort: 24_567,
    allowMinecraftUpstream: true, heartbeatMs: 60,
  };

  it('forwards the real caller-supplied profile/network/source into the child config', async () => {
    const captured: BridgeServiceChildConfig[] = [];
    const result = await runBridgeServiceCommand({ relay, profile: 'client-offline' }, {
      network: 'upstream-explicit',
      source: 'configured-target',
      spawn: config => {
        captured.push(config);
        return fakeServiceChild({ state: 'running', admissionOpen: false });
      },
    });
    expect(captured[0]).toMatchObject({
      profile: 'client-offline',
      network: 'upstream-explicit',
      source: 'configured-target',
    });
    // The relay target is still the caller's real target, not a synthesized one.
    expect(captured[0]?.relay).toMatchObject({ targetHost: '127.0.0.1', targetPort: 24_567 });
    expect(result.status).toMatchObject({ state: 'running' });
  });

  it('does not invent a profile or network when the caller supplied none', async () => {
    const captured: BridgeServiceChildConfig[] = [];
    await runBridgeServiceCommand({ relay }, {
      spawn: config => {
        captured.push(config);
        return fakeServiceChild({ state: 'running' });
      },
    });
    const childConfig = captured[0];
    expect(childConfig).toBeDefined();
    expect(childConfig).not.toHaveProperty('profile');
    expect(childConfig).not.toHaveProperty('network');
    expect(childConfig).not.toHaveProperty('source');
    expect(JSON.stringify(childConfig)).not.toContain('client-offline');
    expect(JSON.stringify(childConfig)).not.toContain('disabled');
  });

  it('surfaces a failed shutdown instead of reporting a clean stop', async () => {
    const child = fakeServiceChild({ state: 'running' }, { stopped: false, error: 'relay-stop-failed:close-error', forced: true });
    const result = await runBridgeServiceCommand({ relay }, { spawn: () => child });
    expect(result.shutdown).toMatchObject({ stopped: false, error: 'relay-stop-failed:close-error', forced: true });
  });

  it('rejects instead of returning a normal result when the final status never becomes usable', async () => {
    const child = fakeServiceChild({ state: 'failed' });
    await expect(runBridgeServiceCommand({ relay }, { spawn: () => child }))
      .rejects.toThrow('bridge-service-not-ready:failed');
    // The bounded wait still requested shutdown; the failure is reported after cleanup.
    expect(child.sent.some(message => message.type === 'request' && message.command === 'shutdown')).toBe(true);
  }, 10_000);

  it('continues to accept a degraded final state as a successful start', async () => {
    const result = await runBridgeServiceCommand({ relay }, { spawn: () => fakeServiceChild({ state: 'degraded' }) });
    expect(result).toMatchObject({ mode: 'service', status: { state: 'degraded' } });
  });
});

describe('Round 3 — Node/CI requirements', () => {
  it('declares the documented Node 22 requirement and builds before the Windows dist-dependent run', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { engines?: { node?: string } };
    expect(pkg.engines).toEqual({ node: '>=22' });

    const workflow = readFileSync(join(root, '.github/workflows/offline.yml'), 'utf8');
    const windowsJob = workflow.slice(workflow.indexOf('windows-static:'));
    expect(windowsJob).not.toBe('');
    const buildAt = windowsJob.indexOf('npm run build');
    const testAt = windowsJob.indexOf('npm run test:offline');
    expect(buildAt).toBeGreaterThan(-1);
    expect(testAt).toBeGreaterThan(-1);
    expect(buildAt).toBeLessThan(testAt);
  });
});
