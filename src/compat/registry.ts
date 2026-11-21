import type { ModuleByKind, PacketDecodeResult, ProtocolFrame } from './ports.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const ComponentKind = z.enum(['protocol', 'data', 'geometryPhysics', 'clientControl']);
export type ComponentKind = z.infer<typeof ComponentKind>;
const Source = z.object({ repository: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().min(1), sha256: Digest, sourceVersion: z.string().min(1), inherited: z.boolean() }).strict();
const Component = z.object({ id: z.string().min(1), version: z.string().min(1), digest: Digest, sources: z.array(Source) }).strict();
const Capability = z.object({
  id: z.string().min(1), component: ComponentKind,
  implementation: z.enum(['available', 'absent']), coverage: z.enum(['complete', 'partial', 'unknown']),
  evidence: z.enum(['none', 'synthetic-contract', 'file-verified', 'client-calibrated']),
  requires: z.array(z.string().min(1)), limitations: z.array(z.string()),
}).strict();
/** Major must match exactly. A documented minor upgrade is contract-tested, not inferred from semver. */
export const SUPPORTED_DOMAIN_CONTRACT = Object.freeze({ major: 1 as const, minor: 1 as const });
/**
 * The manifest is *sealed* structurally: every field is validated, but the domain contract
 * `major` is only constrained to a positive integer. Whether a given major is *supported* is a
 * compatibility decision made by `register` (the contract invariant), not a shape rule. Keeping
 * the major out of the literal here means an incompatible bundle is rejected with a typed
 * `domain-contract-major-unsupported` error instead of a raw ZodError leaking from sealing.
 */
const BundleManifestSchemaV2 = z.object({
  manifestVersion: z.literal(2), id: z.string().min(1), digest: Digest,
  game: z.object({ edition: z.literal('java'), release: z.string().min(1), protocol: z.number().int().positive(), dataVersion: z.number().int().positive() }).strict(),
  domainContract: z.object({ major: z.number().int().positive(), minor: z.number().int().nonnegative() }).strict(),
  components: z.object({ protocol: Component, data: Component, geometryPhysics: Component, clientControl: Component }).strict(),
  capabilities: z.array(Capability),
}).strict();
export const BundleManifestSchema = BundleManifestSchemaV2;
export type BundleManifest = z.infer<typeof BundleManifestSchema>;
export type CapabilityDeclaration = BundleManifest['capabilities'][number];
export type ComponentRef = BundleManifest['components'][ComponentKind];
export type BundleDraft = Omit<BundleManifest, 'digest'>;
/**
 * A structurally sealed bundle whose *domain contract* is not the supported major. It is the
 * only manifest that both parses (so `register` can read the contract) and is guaranteed to be
 * rejected by `register`; for every other draft the sealed manifest is a `BundleManifest`.
 */
export type SealedBundleManifest = Omit<BundleManifest, 'domainContract'> & { domainContract: { major: number; minor: number } };

/** Object keys are canonical; arrays retain semantic ordering. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function contentDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function sealManifest(draft: BundleDraft): BundleManifest;
export function sealManifest(draft: SealedBundleManifest): SealedBundleManifest;
export function sealManifest(draft: BundleDraft | SealedBundleManifest): BundleManifest | SealedBundleManifest {
  const parsed = BundleManifestSchema.parse({ ...draft, digest: '0'.repeat(64) });
  const { digest: _, ...body } = parsed;
  return { ...body, digest: contentDigest(body) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Explicit factories are trusted project code, never paths loaded from a manifest. */
export type { AdapterComponent } from './ports.js';
export type ComponentFactories = { [K in ComponentKind]?: () => ModuleByKind[K] };
export type SourceLoader = (source: ComponentRef['sources'][number]) => Uint8Array;
export type CapabilityDecision = { available: boolean; reasons: string[]; capabilities: CapabilityDeclaration[] };
export type ResolvedBundle = {
  readonly manifest: BundleManifest;
  readonly components: Readonly<Partial<ModuleByKind>>;
  decode(frame: ProtocolFrame, options?: { allowSynthetic?: boolean }): PacketDecodeResult;
  assess(required: readonly string[], options?: { allowSynthetic?: boolean }): CapabilityDecision;
};

export class AdapterRegistry {
  private readonly entries = new Map<string, ResolvedBundle>();
  register(input: unknown, factories: ComponentFactories = {}, load?: SourceLoader): ResolvedBundle {
    const manifest = BundleManifestSchema.parse(input);
    const { digest, ...body } = manifest;
    if (contentDigest(body) !== digest) throw new Error('bundle-integrity-failed');
    // Incompatible domain major is rejected at assembly with a typed error, never a shape failure
    // from sealing or parsing. The manifest itself is structurally valid; its contract is not.
    if (manifest.domainContract.major !== SUPPORTED_DOMAIN_CONTRACT.major) throw new Error(`domain-contract-major-unsupported:${manifest.domainContract.major}`);
    // Minor upgrades are accepted only up to the explicitly supported contract, and only after
    // the contract suite proves the same domain behaviour. A newer minor is not guessed.
    if (manifest.domainContract.minor > SUPPORTED_DOMAIN_CONTRACT.minor) throw new Error(`domain-contract-minor-unsupported:${manifest.domainContract.minor}`);
    if (this.entries.has(manifest.id)) throw new Error('bundle-already-registered');
    const capabilities = new Map(manifest.capabilities.map(c => [c.id, c]));
    if (capabilities.size !== manifest.capabilities.length) throw new Error('duplicate-capability');
    const visited = new Set<string>(); const active = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id)) throw new Error(`capability-cycle:${id}`);
      if (visited.has(id)) return;
      const c = capabilities.get(id); if (!c) throw new Error(`capability-dependency-missing:${id}`);
      active.add(id); for (const dependency of c.requires) visit(dependency); active.delete(id); visited.add(id);
    };
    for (const id of capabilities.keys()) visit(id);
    // Validate all files before running any factory. Metadata never substitutes for bytes.
    for (const component of Object.values(manifest.components)) for (const source of component.sources) {
      if (!load) throw new Error('bundle-source-loader-required');
      const bytes = load(structuredClone(source));
      if (bytes.byteLength > 32 * 1024 * 1024) throw new Error('bundle-artifact-too-large');
      if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`bundle-artifact-integrity-failed:${source.path}`);
    }
    const modules: Partial<ModuleByKind> = {};
    for (const kind of ComponentKind.options) {
      const factory = factories[kind];
      if (!factory) {
        if (manifest.capabilities.some(c => c.component === kind && c.implementation === 'available')) throw new Error(`bundle-component-missing:${kind}`);
        continue;
      }
      const component = factory(); const ref = manifest.components[kind];
      if (component.id !== ref.id || component.version !== ref.version || component.digest !== ref.digest) throw new Error(`bundle-component-mismatch:${kind}`);
      const method = { protocol: 'decode', data: 'query', geometryPhysics: 'shape', clientControl: 'binding' }[kind];
      if (typeof (component as unknown as Record<string, unknown>)[method] !== 'function') throw new Error(`bundle-component-port-missing:${kind}`);
      Object.assign(modules, { [kind]: component });
    }
    const locked = freeze(manifest);
    const bundle: ResolvedBundle = Object.freeze({
      manifest: locked,
      components: Object.freeze(modules),
      decode(frame: ProtocolFrame, options: { allowSynthetic?: boolean } = {}): PacketDecodeResult {
        if (frame.gameRelease !== locked.game.release || frame.protocol !== locked.game.protocol) return { status: 'invalid', reason: 'bundle-game-version-mismatch', affectedDomains: ['all'] };
        if (!frame.sessionId || !frame.connectionEpoch || !frame.registryEpoch || !frame.phase || !(frame.payload instanceof Uint8Array)) return { status: 'invalid', reason: 'frame-context-required', affectedDomains: ['all'] };
        const decision = bundle.assess(['protocol.decode'], options);
        if (!decision.available || !modules.protocol) return { status: 'unsupported', dependency: decision.reasons.join(','), affectedDomains: ['all'] };
        try {
          const result = modules.protocol.decode({ ...frame, payload: frame.payload.slice() });
          if (result.status === 'decoded') {
            if (result.consumedBytes !== frame.payload.byteLength) return { status: 'invalid', reason: 'packet-not-fully-consumed', affectedDomains: ['all'] };
            if (!Array.isArray(result.events) || result.events.length > 1024 || result.events.some(event => !['position', 'blocks', 'entities', 'inventory', 'chat', 'lifecycle'].includes(event.domain) || !event.kind || typeof event.payload !== 'object' || event.payload === null || !['client-reported', 'server-observed', 'synthetic'].includes(event.source))) return { status: 'invalid', reason: 'invalid-canonical-observation', affectedDomains: ['all'] };
            if (!options.allowSynthetic && result.events.some(event => event.source === 'synthetic')) return { status: 'invalid', reason: 'synthetic-observation-not-allowed', affectedDomains: ['all'] };
          } else if (!['unsupported', 'invalid'].includes(result.status)) return { status: 'invalid', reason: 'invalid-decoder-result', affectedDomains: ['all'] };
          return structuredClone(result);
        } catch { return { status: 'invalid', reason: 'packet-decoder-failed', affectedDomains: ['all'] }; }
      },
      assess(required: readonly string[], options: { allowSynthetic?: boolean } = {}): CapabilityDecision {
        const reasons = new Set<string>(); const selected = new Map<string, CapabilityDeclaration>();
        const check = (id: string) => {
          if (selected.has(id)) return;
          const c = capabilities.get(id);
          if (!c) { reasons.add(`capability-unknown:${id}`); return; }
          selected.set(id, c);
          if (c.implementation !== 'available' || !modules[c.component]) reasons.add(`capability-unimplemented:${id}`);
          if (c.coverage !== 'complete') reasons.add(`capability-coverage-${c.coverage}:${id}`);
          if (c.component === 'clientControl' && c.evidence !== 'client-calibrated' && !(options.allowSynthetic && c.evidence === 'synthetic-contract')) reasons.add(`capability-calibration-required:${id}`);
          if (c.evidence === 'none' || (c.evidence === 'synthetic-contract' && !options.allowSynthetic)) reasons.add(`capability-evidence-insufficient:${id}`);
          for (const dependency of c.requires) check(dependency);
        };
        for (const id of required) check(id);
        return { available: reasons.size === 0, reasons: [...reasons].sort(), capabilities: structuredClone([...selected.values()]) };
      },
    });
    this.entries.set(manifest.id, bundle);
    return bundle;
  }
  resolve(id: string, expected?: { release: string; protocol: number }): ResolvedBundle {
    const bundle = this.entries.get(id); if (!bundle) throw new Error(`bundle-not-registered:${id}`);
    if (expected && (bundle.manifest.game.release !== expected.release || bundle.manifest.game.protocol !== expected.protocol)) throw new Error('bundle-game-version-mismatch');
    return bundle;
  }
  list(): BundleManifest[] { return [...this.entries.values()].map(bundle => structuredClone(bundle.manifest)); }
}
