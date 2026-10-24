import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../../src/execution/factory.js';
import { RuntimeOwnershipLock } from '../../src/execution/ownership.js';
import { SQLiteStore } from '../../src/persistence/store.js';
import { createControlServer, generatePairingCode } from '../../src/server/index.js';
import {
  buildServeStartupDocument,
  resolveServePairingCode,
  runAttach,
  runDemo,
  runEventsCommand,
  runGoalReviseCommand,
  runStatusCommand,
} from '../../src/cli/main.js';
import { minimalChildEnvironment, spawnRelayProcess } from '../../src/bridge/relay/spawn.js';
import { spawnBridgeServiceProcess } from '../../src/bridge/service/spawn.js';
import { redact } from '../../src/diagnostics/redaction.js';
import type { ChildProcessLike } from '../../src/bridge/supervisor.js';
import type { RelayEntryConfig } from '../../src/bridge/relay/entry.js';
import type { BridgeServiceEntryConfig } from '../../src/bridge/service/entry.js';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'furevercraft-round3-cli-security-'));
  dirs.push(dir);
  return dir;
};
const tempDb = () => join(tempDir(), 'state.sqlite');
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedDatabase(db: string) {
  const store = new SQLiteStore(db);
  try {
    store.saveGoal({ goalId: 'g1', revision: 1, status: 'active', text: 'initial' });
    store.addCriticalEvent({ seq: '1', eventId: 'event_1', kind: 'goal.set', context: { serverProfileId: 'simulated' }, payload: { ok: true } });
  } finally {
    store.close();
  }
}

/** Split a CLI output stream into JSON documents; every command prints exactly one line. */
function jsonLines(stream: NodeJS.ReadableStream) {
  const queued: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const parsed = JSON.parse(line) as unknown;
      const waiter = waiters.shift();
      if (waiter) waiter(parsed); else queued.push(parsed);
    }
  });
  return (): Promise<unknown> => queued.length ? Promise.resolve(queued.shift()) : new Promise(resolve => waiters.push(resolve));
}

describe('Round 3 — CLI utility commands respect the single owner', () => {
  it('fails closed while another owner holds the database lock', async () => {
    const db = tempDb();
    seedDatabase(db);
    const owner = new RuntimeOwnershipLock(db);
    owner.acquire();
    try {
      expect(() => runStatusCommand({ db })).toThrow(/^runtime-control-owned:/);
      expect(() => runEventsCommand({ db })).toThrow(/^runtime-control-owned:/);
      expect(() => runGoalReviseCommand({ db, id: 'g1', revision: 1, change: 'changed' })).toThrow(/^runtime-control-owned:/);
      await expect(runDemo(db, 'autonomous')).rejects.toThrow(/^runtime-control-owned:/);
    } finally {
      owner.release();
    }
    // The refused mutating command left the durable goal untouched.
    const store = new SQLiteStore(db);
    try {
      expect(store.getGoal('g1')).toMatchObject({ revision: 1, spec: { text: 'initial' } });
    } finally {
      store.close();
    }
  });

  it('reads durable status and events read-only instead of inventing a simulated runtime', () => {
    const db = tempDb();
    seedDatabase(db);

    const status = runStatusCommand({ db });
    expect(status).toMatchObject({ source: 'sqlite', mode: 'read-only', liveSession: false, state: 'active' });
    expect(status).not.toHaveProperty('simulated');
    expect(status.goals).toHaveLength(1);
    expect(status.goals[0]).toMatchObject({ goal_id: 'g1', revision: 1, spec: { text: 'initial' } });

    const events = runEventsCommand({ db, cursor: '0', limit: 10 });
    expect(events).toMatchObject({ source: 'sqlite', mode: 'read-only', retainedLiveEvents: false, gap: false, next: '1' });
    expect(events.events).toEqual([expect.objectContaining({ seq: '1', eventId: 'event_1', kind: 'goal.set', durable: true })]);

    // Both readers release their ownership record after opening the store read-only.
    const probe = new RuntimeOwnershipLock(db);
    probe.acquire();
    expect(probe.release()).toBe(true);
  });

  it('requires a persistent database for direct reads instead of reporting an empty fake view', () => {
    expect(() => runStatusCommand({ db: ':memory:' })).toThrow('runtime-database-required');
    const dir = tempDir();
    expect(() => runEventsCommand({ db: join(dir, 'missing.sqlite') })).toThrow(/^runtime-database-not-found:/);
  });

  it('owns the store while goal:revise mutates it and releases the lock afterwards', () => {
    const db = tempDb();
    seedDatabase(db);
    const revised = runGoalReviseCommand({ db, id: 'g1', revision: 1, change: 'revised' });
    expect(revised).toMatchObject({ revision: 2, spec: { text: 'revised' } });
    const probe = new RuntimeOwnershipLock(db);
    probe.acquire();
    expect(probe.release()).toBe(true);
  });

  it('does not delete a scenario database owned by another runtime', async () => {
    const db = tempDb();
    const scenarioDb = `${db}.0`;
    seedDatabase(scenarioDb);
    const owner = new RuntimeOwnershipLock(scenarioDb);
    owner.acquire();
    try {
      await expect(runDemo(db, 'autonomous')).rejects.toThrow(/^runtime-control-owned:/);
    } finally {
      owner.release();
    }
    const store = new SQLiteStore(scenarioDb);
    try {
      expect(store.getGoal('g1')).toMatchObject({ revision: 1, spec: { text: 'initial' } });
    } finally {
      store.close();
    }
  });

  it('runs the simulated demo under the ownership lock and releases it', async () => {
    const db = tempDb();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const document = await runDemo(db, 'autonomous');
      expect(document).toMatchObject({ simulated: true, summary: { count: 1, names: ['autonomous'] } });
      expect(document.scenarios[0]).toMatchObject({ scenario: 'autonomous', outcome: 'completed' });
    } finally {
      log.mockRestore();
    }
    const probe = new RuntimeOwnershipLock(db);
    probe.acquire();
    expect(probe.release()).toBe(true);
  });

  it('keeps the HTTP-attached ControlService path usable while the Runtime owns the lock', async () => {
    const db = tempDb();
    const runtime = createRuntime({ db });
    const server = createControlServer(runtime, { pollMs: 10, heartbeatMs: 60_000 });
    const input = new PassThrough();
    const output = new PassThrough();
    const next = jsonLines(output);
    let attach: Promise<void> | undefined;
    try {
      await server.listen({ port: 0, host: '127.0.0.1' });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('server-address-unavailable');
      attach = runAttach(`http://127.0.0.1:${address.port}`, { input, output }, { subscribe: false });

      // A direct utility command must see the serving Runtime's ownership lock and refuse.
      expect(() => runStatusCommand({ db })).toThrow(/^runtime-control-owned:/);

      input.write('goal set g1 first\n');
      expect(await next()).toMatchObject({ command: 'goal.set', state: 'terminal' });
      input.write('goal revise g1 1 revised\n');
      const revised = await next();
      expect(revised).toMatchObject({ command: 'goal.revise', state: 'terminal', result: { revision: 2, spec: { text: 'revised' } } });
      input.write('status\n');
      expect((await next())).toHaveProperty('state');
      expect(runtime.store.getGoal('g1')?.revision).toBe(2);

      input.write('quit\n');
      expect(await next()).toMatchObject({ quit: true });
      await attach;
    } finally {
      input.destroy();
      await attach?.catch(() => undefined);
      await server.close();
      runtime.close();
    }
  }, 20_000);
});

describe('Round 3 — child processes receive a minimal environment', () => {
  const relayConfig: RelayEntryConfig = {
    listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort: 1,
    allowMinecraftUpstream: true, heartbeatMs: 50,
  };
  const serviceConfig: BridgeServiceEntryConfig = {
    relay: relayConfig, observer: { enabled: true }, shutdownGraceMs: 1_000, helloTimeoutMs: 5_000,
  };

  function envEntry(dir: string): URL {
    const file = join(dir, 'env-report.mjs');
    writeFileSync(file, "process.send({ env: process.env }, () => process.exit(0));\nsetTimeout(() => process.exit(0), 1000).unref();\n");
    return pathToFileURL(file);
  }

  function childEnvironment(child: ChildProcessLike): Promise<NodeJS.ProcessEnv> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | undefined, value?: NodeJS.ProcessEnv) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value!);
      };
      const timer = setTimeout(() => finish(new Error('child-environment-timeout')), 5_000);
      child.on('message', message => {
        const env = (message as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        if (env && typeof env === 'object') finish(undefined, env);
      });
      child.on('error', error => finish(error instanceof Error ? error : new Error(String(error))));
      child.on('exit', () => finish(new Error('child-exited-without-environment')));
    });
  }

  it('does not inherit CLI, pairing or provider secrets', async () => {
    const sentinels = {
      MINECRAFT_AGENT_CLI_TOKEN: 'sentinel-cli-token',
      MINECRAFT_AGENT_PAIRING_CODE: 'sentinel-pairing-code',
      OPENAI_API_KEY: 'sentinel-openai-key',
      ANTHROPIC_API_KEY: 'sentinel-anthropic-key',
      FUREVERCRAFT_UNRELATED_SECRET: 'sentinel-unrelated-secret',
    };
    for (const [key, value] of Object.entries(sentinels)) vi.stubEnv(key, value);
    vi.stubEnv('NODE_OPTIONS', '--no-warnings');
    const entry = envEntry(tempDir());

    const relay = spawnRelayProcess(relayConfig, {
      entryUrl: entry,
      env: { PATH: process.env.PATH, MINECRAFT_AGENT_PAIRING_CODE: 'smuggled-pairing-code' },
    });
    try {
      const env = await childEnvironment(relay);
      const serialized = JSON.stringify(env);
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.NODE_OPTIONS).toBe('--no-warnings');
      expect(JSON.parse(String(env.FUREVERCRAFT_RELAY_CONFIG))).toEqual(relayConfig);
      expect(env.FUREVERCRAFT_SERVICE_CONFIG).toBeUndefined();
      for (const secret of [...Object.values(sentinels), 'smuggled-pairing-code']) expect(serialized).not.toContain(secret);
    } finally {
      relay.kill('SIGKILL');
    }

    const service = spawnBridgeServiceProcess(serviceConfig, { entryUrl: entry });
    try {
      const env = await childEnvironment(service);
      const serialized = JSON.stringify(env);
      expect(JSON.parse(String(env.FUREVERCRAFT_SERVICE_CONFIG))).toEqual(serviceConfig);
      expect(env.FUREVERCRAFT_RELAY_CONFIG).toBeUndefined();
      for (const secret of Object.values(sentinels)) expect(serialized).not.toContain(secret);
    } finally {
      service.kill('SIGKILL');
    }
  }, 20_000);

  it('exposes the allowlist helper without accepting arbitrary overrides', () => {
    const environment = minimalChildEnvironment({
      PATH: '/allowlisted-path',
      MINECRAFT_AGENT_CLI_TOKEN: 'must-not-cross',
      FUREVERCRAFT_RELAY_CONFIG: '{"must":"not-cross"}',
    });
    expect(environment).toEqual({ PATH: '/allowlisted-path' });
  });
});

describe('Round 3 — redaction covers pairing and session identifiers', () => {
  it('redacts pairing/session keys but leaves ordinary session state readable', () => {
    expect(redact({
      pairingCode: 'pair-123',
      pairCode: 'pair-456',
      pairing_code: 'pair-789',
      sessionId: 'session-123',
      session_id: 'session-456',
      session: { state: 'idle' },
      pairing: true,
      code: 'visible',
    })).toEqual({
      pairingCode: '[REDACTED]',
      pairCode: '[REDACTED]',
      pairing_code: '[REDACTED]',
      sessionId: '[REDACTED]',
      session_id: '[REDACTED]',
      session: { state: 'idle' },
      pairing: true,
      code: 'visible',
    });
  });

  it('redacts pairing/session assignments inside diagnostic text', () => {
    const redacted = redact('pairingCode=pair-123 sessionId=session-123');
    expect(redacted).toBe('pairingCode=[REDACTED] sessionId=[REDACTED]');
    expect(String(redacted)).not.toContain('pair-123');
    expect(String(redacted)).not.toContain('session-123');
  });
});

describe('Round 3 — generated pairing codes never reach non-TTY startup output', () => {
  const fields = { url: 'http://127.0.0.1:3000', profile: 'simulated', db: '/tmp/state.sqlite', pairing: true };

  it('requires an explicit code when stdout is not a TTY', () => {
    expect(() => resolveServePairingCode({ pairing: true, isTty: false })).toThrow('pairing-code-required:non-tty');
    expect(resolveServePairingCode({ pairing: true, explicit: 'explicit-code', isTty: false }))
      .toEqual({ pairingCode: 'explicit-code', generated: false });
    expect(resolveServePairingCode({ pairing: false, isTty: false })).toEqual({ generated: false });
    expect(resolveServePairingCode({ pairing: true, isTty: true, generate: () => 'generated-code' }))
      .toEqual({ pairingCode: 'generated-code', generated: true });
  });

  it('omits a generated code from non-TTY output and only discloses it to a TTY', () => {
    const nonTty = buildServeStartupDocument(fields, { generatedPairingCode: 'generated-pair-secret', isTty: false });
    expect(nonTty).not.toContain('generated-pair-secret');
    expect(JSON.parse(nonTty)).not.toHaveProperty('pairingCode');
    expect(JSON.parse(nonTty)).toMatchObject({ listening: fields.url, pairing: true, cliAccess: 'pair-with-code' });

    const tty = JSON.parse(buildServeStartupDocument(fields, { generatedPairingCode: 'generated-pair-secret', isTty: true })) as Record<string, unknown>;
    expect(tty.pairingCode).toBe('generated-pair-secret');
  });

  it('generates 128-bit pairing codes from both the CLI and server paths and they are accepted', async () => {
    // 32 hex characters is 128 bits of CSPRNG output, not the previous 4 random bytes (32 bits).
    const cliCodes = Array.from({ length: 4 }, () => resolveServePairingCode({ pairing: true, isTty: true }).pairingCode!);
    const serverCodes = Array.from({ length: 4 }, () => generatePairingCode());
    for (const code of [...cliCodes, ...serverCodes]) {
      expect(code).toMatch(/^[0-9a-f]{32}$/);
      expect(Buffer.from(code, 'hex')).toHaveLength(16);
    }
    expect(new Set([...cliCodes, ...serverCodes]).size).toBe(8);

    // Both generators produce credentials the server actually accepts.
    for (const code of [cliCodes[0]!, serverCodes[0]!]) {
      const runtime = createRuntime();
      const server = createControlServer(runtime, { pairing: true, pairingCode: code });
      try {
        await server.listen({ port: 0, host: '127.0.0.1' });
        const address = server.server.address();
        if (!address || typeof address === 'string') throw new Error('server-address-unavailable');
        const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/pair`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ paired: true });
      } finally {
        await server.close();
        runtime.close();
      }
    }
  });
});
