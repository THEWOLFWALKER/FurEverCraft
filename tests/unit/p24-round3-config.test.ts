import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net, { type AddressInfo } from 'node:net';
import { parseProfileConfig } from '../../src/config/profile.js';
import {
  armBridgeService,
  runBridgeCommand,
  type BridgeArmSupervisor,
  type BridgeCommandOptions,
  type BridgeServiceCommandOptions,
} from '../../src/cli/main.js';
import type { BridgeServiceEntryConfig } from '../../src/bridge/service/entry.js';

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
    expect(captured.options).toMatchObject({
      source: 'configured-target',
      target: { host: '127.0.0.1', port: 24_567 },
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ mode: 'service', target: { host: '127.0.0.1', port: 24_567 } });
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
