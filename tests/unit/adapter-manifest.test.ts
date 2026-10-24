import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterManifestSchema,
  buildCandidate26_3Manifest,
  buildFixtureManifest,
  capabilityMatrix,
  generateAdapterManifest,
  loadAdapterManifest,
  serializeAdapterManifest,
  verifyAdapterManifest,
  type AdapterManifest,
} from '../../src/bridge/adapter/manifest.js';

const sha = 'a'.repeat(64);

function fixtureRoot(): { root: string; artifact: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'furevercraft-adapter-'));
  mkdirSync(join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', '1.20.4'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'minecraft-protocol'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'minecraft-data', 'package.json'), JSON.stringify({ name: 'minecraft-data', version: '3.87.0' }));
  writeFileSync(join(root, 'node_modules', 'minecraft-protocol', 'package.json'), JSON.stringify({ name: 'minecraft-protocol', version: '1.57.0' }));
  writeFileSync(join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', '1.20.4', 'version.json'), JSON.stringify({ version: 765 }));
  mkdirSync(join(root, 'adapter'), { recursive: true });
  const artifact = join(root, 'adapter', 'schema.json');
  writeFileSync(artifact, '{"packets":{}}');
  return { root, artifact, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function validManifest(root: string): AdapterManifest {
  return generateAdapterManifest({
    rootDir: root,
    release: '1.20.4',
    protocolVersion: 765,
    dataVersion: 3700,
    javaRequirement: '17',
    inputBackend: 'SDL3',
    adapterVersion: 'test-adapter',
    status: 'verified-fixture',
    dependencies: [{ name: 'minecraft-data', version: '3.87.0', installed: true }, { name: 'minecraft-protocol', version: '1.57.0', installed: true }],
    provenance: {
      schema: { kind: 'schema', source: 'adapter/schema.json', version: '1', verified: false, notes: [] },
      data: { kind: 'data', source: 'node_modules/minecraft-data/minecraft-data/data/pc/1.20.4/version.json', version: '1.20.4', verified: false, notes: [] },
      native: { kind: 'native', source: 'none', version: 'unverified', verified: false, notes: [] },
    },
    artifacts: [{ path: 'adapter/schema.json', role: 'schema' }],
    capabilities: [
      { domain: 'framing', status: 'verified-fixture', evidence: 'fixture', limitations: [] },
      { domain: 'blocks', status: 'unsupported', evidence: 'none', limitations: ['no-schema'] },
    ],
  });
}

describe('P07 adapter manifest', () => {
  it('generates a deterministic manifest and verifies installed artifacts and dependency versions', () => {
    const { root, cleanup } = fixtureRoot();
    try {
      const first = validManifest(root);
      const second = validManifest(root);
      expect(serializeAdapterManifest(first)).toBe(serializeAdapterManifest(second));
      expect(AdapterManifestSchema.parse(first).generator.reproducible).toBe(true);
      const verification = verifyAdapterManifest(first, { rootDir: root, expected: { release: '1.20.4', protocolVersion: 765, dataVersion: 3700 } });
      expect(verification.ok).toBe(true);
      expect(verification.available).toBe(true);
      expect(verification.checked).toEqual({ artifacts: 1, dependencies: 2, capabilities: 2 });
      expect(verification.issues).toEqual([]);
    } finally { cleanup(); }
  });

  it('rejects a target version mismatch', () => {
    const { root, cleanup } = fixtureRoot();
    try {
      const verification = verifyAdapterManifest(validManifest(root), { rootDir: root, expected: { release: '26.3', protocolVersion: 777, dataVersion: 5023 } });
      expect(verification.ok).toBe(false);
      expect(verification.issues.filter(issue => issue.code === 'version-mismatch')).toHaveLength(3);
    } finally { cleanup(); }
  });

  it('rejects a schema with unknown fields or an unsupported manifest version', () => {
    const { root, cleanup } = fixtureRoot();
    try {
      const manifest = validManifest(root) as AdapterManifest & { supported?: boolean };
      const withExtra = { ...manifest, supported: true };
      const extraResult = verifyAdapterManifest(withExtra, { rootDir: root });
      expect(extraResult.ok).toBe(false);
      expect(extraResult.issues[0]).toMatchObject({ code: 'invalid-schema' });

      const wrongVersion = { ...manifest, manifestVersion: 2 };
      const versionResult = verifyAdapterManifest(wrongVersion, { rootDir: root });
      expect(versionResult.ok).toBe(false);
      expect(versionResult.issues[0]?.code).toBe('invalid-schema');
      expect(versionResult.available).toBe(false);
    } finally { cleanup(); }
  });

  it('rejects an artifact whose installed hash no longer matches', () => {
    const { root, artifact, cleanup } = fixtureRoot();
    try {
      const manifest = validManifest(root);
      writeFileSync(artifact, '{"packets":{"changed":true}}');
      const verification = verifyAdapterManifest(manifest, { rootDir: root });
      expect(verification.ok).toBe(false);
      expect(verification.issues.some(issue => issue.code === 'artifact-hash-mismatch')).toBe(true);
      expect(verification.available).toBe(false);
    } finally { cleanup(); }
  });

  it('rejects verified native provenance when no native artifact is installed', () => {
    const { root, cleanup } = fixtureRoot();
    try {
      const manifest = validManifest(root);
      manifest.provenance.native = { kind: 'native', source: 'native/helper.exe', version: '1', sha256: sha, verified: true, notes: [] };
      const verification = verifyAdapterManifest(manifest, { rootDir: root });
      expect(verification.ok).toBe(false);
      expect(verification.issues.some(issue => issue.code === 'native-missing')).toBe(true);
    } finally { cleanup(); }
  });

  it('rejects dependency versions that differ from the installed tree', () => {
    const { root, cleanup } = fixtureRoot();
    try {
      writeFileSync(join(root, 'node_modules', 'minecraft-data', 'package.json'), JSON.stringify({ name: 'minecraft-data', version: '3.86.0' }));
      const verification = verifyAdapterManifest(validManifest(root), { rootDir: root });
      expect(verification.ok).toBe(false);
      expect(verification.issues.some(issue => issue.code === 'dependency-version-mismatch')).toBe(true);
    } finally { cleanup(); }
  });

  it('keeps the 26.3 candidate unsupported with exact unavailable reasons', () => {
    const candidate = loadAdapterManifest('configs/adapters/target-26.3.candidate.json');
    const verification = verifyAdapterManifest(candidate, { rootDir: process.cwd(), expected: { release: '26.3', protocolVersion: 777, dataVersion: 5023 } });
    expect(verification.ok).toBe(false);
    expect(verification.available).toBe(false);
    expect(verification.status).toBe('unsupported');
    expect(verification.issues).toContainEqual(expect.objectContaining({ code: 'adapter-data-absent', path: 'node_modules/minecraft-data/minecraft-data/data/pc/26.3/version.json' }));
    expect(verification.issues.some(issue => issue.code === 'native-provenance-unverified')).toBe(true);
    const matrix = capabilityMatrix(candidate);
    expect(matrix.available).toBe(false);
    expect(matrix.counts).toEqual({ 'verified-fixture': 0, experimental: 0, unsupported: 9 });
    expect(matrix.domains.every(domain => domain.status === 'unsupported' && domain.evidence === 'none')).toBe(true);
    expect(matrix.unavailableReasons).toContain('26.3-protocol-data-absent: node_modules/minecraft-data/minecraft-data/data/pc/26.3/version.json');
  });

  it('reproduces the committed 26.3 candidate from installed files', () => {
    const generated = buildCandidate26_3Manifest(process.cwd());
    expect(generated.evidence).toEqual({ dataPath: 'node_modules/minecraft-data/minecraft-data/data/pc/26.3/version.json', dataPresent: false, nativePath: 'native/windows/FurEverCraft.Helper.ps1', nativePresent: true, schemaPresent: false });
    const committed = readFileSync('configs/adapters/target-26.3.candidate.json', 'utf8');
    expect(serializeAdapterManifest(generated.manifest)).toBe(committed);
  });

  it('labels the legacy fixture separately and exposes per-domain capability, not a single boolean', () => {
    const manifest = buildFixtureManifest(process.cwd());
    const verification = verifyAdapterManifest(manifest, { rootDir: process.cwd(), expected: { release: '1.20.4', protocolVersion: 765, dataVersion: 3700 } });
    expect(verification.ok).toBe(true);
    expect(manifest.release).toBe('1.20.4');
    expect(manifest.adapterVersion).toBe('legacy-codec-fixture');
    const matrix = capabilityMatrix(manifest);
    expect(matrix).not.toHaveProperty('supported');
    expect(matrix.counts['verified-fixture']).toBeGreaterThan(0);
    expect(matrix.counts.experimental).toBeGreaterThan(0);
    expect(matrix.counts.unsupported).toBeGreaterThan(0);
    expect(matrix.domains.map(domain => domain.domain)).toEqual(expect.arrayContaining(['position', 'blocks', 'inventory', 'chat']));
    expect(existsSync(join(process.cwd(), 'node_modules/minecraft-data/minecraft-data/data/pc/1.20.4/version.json'))).toBe(true);
  });
});
