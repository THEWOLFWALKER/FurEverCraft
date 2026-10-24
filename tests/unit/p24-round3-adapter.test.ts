import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterManifestSchema,
  capabilityMatrix,
  generateAdapterManifest,
  sha256File,
  verifyAdapterManifest,
  type AdapterManifest,
  type ManifestInput,
  type ManifestVerification,
} from '../../src/bridge/adapter/manifest.js';
import {
  GAME_VERSION_PROFILE,
  assertSupportedProfile,
  installedGameIdentity,
  versionProfileAvailability,
  versionProfileSummary,
  type GameVersionProfile,
  type GameVersionVerification,
  type VersionProfileOptions,
} from '../../src/bridge/version-profile.js';

const expectedTarget = { release: '1.20.4', protocolVersion: 765, dataVersion: 3700 };
const dataPath = 'adapter/data.json';
const schemaPath = 'adapter/schema.json';
const nativePath = 'adapter/native.bin';
const versionPath = 'node_modules/minecraft-data/minecraft-data/data/pc/1.20.4/version.json';
const cataloguePath = 'node_modules/minecraft-data/minecraft-data/data/pc/common/protocolVersions.json';

type Round3Root = { root: string; outside: string; cleanup: () => void };

function round3Root(): Round3Root {
  const root = mkdtempSync(join(tmpdir(), 'furevercraft-round3-adapter-'));
  const outside = mkdtempSync(join(tmpdir(), 'furevercraft-round3-outside-'));
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
  const artifacts = overrides.artifacts ?? [
    { path: schemaPath, role: 'schema' as const },
    { path: dataPath, role: 'data' as const },
    { path: nativePath, role: 'native' as const },
  ];
  const input: ManifestInput = {
    rootDir: root,
    release: '1.20.4',
    protocolVersion: 765,
    dataVersion: 3700,
    javaRequirement: '17',
    inputBackend: 'SDL3',
    adapterVersion: 'round3-test-adapter',
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
    artifacts,
    capabilities: [
      { domain: 'framing', status: 'verified-fixture', evidence: 'fixture', limitations: [] },
      { domain: 'blocks', status: 'unsupported', evidence: 'none', limitations: [] },
    ],
    ...overrides,
  };
  return generateAdapterManifest(input);
}

function verify(manifest: AdapterManifest, root: string): ManifestVerification {
  return verifyAdapterManifest(manifest, { rootDir: root, expected: expectedTarget });
}

describe('Round 3 — adapter manifest verification trusts artifacts, not declarations', () => {
  it('requires an explicit expected target even for JavaScript callers', () => {
    const { root, cleanup } = round3Root();
    try {
      const manifest = buildManifest(root);
      const verification = verifyAdapterManifest(manifest, { rootDir: root } as unknown as { rootDir: string; expected: typeof expectedTarget });
      expect(verification.ok).toBe(false);
      expect(verification.issues.some(issue => issue.code === 'expected-target-required')).toBe(true);
      expect(verification.available).toBe(false);
    } finally { cleanup(); }
  });

  it('requires schema, data and native artifacts instead of trusting provenance alone', () => {
    const { root, cleanup } = round3Root();
    try {
      const manifest = buildManifest(root);
      manifest.artifacts = manifest.artifacts.filter(artifact => artifact.role !== 'data');
      const verification = verify(manifest, root);
      expect(verification.ok).toBe(false);
      expect(verification.issues).toContainEqual(expect.objectContaining({ code: 'artifact-role-missing', path: 'artifacts.data' }));
      expect(verification.available).toBe(false);
    } finally { cleanup(); }
  });

  it('compares every declared provenance hash with the installed artifact bytes', () => {
    const { root, cleanup } = round3Root();
    try {
      const manifest = buildManifest(root);
      manifest.provenance.schema = { ...manifest.provenance.schema, sha256: 'b'.repeat(64) };
      const verification = verify(manifest, root);
      expect(verification.ok).toBe(false);
      expect(verification.issues.some(issue => issue.code === 'provenance-hash-mismatch' && issue.path === 'provenance.schema.sha256')).toBe(true);
    } finally { cleanup(); }
  });

  it('rejects a data artifact whose parsed identity contradicts the target', () => {
    const { root, cleanup } = round3Root();
    try {
      writeFileSync(join(root, dataPath), JSON.stringify({ release: '1.20.4', protocolVersion: 766, dataVersion: 3701 }));
      const verification = verify(buildManifest(root), root);
      expect(verification.ok).toBe(false);
      expect(verification.issues.some(issue => issue.code === 'data-protocol-version-mismatch')).toBe(true);
      expect(verification.issues.some(issue => issue.code === 'data-data-version-mismatch')).toBe(true);
    } finally { cleanup(); }
  });

  it('requires the data artifact to declare a data version instead of accepting existence', () => {
    const { root, cleanup } = round3Root();
    try {
      writeFileSync(join(root, dataPath), JSON.stringify({ release: '1.20.4', protocolVersion: 765 }));
      const verification = verify(buildManifest(root), root);
      expect(verification.ok).toBe(false);
      expect(verification.issues.some(issue => issue.code === 'data-data-version-missing')).toBe(true);
    } finally { cleanup(); }
  });

  it('rejects capability status/evidence contradictions at the schema boundary', () => {
    const { root, cleanup } = round3Root();
    try {
      const manifest = buildManifest(root);
      const contradictory = {
        ...manifest,
        capabilities: [{ domain: 'framing', status: 'verified-fixture' as const, evidence: 'synthetic' as const, limitations: [] }],
      };
      const parsed = AdapterManifestSchema.safeParse(contradictory);
      expect(parsed.success).toBe(false);
      const verification = verifyAdapterManifest(contradictory, { rootDir: root, expected: expectedTarget });
      expect(verification.ok).toBe(false);
      expect(verification.issues.some(issue => issue.code === 'invalid-schema')).toBe(true);
    } finally { cleanup(); }
  });

  it('never reports an all-unsupported capability matrix as available', () => {
    const { root, cleanup } = round3Root();
    try {
      const manifest = buildManifest(root, {
        capabilities: [
          { domain: 'framing', status: 'unsupported', evidence: 'none', limitations: ['no-codec'] },
          { domain: 'blocks', status: 'unsupported', evidence: 'none', limitations: ['no-codec'] },
        ],
      });
      const verification = verify(manifest, root);
      expect(verification.ok).toBe(false);
      expect(verification.available).toBe(false);
      expect(verification.issues.some(issue => issue.code === 'capability-matrix-all-unsupported')).toBe(true);
      // Even a forged verification object cannot make the public matrix available.
      const matrix = capabilityMatrix(manifest, { ...verification, ok: true, available: true });
      expect(matrix.available).toBe(false);
      expect(matrix.counts).toEqual({ 'verified-fixture': 0, experimental: 0, unsupported: 2 });
    } finally { cleanup(); }
  });

  it('cannot produce the public capability matrix without a verification result', () => {
    const { root, cleanup } = round3Root();
    try {
      const manifest = buildManifest(root);
      const unverifiedMatrix = capabilityMatrix as unknown as (value: AdapterManifest) => unknown;
      expect(() => unverifiedMatrix(manifest)).toThrow('capability-matrix-requires-verification');
    } finally { cleanup(); }
  });

  it('rejects absolute and escaping artifact paths during generation', () => {
    const { root, cleanup } = round3Root();
    try {
      expect(() => buildManifest(root, { artifacts: [{ path: join(root, schemaPath), role: 'schema' }] })).toThrow('invalid-artifact-path:absolute-path');
      expect(() => buildManifest(root, { artifacts: [{ path: '../escaped.bin', role: 'schema' }] })).toThrow('invalid-artifact-path:outside-root');
    } finally { cleanup(); }
  });

  it('reports invalid-artifact-path for absolute, traversing and symlink artifacts during verification', () => {
    const { root, outside, cleanup } = round3Root();
    try {
      const absoluteManifest = buildManifest(root);
      absoluteManifest.artifacts.find(artifact => artifact.role === 'schema')!.path = join(root, schemaPath);
      expect(verify(absoluteManifest, root).issues.some(issue => issue.code === 'invalid-artifact-path')).toBe(true);

      const escapingManifest = buildManifest(root);
      escapingManifest.artifacts.find(artifact => artifact.role === 'schema')!.path = '../escaped.bin';
      expect(verify(escapingManifest, root).issues.some(issue => issue.code === 'invalid-artifact-path')).toBe(true);

      symlinkSync(join(outside, 'escaped.bin'), join(root, 'adapter', 'linked.bin'));
      const symlinkManifest = buildManifest(root);
      const schemaArtifact = symlinkManifest.artifacts.find(artifact => artifact.role === 'schema')!;
      schemaArtifact.path = 'adapter/linked.bin';
      const symlinkVerification = verify(symlinkManifest, root);
      expect(symlinkVerification.ok).toBe(false);
      expect(symlinkVerification.issues).toContainEqual(expect.objectContaining({
        code: 'invalid-artifact-path', path: 'adapter/linked.bin', message: 'artifact path is symlink-outside-root',
      }));
    } finally { cleanup(); }
  });
});

function syntheticProfileRoot(): { root: string; cleanup: () => void } {
  // Synthetic fixture: this is fabricated test data, not a claim that 26.3 data is installed.
  const root = mkdtempSync(join(tmpdir(), 'furevercraft-round3-profile-'));
  mkdirSync(join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', '26.3'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', 'common'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', 'common', 'protocolVersions.json'), JSON.stringify([{ minecraftVersion: '26.3', version: 777, dataVersion: 5023 }]));
  writeFileSync(join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', '26.3', 'version.json'), JSON.stringify({ minecraftVersion: '26.3', version: 777 }));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const syntheticVerification: GameVersionVerification = {
  release: '26.3', protocolVersion: 777, dataVersion: 5023,
  ok: true, available: true, status: 'verified-fixture',
};

describe('Round 3 — 26.3 profile gate uses installed identity and verification', () => {
  it('does not invent installed 26.3 identity in the real pinned dependency tree', () => {
    expect(installedGameIdentity(process.cwd())).toBeUndefined();
    expect(versionProfileSummary().codecDataAvailable).toBe(false);
    expect(versionProfileSummary().available).toBe(false);
  });

  it('accepts an available profile only when synthetic identity and verification both match (synthetic fixture)', () => {
    const { root, cleanup } = syntheticProfileRoot();
    try {
      const profile: GameVersionProfile = { ...GAME_VERSION_PROFILE, status: 'available' };
      const options: VersionProfileOptions = { rootDir: root, verification: syntheticVerification };
      expect(installedGameIdentity(root, '26.3')).toMatchObject({ release: '26.3', protocolVersion: 777, dataVersion: 5023, versionName: '26.3' });
      expect(() => assertSupportedProfile(profile, options)).not.toThrow();
      expect(versionProfileAvailability(profile, options)).toMatchObject({
        installedIdentity: { release: '26.3', protocolVersion: 777, dataVersion: 5023 },
        identityMatched: true, codecDataAvailable: true, verified: true, available: true,
      });
      expect(versionProfileSummary(profile, options)).toMatchObject({ available: true, verified: true, identityMatched: true });
    } finally { cleanup(); }
  });

  it('keeps a candidate profile fail-closed even with installed data and a passing verification (synthetic fixture)', () => {
    const { root, cleanup } = syntheticProfileRoot();
    try {
      const options: VersionProfileOptions = { rootDir: root, verification: syntheticVerification };
      expect(versionProfileAvailability(GAME_VERSION_PROFILE, options).available).toBe(false);
      expect(() => assertSupportedProfile(GAME_VERSION_PROFILE, options)).toThrow('game-version-profile-not-supported:candidate');
    } finally { cleanup(); }
  });

  it('requires a verification result and a matching installed identity (synthetic fixture)', () => {
    const { root, cleanup } = syntheticProfileRoot();
    try {
      const profile: GameVersionProfile = { ...GAME_VERSION_PROFILE, status: 'available' };
      expect(() => assertSupportedProfile(profile, { rootDir: root })).toThrow('game-version-not-verified:26.3');
      expect(() => assertSupportedProfile(profile, {
        rootDir: root,
        verification: { ...syntheticVerification, available: false },
      })).toThrow('game-version-not-verified:26.3');

      writeFileSync(join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', 'common', 'protocolVersions.json'), JSON.stringify([{ minecraftVersion: '26.3', version: 777, dataVersion: 9999 }]));
      expect(() => assertSupportedProfile(profile, { rootDir: root, verification: syntheticVerification })).toThrow('game-version-identity-mismatch:dataVersion');
    } finally { cleanup(); }
  });

  it('treats a catalogue entry without installed codec data as unavailable (synthetic fixture)', () => {
    const { root, cleanup } = syntheticProfileRoot();
    try {
      rmSync(join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', '26.3'), { recursive: true, force: true });
      const profile: GameVersionProfile = { ...GAME_VERSION_PROFILE, status: 'available' };
      expect(installedGameIdentity(root, '26.3')).toBeUndefined();
      expect(() => assertSupportedProfile(profile, { rootDir: root, verification: syntheticVerification })).toThrow('game-version-codec-unavailable:26.3');
    } finally { cleanup(); }
  });
});
