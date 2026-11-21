import { contentDigest, sealManifest, type AdapterRegistry, type BundleDraft, type ComponentFactories, type ComponentKind, type ResolvedBundle } from './registry.js';

export type SyntheticBundle = {
  manifest: ReturnType<typeof sealManifest>;
  factories: ComponentFactories;
  register(registry: AdapterRegistry): ResolvedBundle;
};

export type SyntheticBundleOptions = {
  release?: string;
  protocol?: number;
  dataVersion?: number;
  domainMinor?: number;
  /** Synthetic data/geometry answers are explicitly labelled, never presented as vanilla truth. */
  shapeBoxes?: ReadonlyArray<readonly [number, number, number, number, number, number]>;
};

/**
 * A complete four-module synthetic bundle for contract tests. All four ports are present and
 * the capability evidence is `synthetic-contract`; it is never a claim about the real 26.3 game.
 */
export function createSyntheticFourModuleBundle(options: SyntheticBundleOptions = {}): SyntheticBundle {
  const release = options.release ?? 'synthetic-4module';
  const protocol = options.protocol ?? 900;
  const domainMinor = options.domainMinor ?? 0;
  const boxes = options.shapeBoxes ?? [[0, 0, 0, 1, 1, 1]] as const;
  const ref = (kind: ComponentKind) => ({ id: `${release}/${kind}`, version: '1.0.0', digest: contentDigest({ kind, release, protocol, domainMinor }), sources: [] });
  const draft: BundleDraft = {
    manifestVersion: 2,
    id: release,
    game: { edition: 'java', release, protocol, dataVersion: options.dataVersion ?? 1 },
    domainContract: { major: 1, minor: domainMinor },
    components: { protocol: ref('protocol'), data: ref('data'), geometryPhysics: ref('geometryPhysics'), clientControl: ref('clientControl') },
    capabilities: [
      { id: 'protocol.decode', component: 'protocol', implementation: 'available', coverage: 'complete', evidence: 'synthetic-contract', requires: [], limitations: [] },
      { id: 'knowledge.query', component: 'data', implementation: 'available', coverage: 'complete', evidence: 'synthetic-contract', requires: [], limitations: [] },
      { id: 'geometry.static', component: 'geometryPhysics', implementation: 'available', coverage: 'complete', evidence: 'synthetic-contract', requires: [], limitations: [] },
      { id: 'control.motion', component: 'clientControl', implementation: 'available', coverage: 'complete', evidence: 'synthetic-contract', requires: ['protocol.decode', 'geometry.static'], limitations: [] },
    ],
  };
  const manifest = sealManifest(draft);
  const factories: ComponentFactories = {
    protocol: () => ({
      ...manifest.components.protocol,
      decode: frame => ({ status: 'decoded', consumedBytes: frame.payload.byteLength, events: [] }),
    }),
    data: () => ({
      ...manifest.components.data,
      query: request => ({
        status: 'known' as const,
        releaseId: request.releaseId,
        records: [{ resourceId: request.resourceId, topic: request.topic, synthetic: true }],
      }),
    }),
    geometryPhysics: () => ({
      ...manifest.components.geometryPhysics,
      shape: () => ({ status: 'known' as const, boxes, evidenceRefs: [`synthetic:${release}:geometry`] }),
    }),
    clientControl: () => ({
      ...manifest.components.clientControl,
      binding: action => ({ status: 'known' as const, physicalKey: `synthetic:${action}`, calibrationId: `synthetic:${release}` }),
    }),
  };
  return {
    manifest,
    factories,
    register(registry: AdapterRegistry) { return registry.register(manifest, factories); },
  };
}

/** Static factory table for the synthetic bundle (useful when only factories are needed). */
export function createSyntheticFourModuleFactories(options: SyntheticBundleOptions = {}): ComponentFactories {
  return createSyntheticFourModuleBundle(options).factories;
}
