import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AdapterRegistry, contentDigest, sealManifest, type BundleDraft, type ComponentFactories, type ComponentKind } from '../../src/compat/registry.js';
import { createTargetRegistry } from '../../src/compat/target.js';
import { createRuntime } from '../../src/execution/factory.js';

const draft = (release = 'synthetic-a', protocol = 800): BundleDraft => {
  const ref = (kind: ComponentKind) => ({ id: `${release}/${kind}`, version: '1.0.0', digest: contentDigest({ kind, release }), sources: [] });
  return {
    manifestVersion: 2, id: release, game: { edition: 'java', release, protocol, dataVersion: 1 }, domainContract: { major: 1, minor: 0 },
    components: { protocol: ref('protocol'), data: ref('data'), geometryPhysics: ref('geometryPhysics'), clientControl: ref('clientControl') },
    capabilities: [{ id: 'protocol.decode', component: 'protocol', implementation: 'available', coverage: 'complete', evidence: 'synthetic-contract', requires: [], limitations: [] },
      { id: 'walk', component: 'clientControl', implementation: 'available', coverage: 'complete', evidence: 'synthetic-contract', requires: ['protocol.decode'], limitations: [] }],
  };
};
const factories = (input: BundleDraft): ComponentFactories => ({
  protocol: () => ({ ...input.components.protocol, decode: frame => ({ status: 'decoded', consumedBytes: frame.payload.length, events: [] }) }),
  data: () => ({ ...input.components.data, query: request => ({ status: 'unknown', records: [], releaseId: request.releaseId }) }),
  geometryPhysics: () => ({ ...input.components.geometryPhysics, shape: () => ({ status: 'unknown' }) }),
  clientControl: () => ({ ...input.components.clientControl, binding: () => ({ status: 'unknown' }) }),
});

describe('version adapter registry', () => {
  it('registers independent versions and evaluates the same domain capability contract', () => {
    const registry = new AdapterRegistry();
    for (const release of ['synthetic-a', 'synthetic-b']) {
      const d = draft(release, release === 'synthetic-a' ? 800 : 801);
      const bundle = registry.register(sealManifest(d), factories(d));
      expect(bundle.assess(['walk'], { allowSynthetic: true })).toMatchObject({ available: true });
      expect(bundle.assess(['walk']).reasons).toContain('capability-evidence-insufficient:protocol.decode');
    }
    expect(registry.list()).toHaveLength(2);
    expect(registry.resolve('synthetic-b', { release: 'synthetic-b', protocol: 801 }).manifest.game.protocol).toBe(801);
    expect(() => registry.resolve('synthetic-a', { release: 'synthetic-b', protocol: 801 })).toThrow('bundle-game-version-mismatch');
    expect(() => registry.resolve('latest')).toThrow('bundle-not-registered');
  });
  it('rejects modified manifest content rather than trusting its digest label', () => {
    const manifest = sealManifest(draft()); manifest.game.protocol += 1;
    expect(() => new AdapterRegistry().register(manifest)).toThrow('bundle-integrity-failed');
  });
  it('rejects unsupported domain contract versions', () => {
    const manifest = sealManifest(draft());
    expect(() => new AdapterRegistry().register({ ...manifest, domainContract: { major: 2, minor: 0 } })).toThrow();
  });
  it('rejects duplicate IDs, missing modules, and incorrect module identity', () => {
    const d = draft(); const manifest = sealManifest(d); const registry = new AdapterRegistry();
    expect(() => registry.register(manifest)).toThrow('bundle-component-missing:protocol');
    expect(() => registry.register(manifest, { ...factories(d), protocol: () => ({ ...d.components.protocol, digest: '0'.repeat(64), decode: () => ({ status: 'unsupported' as const, dependency: 'test', affectedDomains: ['all'] }) }) })).toThrow('bundle-component-mismatch:protocol');
    registry.register(manifest, factories(d));
    expect(() => registry.register(manifest, factories(d))).toThrow('bundle-already-registered');
  });
  it.each(['duplicate', 'cycle', 'missing'] as const)('rejects %s capability dependencies before assembly', fault => {
    const d = draft();
    if (fault === 'duplicate') d.capabilities.push(structuredClone(d.capabilities[0]!));
    if (fault === 'cycle') d.capabilities[0]!.requires = ['walk'];
    if (fault === 'missing') d.capabilities[1]!.requires = ['absent'];
    expect(() => new AdapterRegistry().register(sealManifest(d), factories(d))).toThrow(fault === 'duplicate' ? 'duplicate-capability' : fault === 'cycle' ? 'capability-cycle' : 'capability-dependency-missing');
  });
  it('verifies source bytes before constructing components', () => {
    const d = draft(); const bytes = Buffer.from('{"synthetic":true}');
    d.components.protocol.sources.push({ repository: 'test/fixture', commit: 'a'.repeat(40), path: 'schema.json', sha256: createHash('sha256').update(bytes).digest('hex'), sourceVersion: 'synthetic-a', inherited: false });
    const manifest = sealManifest(d); let constructed = false;
    const f = { ...factories(d), protocol: () => { constructed = true; return factories(d).protocol!(); } };
    expect(() => new AdapterRegistry().register(manifest, f)).toThrow('bundle-source-loader-required');
    expect(() => new AdapterRegistry().register(manifest, f, () => Buffer.from('changed'))).toThrow('bundle-artifact-integrity-failed');
    expect(constructed).toBe(false);
    expect(new AdapterRegistry().register(manifest, f, () => bytes).assess(['walk'], { allowSynthetic: true }).available).toBe(true);
  });
  it('does not let caller mutation alter the registered manifest or decisions', () => {
    const d = draft(); const manifest = sealManifest(d); const registry = new AdapterRegistry(); const bundle = registry.register(manifest, factories(d));
    manifest.capabilities[0]!.implementation = 'absent';
    registry.list()[0]!.capabilities[0]!.coverage = 'unknown';
    expect(bundle.assess(['walk'], { allowSynthetic: true }).available).toBe(true);
    expect(() => { bundle.manifest.game.release = 'other'; }).toThrow();
    const decision = bundle.assess(['walk'], { allowSynthetic: true }); decision.capabilities[0]!.requires.push('bogus');
    expect(bundle.assess(['walk'], { allowSynthetic: true }).available).toBe(true);
  });
  it('declares candidate gaps without inventing installed implementations', () => {
    const bundle = createTargetRegistry().resolve('java-26.3-candidate');
    expect(Object.keys(bundle.components)).toEqual([]);
    expect(bundle.assess(['control.motion'])).toMatchObject({ available: false });
    expect(bundle.assess(['unknown']).reasons).toEqual(['capability-unknown:unknown']);
  });
  it('assembles the registered bundle through the public Runtime factory and rejects wrong selection', () => {
    const runtime = createRuntime();
    try {
      expect(runtime.gameBundle).toBe(runtime.dependencies.gameBundle);
      expect(runtime.gameBundle.manifest.game.release).toBe('26.3');
      expect(runtime.gameBundle.assess(['protocol.decode']).available).toBe(false);
    } finally { runtime.close(); }
    const registry = new AdapterRegistry(); const d = draft(); registry.register(sealManifest(d), factories(d));
    expect(() => createRuntime({ adapterRegistry: registry, gameBundleId: d.id })).toThrow('bundle-game-version-mismatch');
  });
  it('normalizes deliberately different packet layouts through the same public decode contract', () => {
    const registry = new AdapterRegistry();
    for (const [release, protocol, packet] of [['synthetic-a', 800, [0x11, 7]], ['synthetic-b', 801, [7, 0x22]]] as const) {
      const d = draft(release, protocol);
      const modules = factories(d);
      modules.protocol = () => ({ ...d.components.protocol, decode: frame => {
        const id = release === 'synthetic-a' ? frame.payload[0] : frame.payload[1];
        if (id !== (release === 'synthetic-a' ? 0x11 : 0x22)) return { status: 'unsupported', dependency: 'packet-id', affectedDomains: ['position'] };
        return { status: 'decoded', consumedBytes: 2, events: [{ domain: 'position', kind: 'position.x', payload: { x: release === 'synthetic-a' ? frame.payload[1] : frame.payload[0] }, source: 'synthetic' }] };
      } });
      const bundle = registry.register(sealManifest(d), modules);
      const frame = { gameRelease: release, protocol, direction: 'client-to-server' as const, phase: 'PLAY', sessionId: 'test', connectionEpoch: '1', registryEpoch: '1', payload: Uint8Array.from(packet) };
      expect(bundle.decode(frame, { allowSynthetic: true })).toMatchObject({ status: 'decoded', events: [{ domain: 'position', payload: { x: 7 } }] });
      expect(bundle.decode({ ...frame, payload: Uint8Array.from([...packet, 0xff]) }, { allowSynthetic: true })).toMatchObject({ status: 'invalid', reason: 'packet-not-fully-consumed' });
      expect(bundle.decode({ ...frame, protocol: 1 }, { allowSynthetic: true })).toMatchObject({ status: 'invalid', reason: 'bundle-game-version-mismatch' });
    }
  });
  it('does not accept a metadata-only factory as an implemented protocol module', () => {
    const d = draft();
    const malformed = { ...factories(d), protocol: () => d.components.protocol } as unknown as ComponentFactories;
    expect(() => new AdapterRegistry().register(sealManifest(d), malformed)).toThrow('bundle-component-port-missing:protocol');
  });

});
