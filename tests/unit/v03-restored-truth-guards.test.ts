import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterManifestSchema,
  capabilityMatrix,
  generateAdapterManifest,
  resolveArtifactPath,
  sha256File,
  verifyAdapterManifest,
  type AdapterManifest,
  type ManifestInput,
  type ManifestVerification,
} from '../../src/bridge/adapter/manifest.js';
import {
  describeBridgeServiceCapabilities,
  serviceCommandReply,
  type BridgeServiceEntryConfig,
} from '../../src/bridge/service/entry.js';
import { IpcRequestSchema } from '../../src/bridge/ipc/protocol.js';
import { BridgeService, type ObserverMonitor } from '../../src/bridge/service/orchestrator.js';
import { minimalChildEnvironment } from '../../src/bridge/relay/spawn.js';
import { readFileSync } from 'node:fs';
import { runDemo } from '../../src/cli/main.js';

/**
 * Regression coverage for truthfulness guards that the v0.3 workspace dropped on top of the
 * completed v0.2 (P01–P24) build. Each test pins the invariant restored from the v0.2
 * reference (`git show v0.2-p24-closeout-11173a5:<path>`). Fixtures are real temporary files;
 * nothing here touches a network, model, input device or the OS.
 */

const TARGET = { release: '1.20.4', protocolVersion: 765, dataVersion: 3700 };
const schemaPath = 'adapter/schema.json';
const dataPath = 'adapter/data.json';
const nativePath = 'adapter/native.bin';
const versionPath = 'node_modules/minecraft-data/minecraft-data/data/pc/1.20.4/version.json';
const cataloguePath = 'node_modules/minecraft-data/minecraft-data/data/pc/common/protocolVersions.json';

type Root = { root: string; outside: string; cleanup: () => void };

function makeRoot(): Root {
  const root = mkdtempSync(join(tmpdir(), 'furevercraft-restored-guards-'));
  const outside = mkdtempSync(join(tmpdir(), 'furevercraft-restored-guards-outside-'));
  mkdirSync(join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', '1.20.4'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', 'common'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'minecraft-protocol'), { recursive: true });
  mkdirSync(join(root, 'adapter'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'minecraft-data', 'package.json'), JSON.stringify({ name: 'minecraft-data', version: '3.87.0' }));
  writeFileSync(join(root, 'node_modules', 'minecraft-protocol', 'package.json'), JSON.stringify({ name: 'minecraft-protocol', version: '1.57.0' }));
  writeFileSync(join(root, versionPath), JSON.stringify({ minecraftVersion: '1.20.4', version: 765 }));
  writeFileSync(join(root, cataloguePath), JSON.stringify([{ minecraftVersion: '1.20.4', version: 765, dataVersion: 3700 }]));
  writeFileSync(join(root, schemaPath), '{"packets":{}}');
  writeFileSync(join(root, nativePath), 'native-fixture');
  writeFileSync(join(root, dataPath), JSON.stringify({ release: '1.20.4', protocolVersion: 765, dataVersion: 3700 }));
  writeFileSync(join(outside, 'escaped.bin'), 'outside-root');
  return { root, outside, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); } };
}

function buildManifest(root: string, overrides: Partial<ManifestInput> = {}): AdapterManifest {
  const input: ManifestInput = {
    rootDir: root,
    release: '1.20.4',
    protocolVersion: 765,
    dataVersion: 3700,
    javaRequirement: '17',
    inputBackend: 'SDL3',
    adapterVersion: 'restored-guards-adapter',
    status: 'verified-fixture',
    dependencies: [
      { name: 'minecraft-data', version: '3.87.0', installed: true },
      { name: 'minecraft-protocol', version: '1.57.0', installed: true },
    ],
    provenance: {
      schema: { kind: 'schema', source: schemaPath, version: '1', sha256: sha256File(join(root, schemaPath)).sha256, verified: true, notes: [] },
      data: { kind: 'data', source: dataPath, version: '1.20.4', sha256: sha256File(join(root, dataPath)).sha256, verified: true, notes: [] },
      native: { kind: 'native', source: nativePath, version: 'fixture', sha256: sha256File(join(root, nativePath)).sha256, verified: true, notes: [] },
    },
    artifacts: [
      { path: schemaPath, role: 'schema' },
      { path: dataPath, role: 'data' },
      { path: nativePath, role: 'native' },
    ],
    capabilities: [
      { domain: 'framing', status: 'verified-fixture', evidence: 'fixture', limitations: [] },
      { domain: 'blocks', status: 'unsupported', evidence: 'none', limitations: ['no-schema'] },
    ],
    ...overrides,
  };
  return generateAdapterManifest(input);
}

const verify = (manifest: AdapterManifest, root: string): ManifestVerification =>
  verifyAdapterManifest(manifest, { rootDir: root, expected: TARGET });

describe('G12 — adapter manifest verification checks content, not declarations', () => {
  it('requires an explicit expected target instead of accepting a bare rootDir', () => {
    const { root, cleanup } = makeRoot();
    try {
      // A JavaScript caller can omit `expected`; the verifier must fail closed, not skip checks.
      const result = verifyAdapterManifest(buildManifest(root), { rootDir: root } as unknown as { rootDir: string; expected: typeof TARGET });
      expect(result.ok).toBe(false);
      expect(result.available).toBe(false);
      expect(result.issues.some(issue => issue.code === 'expected-target-required')).toBe(true);
    } finally { cleanup(); }
  });

  it('requires schema, data and native artifacts rather than trusting provenance alone', () => {
    const { root, cleanup } = makeRoot();
    try {
      const manifest = buildManifest(root);
      manifest.artifacts = manifest.artifacts.filter(artifact => artifact.role !== 'data');
      const result = verify(manifest, root);
      expect(result.ok).toBe(false);
      expect(result.issues).toContainEqual(expect.objectContaining({ code: 'artifact-role-missing', path: 'artifacts.data' }));
    } finally { cleanup(); }
  });

  it('re-hashes every declared provenance hash against the installed bytes', () => {
    const { root, cleanup } = makeRoot();
    try {
      const manifest = buildManifest(root);
      manifest.provenance.schema = { ...manifest.provenance.schema, sha256: 'b'.repeat(64) };
      const result = verify(manifest, root);
      expect(result.ok).toBe(false);
      expect(result.issues.some(issue => issue.code === 'provenance-hash-mismatch' && issue.path === 'provenance.schema.sha256')).toBe(true);
    } finally { cleanup(); }
  });

  it('contradict-checks the data artifact own parsed identity against the target', () => {
    const { root, cleanup } = makeRoot();
    try {
      writeFileSync(join(root, dataPath), JSON.stringify({ release: '1.20.4', protocolVersion: 766, dataVersion: 3701 }));
      const result = verify(buildManifest(root), root);
      expect(result.ok).toBe(false);
      expect(result.issues.some(issue => issue.code === 'data-protocol-version-mismatch')).toBe(true);
      expect(result.issues.some(issue => issue.code === 'data-data-version-mismatch')).toBe(true);
    } finally { cleanup(); }
  });

  it('rejects a data artifact that omits its data version rather than accepting existence', () => {
    const { root, cleanup } = makeRoot();
    try {
      writeFileSync(join(root, dataPath), JSON.stringify({ release: '1.20.4', protocolVersion: 765 }));
      const result = verify(buildManifest(root), root);
      expect(result.ok).toBe(false);
      expect(result.issues.some(issue => issue.code === 'data-data-version-missing')).toBe(true);
    } finally { cleanup(); }
  });

  it('rejects a capability whose evidence contradicts its status at the schema boundary', () => {
    const { root, cleanup } = makeRoot();
    try {
      const manifest = buildManifest(root);
      const contradictory = {
        ...manifest,
        capabilities: [{ domain: 'framing', status: 'verified-fixture' as const, evidence: 'synthetic' as const, limitations: [] }],
      };
      // `verified-fixture` backed by `synthetic` data is a contradiction, not a capability.
      expect(AdapterManifestSchema.safeParse(contradictory).success).toBe(false);
      const result = verifyAdapterManifest(contradictory, { rootDir: root, expected: TARGET });
      expect(result.ok).toBe(false);
      expect(result.issues.some(issue => issue.code === 'invalid-schema')).toBe(true);
    } finally { cleanup(); }
  });

  it('rejects absolute, `../` escaping and symlink-escaping artifact paths at generation time', () => {
    const { root, cleanup } = makeRoot();
    try {
      expect(() => buildManifest(root, { artifacts: [{ path: join(root, schemaPath), role: 'schema' }] })).toThrow('invalid-artifact-path:absolute-path');
      expect(() => buildManifest(root, { artifacts: [{ path: '../escaped.bin', role: 'schema' }] })).toThrow('invalid-artifact-path:outside-root');
    } finally { cleanup(); }
  });

  it('reports invalid-artifact-path for absolute, escaping and symlink artifacts at verification time', () => {
    const { root, outside, cleanup } = makeRoot();
    try {
      const absoluteManifest = buildManifest(root);
      absoluteManifest.artifacts.find(artifact => artifact.role === 'schema')!.path = join(root, schemaPath);
      expect(verify(absoluteManifest, root).issues.some(issue => issue.code === 'invalid-artifact-path')).toBe(true);

      const escapingManifest = buildManifest(root);
      escapingManifest.artifacts.find(artifact => artifact.role === 'schema')!.path = '../escaped.bin';
      expect(verify(escapingManifest, root).issues.some(issue => issue.code === 'invalid-artifact-path')).toBe(true);

      symlinkSync(join(outside, 'escaped.bin'), join(root, 'adapter', 'linked.bin'));
      const symlinkManifest = buildManifest(root);
      symlinkManifest.artifacts.find(artifact => artifact.role === 'schema')!.path = 'adapter/linked.bin';
      const symlinkResult = verify(symlinkManifest, root);
      expect(symlinkResult.ok).toBe(false);
      expect(symlinkResult.issues).toContainEqual(expect.objectContaining({
        code: 'invalid-artifact-path', path: 'adapter/linked.bin', message: 'artifact path is symlink-outside-root',
      }));

      // The resolver itself is the boundary: an absolute Windows drive path is not a relative one.
      expect(resolveArtifactPath(root, 'C:\\windows\\system32\\config').ok).toBe(false);
      expect(resolveArtifactPath(root, schemaPath)).toMatchObject({ ok: true, path: schemaPath });
    } finally { cleanup(); }
  });

  it('never reports an all-unsupported capability matrix as available and requires a verification result', () => {
    const { root, cleanup } = makeRoot();
    try {
      const manifest = buildManifest(root, {
        capabilities: [
          { domain: 'framing', status: 'unsupported', evidence: 'none', limitations: ['no-codec'] },
          { domain: 'blocks', status: 'unsupported', evidence: 'none', limitations: ['no-codec'] },
        ],
      });
      const result = verify(manifest, root);
      expect(result.ok).toBe(false);
      expect(result.available).toBe(false);
      expect(result.issues.some(issue => issue.code === 'capability-matrix-all-unsupported')).toBe(true);
      // Even a forged verification object cannot force the public matrix available.
      const forged = capabilityMatrix(manifest, { ...result, ok: true, available: true });
      expect(forged.available).toBe(false);
      expect(forged.counts).toEqual({ 'verified-fixture': 0, experimental: 0, unsupported: 2 });

      const unverifiedMatrix = capabilityMatrix as unknown as (value: AdapterManifest) => unknown;
      expect(() => unverifiedMatrix(manifest)).toThrow('capability-matrix-requires-verification');
    } finally { cleanup(); }
  });
});

describe('G13 — bridge service hello and capabilities reply are truthful', () => {
  const serviceConfig: BridgeServiceEntryConfig = {
    relay: {
      listenHost: '127.0.0.1', listenPort: 0, targetHost: '10.20.30.40', targetPort: 25_565,
      allowMinecraftUpstream: true, rewriteHandshake: true, heartbeatMs: 50,
    },
    observer: { enabled: true },
    profile: 'client-offline',
    network: 'upstream-explicit',
  };

  const observer: ObserverMonitor = { start: () => undefined, stop: async () => undefined, state: () => ({ running: true }) };

  it('reports the real configured profile, network and target instead of hardcoded values', () => {
    const service = new BridgeService();
    const reply = serviceCommandReply(IpcRequestSchema.parse({ type: 'request', protocolVersion: 1, requestId: 'r1', sessionEpoch: 'epoch', command: 'capabilities', payload: {} }), { sessionEpoch: 'epoch', service, config: serviceConfig });
    expect(reply).toMatchObject({
      kind: 'reply', ok: true,
      result: {
        profile: 'client-offline',
        network: 'upstream-explicit',
        target: { host: '10.20.30.40', port: 25_565, source: 'configured-target' },
        upstream: { enabled: true, rewriteHandshake: true },
      },
    });
    // The reply must not collapse to the regressed hardcoded labels.
    expect(reply.kind === 'reply' ? reply.result : undefined).not.toMatchObject({ profile: 'client-offline', network: 'disabled' });
  });

  it('does not invent a profile when the caller supplied none, and derives network from the gate', () => {
    const service = new BridgeService();
    const relayOnly: BridgeServiceEntryConfig = { ...serviceConfig, profile: undefined, network: undefined };
    const reply = serviceCommandReply(IpcRequestSchema.parse({ type: 'request', protocolVersion: 1, requestId: 'r2', sessionEpoch: 'epoch', command: 'capabilities', payload: {} }), { sessionEpoch: 'epoch', service, config: relayOnly });
    expect(reply).toMatchObject({ kind: 'reply', ok: true, result: { profile: 'unspecified', network: 'upstream-explicit' } });
    const describe = describeBridgeServiceCapabilities(relayOnly, null);
    expect(describe.profile).toBe('unspecified');
    expect(describe.network).toBe('upstream-explicit');
  });

  it('rejects observe as unsupported and fences a stale session epoch', () => {
    const service = new BridgeService();
    const observe = serviceCommandReply(IpcRequestSchema.parse({ type: 'request', protocolVersion: 1, requestId: 'r3', sessionEpoch: 'epoch', command: 'observe', payload: {} }), { sessionEpoch: 'epoch', service });
    expect(observe).toMatchObject({ kind: 'reply', ok: false, error: { code: 'observe-unsupported' } });
    const stale = serviceCommandReply(IpcRequestSchema.parse({ type: 'request', protocolVersion: 1, requestId: 'r4', sessionEpoch: 'other', command: 'capabilities', payload: {} }), { sessionEpoch: 'epoch', service });
    expect(stale).toMatchObject({ kind: 'reply', ok: false, error: { code: 'stale-session' } });
  });

  it('rejects observer commands with an explicit unsupported reply when no observer is configured', () => {
    const service = new BridgeService();
    expect(serviceCommandReply(IpcRequestSchema.parse({ type: 'request', protocolVersion: 1, requestId: 'r5', sessionEpoch: 'epoch', command: 'start-observer', payload: {} }), { sessionEpoch: 'epoch', service }))
      .toMatchObject({ kind: 'reply', ok: false, error: { code: 'command-unsupported' } });
    // With an observer present the command is forwarded, not silently refused.
    expect(serviceCommandReply(IpcRequestSchema.parse({ type: 'request', protocolVersion: 1, requestId: 'r6', sessionEpoch: 'epoch', command: 'start-observer', payload: {} }), { sessionEpoch: 'epoch', service, observer }))
      .toMatchObject({ kind: 'start-observer' });
  });

  it('advertises only implemented service capabilities (never observe) in the service entry source', () => {
    // The entry must not name `observe`: it has no observe handler and rejects it as unsupported.
    const source = readFileSync('src/bridge/service/entry.ts', 'utf8');
    const helloLiterals = source.match(/capabilities:\s*\[[^\]]*\]/g) ?? [];
    expect(helloLiterals.length).toBeGreaterThan(0);
    for (const literal of helloLiterals) expect(literal).not.toMatch(/'observe'/);
    expect(source).toMatch(/capabilities:\s*\['control', 'relay'/);
  });

  it('relay entry advertises only implemented capabilities (never observe)', async () => {
    // The relay has no `observe` command handler: it implements status/start-observer/
    // stop-observer/shutdown and forwards passive observation. Advertising `observe` invites a
    // caller to request an operation that can only fail. With an observer enabled it advertises
    // exactly ['control','observer'].
    const { runRelayEntry } = await import('../../src/bridge/relay/entry.js');
    const sent: Array<Record<string, unknown>> = [];
    const handle = await runRelayEntry(
      { listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort: 1, allowMinecraftUpstream: true, observer: { enabled: true } },
      { send: message => { sent.push(message as Record<string, unknown>); return true; }, on: () => undefined, off: () => undefined },
    );
    try {
      const hello = sent.find(message => message.type === 'hello');
      expect(hello?.capabilities).toEqual(['control', 'observer']);
      expect(hello?.capabilities).not.toContain('observe');
    } finally {
      await handle.stop();
    }
  });
});

describe('G15 — child processes receive a minimal, allowlisted environment', () => {
  const secrets: Record<string, string> = {
    MINECRAFT_AGENT_CLI_BEARER: 'sentinel-cli-bearer',
    MINECRAFT_AGENT_PAIRING_CODE: 'sentinel-pairing-code',
    OPENAI_API_KEY: 'sentinel-openai-key',
    ANTHROPIC_API_KEY: 'sentinel-anthropic-key',
    FUREVERCRAFT_UNRELATED_SECRET: 'sentinel-unrelated-secret',
  };

  afterEach(() => { vi.unstubAllEnvs(); });

  it('filters the parent environment down to process plumbing only', () => {
    for (const [key, value] of Object.entries(secrets)) vi.stubEnv(key, value);
    vi.stubEnv('PATH', '/some/path');
    const environment = minimalChildEnvironment();
    expect(environment.PATH).toBe('/some/path');
    const serialized = JSON.stringify(environment);
    for (const secret of Object.values(secrets)) expect(serialized).not.toContain(secret);
  });

  it('refuses to let a caller smuggle a secret through the overrides argument', () => {
    const environment = minimalChildEnvironment({
      PATH: '/allowlisted-path',
      MINECRAFT_AGENT_CLI_BEARER: 'smuggled-bearer',
      MINECRAFT_AGENT_PAIRING_CODE: 'smuggled-pairing-code',
      FUREVERCRAFT_RELAY_CONFIG: '{"must":"not-cross"}',
      OPENAI_API_KEY: 'smuggled-openai-key',
    });
    expect(environment).toEqual({ PATH: '/allowlisted-path' });
  });
});

describe('G14 — runDemo derives outcomes from observed results and holds the ownership lock', () => {
  const tempDemoDb = () => join(mkdtempSync(join(tmpdir(), 'furevercraft-restored-demo-')), 'state.sqlite');

  async function captureDemo(db: string, scenario?: string): Promise<Record<string, unknown>> {
    const out: string[] = [];
    const original = console.log;
    console.log = (message?: unknown) => { out.push(String(message)); };
    try {
      await runDemo(db, scenario);
    } finally {
      console.log = original;
    }
    return JSON.parse(out[0] ?? '{}') as Record<string, unknown>;
  }

  it('derives the human-steering oldResult from the observed navigation instead of hardcoding superseded', async () => {
    // Navigation is synchronous, so the first run has already finished when the revised target
    // starts; its real result must be reported, never a hardcoded `superseded`.
    const document = await captureDemo(tempDemoDb(), 'human-steering');
    const scenario = (document.scenarios as Array<Record<string, unknown>>)[0];
    expect(scenario?.oldResult).toBe('succeeded');
    expect(scenario?.oldResult).not.toBe('superseded');
  });

  it('derives the chat-ui handoff and retry claims from the observed bridge calls', async () => {
    const document = await captureDemo(tempDemoDb(), 'chat-ui');
    const scenario = (document.scenarios as Array<Record<string, unknown>>)[0]!;
    expect(scenario.dispatchAttempts).toBe(1);
    expect(scenario.messageRetried).toBe(false);
    expect(scenario.unknownMessageNotRetried).toBe(true);
    // Derived from the observed dispatch count, not a hardcoded success flag.
    expect(scenario.unknownMessageNotRetried).toBe((scenario.dispatchAttempts as number) <= 1);
    expect(scenario.uiHandoff).toEqual(['gameplay', 'chat', 'gameplay']);
    expect(scenario.scenarioAssertions).toEqual({ unknownMessageNotRetried: true });
  });

  it('derives the crash-recovery outcome from the rebuilt runtime recovery result', async () => {
    const document = await captureDemo(tempDemoDb(), 'crash-recovery');
    const scenario = (document.scenarios as Array<Record<string, unknown>>)[0]!;
    const reconciled = scenario.reconciled as Array<Record<string, unknown>>;
    // The outcome is a function of what recovery actually produced, never a constant.
    expect(scenario.outcome).toBe(reconciled.some(item => item.effectId === 'effect_demo') ? 'reconciled' : 'not-reconciled');
    expect(scenario.pendingAfter).toBe(reconciled.length);
  });

  it('returns the demo document so callers can read the observed outcomes', async () => {
    const document = await captureDemo(tempDemoDb(), 'autonomous');
    expect(document).toMatchObject({ simulated: true, summary: { count: 1, names: ['autonomous'] } });
    expect((document.scenarios as Array<Record<string, unknown>>)[0]).toMatchObject({ scenario: 'autonomous', outcome: 'completed' });
  });

  it('acquires the RuntimeOwnershipLock so a scenario DB owned by another runtime is refused', async () => {
    const { RuntimeOwnershipLock } = await import('../../src/execution/ownership.js');
    const db = tempDemoDb();
    const owner = new RuntimeOwnershipLock(`${db}.0`);
    owner.acquire();
    const original = console.log;
    console.log = () => undefined;
    try {
      await expect(runDemo(db, 'autonomous')).rejects.toThrow(/^runtime-control-owned:/);
    } finally {
      console.log = original;
      owner.release();
    }
  });

  it('releases the ownership lock after a successful demo', async () => {
    const { RuntimeOwnershipLock } = await import('../../src/execution/ownership.js');
    const db = tempDemoDb();
    await captureDemo(db, 'autonomous');
    // If the demo leaked the lock, a fresh owner for the same path would fail to acquire.
    const probe = new RuntimeOwnershipLock(db);
    probe.acquire();
    expect(probe.release()).toBe(true);
  });
});
