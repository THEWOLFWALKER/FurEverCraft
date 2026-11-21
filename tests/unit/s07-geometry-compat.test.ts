import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdapterRegistry, contentDigest, sealManifest, type BundleDraft } from '../../src/compat/registry.js';
import { createSyntheticFourModuleBundle } from '../../src/compat/synthetic.js';
import { createTargetRegistryWithStaticModules, createTargetModuleFactories } from '../../src/compat/target.js';
import {
  loadRosegoldGeometryProfile, loadRosegoldGeometryProfileFromDirectory, type RosegoldGeometryLock,
} from '../../src/compat/geometry-profile.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const blocksText = JSON.stringify({
  stone: { minStateId: 1, maxStateId: 1 },
  oak_slab: { minStateId: 2, maxStateId: 3 },
  water: { minStateId: 4, maxStateId: 4 },
  broken: { minStateId: 5, maxStateId: 5 },
});
const shapesText = JSON.stringify({
  blocks: { stone: 0, oak_slab: [1, 2], water: 3, broken: 99 },
  shapes: {
    0: [[0, 0, 0, 1, 1, 1]],
    1: [[0, 0, 0, 1, 0.5, 1]],
    2: [[0, 0.5, 0, 1, 1, 1]],
    3: [],
  },
});
const lock = (overrides: Partial<RosegoldGeometryLock> = {}): RosegoldGeometryLock => ({
  commit: 'b'.repeat(40), sourceVersion: '26.3',
  files: [
    { path: 'data/26.3/blocks.json', sha256: sha(blocksText), sourceVersion: '26.3' },
    { path: 'data/26.3/blockCollisionShapes.json', sha256: sha(shapesText), sourceVersion: '26.3' },
  ],
  ...overrides,
});

describe('S07 Rosegold geometry profile', () => {
  it('returns known boxes with inherited provenance and never falls back to a full cube', () => {
    const loaded = loadRosegoldGeometryProfile({
      files: { 'blocks.json': blocksText, 'blockCollisionShapes.json': shapesText },
      lock: lock(),
      inheritedBlocks: ['oak_slab'],
    });
    expect(loaded.status).toBe('loaded');
    if (loaded.status !== 'loaded') return;
    const profile = loaded.profile;
    expect(profile.blockForState(1)).toBe('stone');
    expect(profile.shape({ stateId: 1, kind: 'collision' })).toMatchObject({
      status: 'known', boxes: [[0, 0, 0, 1, 1, 1]], inherited: false, blockName: 'stone',
      evidenceRefs: [`rosegold:${'b'.repeat(40)}:stone:0`],
    });
    expect(profile.shape({ stateId: 2, kind: 'collision' })).toMatchObject({ status: 'known', boxes: [[0, 0, 0, 1, 0.5, 1]], inherited: true });
    // Contextual blocks are unsupported, not a full cube.
    expect(profile.shape({ stateId: 4, kind: 'collision' })).toMatchObject({ status: 'unsupported', reason: 'contextual-collision' });
    // A missing shape reference is unknown, not a full-cube guess.
    expect(profile.shape({ stateId: 5, kind: 'collision' })).toMatchObject({ status: 'unknown', reason: 'shape-reference-missing:99' });
    expect(profile.shape({ stateId: 999, kind: 'collision' })).toMatchObject({ status: 'unknown', reason: 'state-not-found' });
    expect(profile.shape({ stateId: 1, kind: 'interaction' })).toMatchObject({ status: 'unsupported', reason: 'interaction-shape-not-verified' });
    expect(profile.shape({ stateId: -1, kind: 'collision' })).toMatchObject({ status: 'unknown', reason: 'invalid-state-id' });
    const port = profile.asPort({ id: 'rosegold/geometry', version: '26.3', digest: contentDigest({ id: 'rosegold/geometry' }) });
    expect(port.shape({ registryEpoch: 'r1', stateId: 1, kind: 'collision' })).toMatchObject({ status: 'known' });
  });

  it('verifies both hash locks before parsing and fails closed on mismatch/missing files', () => {
    expect(loadRosegoldGeometryProfile({ files: { blocks: blocksText, shapes: shapesText } as never, lock: lock() }).status).toBe('failed');
    const mismatch = loadRosegoldGeometryProfile({
      files: { 'data/26.3/blocks.json': blocksText, 'data/26.3/blockCollisionShapes.json': JSON.stringify({ shapes: {} }) },
      lock: lock(),
    });
    expect(mismatch).toMatchObject({ status: 'failed', error: 'geometry-integrity-failed' });
    const missing = loadRosegoldGeometryProfile({ files: { 'data/26.3/blocks.json': blocksText }, lock: lock() });
    expect(missing).toMatchObject({ status: 'failed', error: 'geometry-file-missing' });
    const incomplete = loadRosegoldGeometryProfile({ files: {}, lock: { files: [] } });
    expect(incomplete).toMatchObject({ status: 'failed', error: 'geometry-lock-incomplete' });
  });

  it('loads from a local directory and reports missing external data as failed, not zero shapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'furecraft-rosegold-'));
    try {
      mkdirSync(join(root, 'data/26.3'), { recursive: true });
      writeFileSync(join(root, 'data/26.3/blocks.json'), blocksText);
      writeFileSync(join(root, 'data/26.3/blockCollisionShapes.json'), shapesText);
      const loaded = loadRosegoldGeometryProfileFromDirectory({ rootDir: root, lock: lock() });
      expect(loaded.status).toBe('loaded');
      if (loaded.status === 'loaded') expect(loaded.profile.blockCount).toBe(4);
      const absent = loadRosegoldGeometryProfileFromDirectory({ rootDir: join(root, 'absent'), lock: lock() });
      expect(absent.status).toBe('failed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('S07 static four-module bundles and minor domain contract', () => {
  it('registers a complete synthetic four-module bundle with all ports usable', () => {
    const bundle = createSyntheticFourModuleBundle({ release: 'synthetic-s07', protocol: 950, shapeBoxes: [[0, 0, 0, 0.5, 1, 1]] });
    const registry = new AdapterRegistry();
    const resolved = bundle.register(registry);
    expect(Object.keys(resolved.components).sort()).toEqual(['clientControl', 'data', 'geometryPhysics', 'protocol']);
    expect(resolved.assess(['control.motion', 'knowledge.query'], { allowSynthetic: true })).toMatchObject({ available: true });
    expect(resolved.manifest.domainContract).toEqual({ major: 1, minor: 0 });
    const frame = { gameRelease: 'synthetic-s07', protocol: 950, direction: 'server-to-client' as const, phase: 'PLAY', sessionId: 's', connectionEpoch: '1', registryEpoch: '1', payload: Uint8Array.from([1, 2]) };
    expect(resolved.decode(frame, { allowSynthetic: true })).toMatchObject({ status: 'decoded', consumedBytes: 2, events: [] });
    expect(resolved.components.data?.query({ releaseId: 'r', resourceId: 'stone', topic: 'block', limit: 1 })).toMatchObject({ status: 'known', records: [{ synthetic: true }] });
    expect(resolved.components.geometryPhysics?.shape({ registryEpoch: '1', stateId: 1, kind: 'collision' })).toMatchObject({ status: 'known', boxes: [[0, 0, 0, 0.5, 1, 1]] });
    expect(resolved.components.clientControl?.binding('jump')).toMatchObject({ status: 'known', calibrationId: 'synthetic:synthetic-s07' });
  });

  it('accepts the documented minor domain upgrade and rejects an unsupported one', () => {
    const registry = new AdapterRegistry();
    const minor = createSyntheticFourModuleBundle({ release: 'synthetic-micro', protocol: 951, domainMinor: 1 });
    const resolved = registry.register(minor.manifest, minor.factories);
    expect(resolved.manifest.domainContract).toEqual({ major: 1, minor: 1 });
    expect(resolved.assess(['control.motion'], { allowSynthetic: true }).available).toBe(true);
    const newer = createSyntheticFourModuleBundle({ release: 'synthetic-too-new', protocol: 952, domainMinor: 2 });
    expect(() => new AdapterRegistry().register(newer.manifest, newer.factories)).toThrow('domain-contract-minor-unsupported:2');
    // An incompatible domain major is a *supported-contract* decision, not a manifest shape
    // error: sealing succeeds (the bundle is well-formed) and registration rejects it with a
    // typed reason. A raw ZodError from sealing would mean the invariant is enforced in the
    // wrong layer (the schema), so assert the typed rejection explicitly.
    const badMajor = sealManifest({ ...(minor.manifest as unknown as BundleDraft), id: 'bad-major', domainContract: { major: 2, minor: 0 } });
    expect(badMajor.domainContract).toEqual({ major: 2, minor: 0 });
    expect(() => new AdapterRegistry().register(badMajor)).toThrow('domain-contract-major-unsupported:2');
  });

  it('keeps the 26.3 candidate capacity-absent even with static factories', () => {
    const bundle = createTargetRegistryWithStaticModules().resolve('java-26.3-candidate');
    expect(Object.keys(bundle.components).sort()).toEqual(['clientControl', 'data', 'geometryPhysics', 'protocol']);
    expect(bundle.assess(['protocol.decode'])).toMatchObject({ available: false });
    expect(bundle.components.data?.query({ releaseId: '26.3', resourceId: 'stone', topic: 'block', limit: 1 })).toMatchObject({ status: 'unknown' });
    expect(bundle.components.geometryPhysics?.shape({ registryEpoch: '1', stateId: 1, kind: 'collision' })).toMatchObject({ status: 'unknown' });
    const factories = createTargetModuleFactories();
    expect(Object.keys(factories).sort()).toEqual(['clientControl', 'data', 'geometryPhysics', 'protocol']);
  });
});
