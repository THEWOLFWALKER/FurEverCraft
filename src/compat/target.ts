import { AdapterRegistry, contentDigest, sealManifest, type ComponentFactories, type ComponentKind, type ComponentRef } from './registry.js';

/** Candidate identity is registered, but no absent decoder/data/input implementation is fabricated. */
const component = (kind: ComponentKind): ComponentRef => ({ id: `java-26.3/${kind}`, version: '0.0.0-candidate', digest: contentDigest({ kind, release: '26.3', installed: false }), sources: [] });
export const TARGET_BUNDLE_MANIFEST = sealManifest({
  manifestVersion: 2, id: 'java-26.3-candidate',
  game: { edition: 'java', release: '26.3', protocol: 777, dataVersion: 5023 },
  domainContract: { major: 1, minor: 0 },
  components: { protocol: component('protocol'), data: component('data'), geometryPhysics: component('geometryPhysics'), clientControl: component('clientControl') },
  capabilities: [
    { id: 'protocol.decode', component: 'protocol', implementation: 'absent', coverage: 'unknown', evidence: 'none', requires: [], limitations: ['26.3-schema-native-not-installed', 'unsupported-item-components'] },
    { id: 'knowledge.query', component: 'data', implementation: 'absent', coverage: 'unknown', evidence: 'none', requires: [], limitations: ['verified-source-files-not-imported'] },
    { id: 'geometry.static', component: 'geometryPhysics', implementation: 'absent', coverage: 'unknown', evidence: 'none', requires: [], limitations: ['candidate-geometry-not-installed'] },
    { id: 'control.motion', component: 'clientControl', implementation: 'absent', coverage: 'unknown', evidence: 'none', requires: ['protocol.decode', 'geometry.static'], limitations: ['client-input-not-calibrated'] },
  ],
});
/**
 * Explicit static factories for all four module ports. They are honest placeholders: the
 * capabilities remain `absent`, so registering them does not make the 26.3 candidate usable.
 * No factory falls back to a full cube, a non-empty knowledge answer, or an invented key.
 */
export const createTargetModuleFactories = (): ComponentFactories => {
  const refs = TARGET_BUNDLE_MANIFEST.components;
  return {
    protocol: () => ({ ...refs.protocol, decode: () => ({ status: 'unsupported' as const, dependency: '26.3-native-decoder-absent', affectedDomains: ['all'] }) }),
    data: () => ({ ...refs.data, query: request => ({ status: 'unknown' as const, records: [], releaseId: request.releaseId }) }),
    geometryPhysics: () => ({ ...refs.geometryPhysics, shape: () => ({ status: 'unknown' as const }) }),
    clientControl: () => ({ ...refs.clientControl, binding: () => ({ status: 'unknown' as const }) }),
  };
};
export function createTargetRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry(); registry.register(TARGET_BUNDLE_MANIFEST); return registry;
}
/** Candidate registry with static 4-module factories; capability assessment stays unavailable. */
export function createTargetRegistryWithStaticModules(): AdapterRegistry {
  const registry = new AdapterRegistry(); registry.register(TARGET_BUNDLE_MANIFEST, createTargetModuleFactories()); return registry;
}
