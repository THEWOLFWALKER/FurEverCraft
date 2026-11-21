import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

/**
 * Versioned adapter manifest. Capability is reported per packet/domain as
 * `verified-fixture`, `experimental` or `unsupported`; there is deliberately no single
 * `supported: true` flag. A manifest cannot make 26.3 available when the pinned data is
 * absent: verification reports the missing artifacts/provenance instead.
 */
export const CapabilityStatusSchema = z.enum(['verified-fixture', 'experimental', 'unsupported']);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const AdapterProvenanceSchema = z.object({
  kind: z.enum(['schema', 'data', 'native']),
  source: z.string().min(1),
  version: z.string().min(1),
  commit: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  verified: z.boolean(),
  notes: z.array(z.string()).default([]),
}).strict().superRefine((value, context) => {
  if (value.verified && !value.sha256) context.addIssue({ code: z.ZodIssueCode.custom, message: 'verified provenance requires sha256' });
});
export type AdapterProvenance = z.infer<typeof AdapterProvenanceSchema>;

export const AdapterArtifactSchema = z.object({
  role: z.enum(['schema', 'data', 'native', 'fixture']),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
}).strict();
export type AdapterArtifact = z.infer<typeof AdapterArtifactSchema>;

export const AdapterDependencySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  commit: z.string().min(1).optional(),
  installed: z.boolean(),
}).strict();
export type AdapterDependency = z.infer<typeof AdapterDependencySchema>;

export const AdapterCapabilitySchema = z.object({
  domain: z.string().min(1),
  packet: z.string().min(1).optional(),
  status: CapabilityStatusSchema,
  evidence: z.enum(['fixture', 'synthetic', 'none']),
  limitations: z.array(z.string()).default([]),
}).strict().superRefine((value, context) => {
  // Status and evidence are two views of the same claim. A status that promises verified
  // fixture behaviour backed by nothing (or by synthetic data) is a contradiction, not a
  // capability, and must never be accepted by the schema.
  const expects: Record<CapabilityStatus, Array<'fixture' | 'synthetic' | 'none'>> = {
    'verified-fixture': ['fixture'],
    experimental: ['fixture', 'synthetic'],
    unsupported: ['none'],
  };
  if (!expects[value.status].includes(value.evidence)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: `evidence ${value.evidence} contradicts status ${value.status}` });
  }
});
export type AdapterCapability = z.infer<typeof AdapterCapabilitySchema>;

export const AdapterManifestSchema = z.object({
  manifestVersion: z.literal(1),
  release: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  dataVersion: z.number().int().positive(),
  javaRequirement: z.string().min(1),
  inputBackend: z.string().min(1),
  adapterVersion: z.string().min(1),
  status: CapabilityStatusSchema,
  dependencies: z.array(AdapterDependencySchema),
  provenance: z.object({ schema: AdapterProvenanceSchema, data: AdapterProvenanceSchema, native: AdapterProvenanceSchema }).strict(),
  artifacts: z.array(AdapterArtifactSchema),
  capabilities: z.array(AdapterCapabilitySchema).min(1),
  unavailableReasons: z.array(z.string()).default([]),
  generator: z.object({ tool: z.string().min(1), version: z.string().min(1), reproducible: z.literal(true) }).strict(),
}).strict().superRefine((value, context) => {
  // Provenance is keyed by role; an entry whose `kind` disagrees with its key would let a
  // schema artifact be presented as native (or vice versa) during hash comparison.
  for (const role of ['schema', 'data', 'native'] as const) {
    if (value.provenance[role].kind !== role) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['provenance', role, 'kind'], message: `provenance.${role}.kind must be ${role}` });
    }
  }
});
export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

export type ManifestInput = {
  rootDir: string;
  release: string;
  protocolVersion: number;
  dataVersion: number;
  javaRequirement: string;
  inputBackend: string;
  adapterVersion: string;
  status: CapabilityStatus;
  dependencies: AdapterDependency[];
  provenance: { schema: AdapterProvenance; data: AdapterProvenance; native: AdapterProvenance };
  artifacts: Array<{ path: string; role: AdapterArtifact['role'] }>;
  capabilities: AdapterCapability[];
  unavailableReasons?: string[];
};

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path: string): { sha256: string; bytes: number } {
  const content = readFileSync(path);
  return { sha256: sha256Bytes(content), bytes: content.length };
}

export type ArtifactPathResolution =
  | { ok: true; absolute: string; path: string }
  | { ok: false; path: string; reason: 'absolute-path' | 'outside-root' | 'symlink-outside-root' };

/**
 * Resolve a manifest artifact path and prove it stays inside rootDir. Absolute paths and
 * `..` traversal are rejected lexically; existing paths are additionally checked through
 * realpath so a symlink inside rootDir cannot point at content outside it.
 */
export function resolveArtifactPath(rootDir: string, artifactPath: string): ArtifactPathResolution {
  const displayPath = artifactPath.split('\\').join('/');
  // Windows drive/UNC paths are absolute even when the verifier runs on a POSIX host.
  if (isAbsolute(artifactPath) || /^[A-Za-z]:[\\/]/.test(artifactPath) || /^\\\\/.test(artifactPath)) {
    return { ok: false, path: displayPath, reason: 'absolute-path' };
  }
  const absolute = resolve(rootDir, artifactPath);
  const lexicalRelative = relative(rootDir, absolute);
  if (!lexicalRelative || lexicalRelative === '..' || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
    return { ok: false, path: displayPath, reason: 'outside-root' };
  }
  // realpath checks are only meaningful when the file exists; a missing file is reported
  // separately as artifact-missing rather than as a traversal attempt.
  try {
    const rootReal = realpathSync(rootDir);
    const targetReal = realpathSync(absolute);
    const realRelative = relative(rootReal, targetReal);
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
      return { ok: false, path: displayPath, reason: 'symlink-outside-root' };
    }
  } catch {
    // Keep the lexical decision; callers handle absence explicitly.
  }
  return { ok: true, absolute, path: lexicalRelative.split('\\').join('/') };
}

/** Deterministic manifest: artifact/capability order and JSON key order are stable. */
export function generateAdapterManifest(input: ManifestInput): AdapterManifest {
  const artifacts = input.artifacts.map(artifact => {
    const resolved = resolveArtifactPath(input.rootDir, artifact.path);
    if (!resolved.ok) throw new Error(`invalid-artifact-path:${resolved.reason}:${resolved.path}`);
    const hashed = sha256File(resolved.absolute);
    return {
      role: artifact.role,
      path: resolved.path,
      sha256: hashed.sha256,
      bytes: hashed.bytes,
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const capabilities = input.capabilities.map(capability => ({
    ...capability,
    limitations: [...capability.limitations].sort(),
  })).sort((left, right) => `${left.domain}::${left.packet ?? ''}`.localeCompare(`${right.domain}::${right.packet ?? ''}`));
  return {
    manifestVersion: 1,
    release: input.release,
    protocolVersion: input.protocolVersion,
    dataVersion: input.dataVersion,
    javaRequirement: input.javaRequirement,
    inputBackend: input.inputBackend,
    adapterVersion: input.adapterVersion,
    status: input.status,
    dependencies: [...input.dependencies].sort((left, right) => left.name.localeCompare(right.name)),
    provenance: input.provenance,
    artifacts,
    capabilities,
    unavailableReasons: [...(input.unavailableReasons ?? [])].sort(),
    generator: { tool: 'furevercraft-adapter-manifest', version: '1', reproducible: true },
  };
}

export function serializeAdapterManifest(manifest: AdapterManifest): string {
  // Validation before serialization keeps a hand-edited object from emitting an invalid manifest.
  return `${JSON.stringify(AdapterManifestSchema.parse(manifest), null, 2)}\n`;
}

export function writeAdapterManifest(manifest: AdapterManifest, outPath: string): void {
  writeFileSync(outPath, serializeAdapterManifest(manifest), 'utf8');
}

export function loadAdapterManifest(path: string): AdapterManifest {
  return AdapterManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export type ManifestIssue = { code: string; severity: 'blocker' | 'warning'; path?: string; message: string };
export type ManifestVerification = {
  ok: boolean;
  status: CapabilityStatus;
  available: boolean;
  checked: { artifacts: number; dependencies: number; capabilities: number };
  issues: ManifestIssue[];
};

export type VerifyManifestOptions = {
  rootDir: string;
  /** Verification is fail-closed: a manifest is only meaningful against an explicit target. */
  expected: { release: string; protocolVersion: number; dataVersion: number };
};

type DataIdentity = { release?: unknown; protocolVersion?: unknown; dataVersion?: unknown };
const REQUIRED_ARTIFACT_ROLES = ['schema', 'data', 'native'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract the version identity carried by a data artifact. minecraft-data ships the full
 * identity (including dataVersion) in pc/common/protocolVersions.json, while a per-release
 * version.json carries only the release and protocol. An array is treated as a version
 * catalogue and the entry for the expected release is selected.
 */
function readDataIdentity(value: unknown, release: string): DataIdentity | undefined {
  if (Array.isArray(value)) {
    const entry = value.find(item => isRecord(item) && (item.minecraftVersion === release || item.release === release));
    if (!isRecord(entry)) return undefined;
    return {
      release: entry.minecraftVersion ?? entry.release ?? entry.versionName,
      protocolVersion: entry.protocolVersion ?? entry.protocol ?? entry.version,
      dataVersion: entry.dataVersion ?? entry.data_version,
    };
  }
  if (!isRecord(value)) return undefined;
  return {
    release: value.minecraftVersion ?? value.release ?? value.versionName,
    protocolVersion: value.protocolVersion ?? value.protocol ?? value.version,
    dataVersion: value.dataVersion ?? value.data_version,
  };
}

function numbersEqual(observed: unknown, expected: number): boolean {
  return typeof observed === 'number' ? observed === expected : typeof observed === 'string' && observed.trim() !== '' && Number(observed) === expected;
}

/**
 * Verify manifest schema plus actual installed contents. A hash in a report is not trusted
 * on its own: artifacts are hashed from disk, provenance hashes are compared to those
 * artifacts, and data artifacts must identify the expected release. Missing 26.3 data
 * stays an explicit unavailable result.
 */
export function verifyAdapterManifest(input: unknown, options: VerifyManifestOptions): ManifestVerification {
  // Fail closed before touching any option or the filesystem: JavaScript callers can omit
  // the argument even though the type requires it.
  const failClosed = (code: string, path: string, message: string): ManifestVerification => ({
    ok: false,
    status: 'unsupported',
    available: false,
    checked: { artifacts: 0, dependencies: 0, capabilities: 0 },
    issues: [{ code, severity: 'blocker', path, message }],
  });
  if (!options || typeof options !== 'object') {
    return failClosed('verification-options-required', 'options', 'verification requires explicit options with rootDir and expected target');
  }
  if (typeof options.rootDir !== 'string' || options.rootDir.length === 0) {
    return failClosed('verification-rootdir-required', 'rootDir', 'verification requires a non-empty rootDir');
  }
  const parsed = AdapterManifestSchema.safeParse(input);
  const issues: ManifestIssue[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) issues.push({ code: 'invalid-schema', severity: 'blocker', path: issue.path.join('.'), message: issue.message });
    return { ok: false, status: 'unsupported', available: false, checked: { artifacts: 0, dependencies: 0, capabilities: 0 }, issues };
  }
  const manifest = parsed.data;
  // The option is required by the type, but JavaScript callers must fail closed too.
  if (!options || !options.expected) {
    issues.push({ code: 'expected-target-required', severity: 'blocker', path: 'expected', message: 'verification requires an explicit release/protocolVersion/dataVersion target' });
  } else {
    for (const key of ['release', 'protocolVersion', 'dataVersion'] as const) {
      if (manifest[key] !== options.expected[key]) {
        issues.push({ code: 'version-mismatch', severity: 'blocker', path: key, message: `${key} ${String(manifest[key])} != expected ${String(options.expected[key])}` });
      }
    }
  }
  const artifactHashes = new Map<string, { sha256: string; bytes: number }>();
  for (const artifact of manifest.artifacts) {
    const resolved = resolveArtifactPath(options.rootDir, artifact.path);
    if (!resolved.ok) {
      issues.push({ code: 'invalid-artifact-path', severity: 'blocker', path: artifact.path, message: `artifact path is ${resolved.reason}` });
      continue;
    }
    if (!existsSync(resolved.absolute)) {
      issues.push({ code: 'artifact-missing', severity: 'blocker', path: artifact.path, message: 'artifact file is missing' });
      continue;
    }
    const hashed = sha256File(resolved.absolute);
    artifactHashes.set(artifact.path, hashed);
    if (hashed.sha256 !== artifact.sha256) issues.push({ code: 'artifact-hash-mismatch', severity: 'blocker', path: artifact.path, message: 'sha256 does not match installed content' });
    if (hashed.bytes !== artifact.bytes) issues.push({ code: 'artifact-size-mismatch', severity: 'blocker', path: artifact.path, message: 'byte length does not match installed content' });
    if (artifact.role === 'native' && !manifest.provenance.native.verified) {
      issues.push({ code: 'native-provenance-unverified', severity: 'blocker', path: artifact.path, message: 'native artifact is not provenance-verified' });
    }
    if (artifact.role === 'data') {
      // A file hashing correctly is not enough: its JSON has to identify the target release.
      const expectedTarget: { release: string; protocolVersion: number; dataVersion: number } | undefined = options?.expected;
      const targetRelease = expectedTarget?.release ?? manifest.release;
      let identity: DataIdentity | undefined;
      try {
        identity = readDataIdentity(JSON.parse(readFileSync(resolved.absolute, 'utf8')), targetRelease);
      } catch {
        issues.push({ code: 'data-artifact-invalid-json', severity: 'blocker', path: artifact.path, message: 'data artifact is not parseable JSON' });
      }
      if (identity === undefined) {
        issues.push({ code: 'data-release-mismatch', severity: 'blocker', path: artifact.path, message: `data artifact has no entry for ${targetRelease}` });
      } else if (expectedTarget) {
        if (identity.release === undefined) issues.push({ code: 'data-release-missing', severity: 'blocker', path: artifact.path, message: 'data artifact does not declare a release' });
        else if (String(identity.release) !== expectedTarget.release) issues.push({ code: 'data-release-mismatch', severity: 'blocker', path: artifact.path, message: `data artifact release ${String(identity.release)} != expected ${expectedTarget.release}` });
        if (identity.protocolVersion === undefined) issues.push({ code: 'data-protocol-version-missing', severity: 'blocker', path: artifact.path, message: 'data artifact does not declare a protocol version' });
        else if (!numbersEqual(identity.protocolVersion, expectedTarget.protocolVersion)) issues.push({ code: 'data-protocol-version-mismatch', severity: 'blocker', path: artifact.path, message: `data artifact protocol ${String(identity.protocolVersion)} != expected ${expectedTarget.protocolVersion}` });
        if (identity.dataVersion === undefined) issues.push({ code: 'data-data-version-missing', severity: 'blocker', path: artifact.path, message: 'data artifact does not declare a data version' });
        else if (!numbersEqual(identity.dataVersion, expectedTarget.dataVersion)) issues.push({ code: 'data-data-version-mismatch', severity: 'blocker', path: artifact.path, message: `data artifact dataVersion ${String(identity.dataVersion)} != expected ${expectedTarget.dataVersion}` });
      }
    }
  }
  // All three provenance roles need a corresponding artifact, and any declared provenance
  // hash has to match the bytes actually installed for that role.
  for (const role of REQUIRED_ARTIFACT_ROLES) {
    const roleArtifacts = manifest.artifacts.filter(artifact => artifact.role === role);
    if (roleArtifacts.length === 0) {
      issues.push({ code: 'artifact-role-missing', severity: 'blocker', path: `artifacts.${role}`, message: `no ${role} artifact is declared` });
    }
    const provenanceHash = manifest.provenance[role].sha256;
    if (provenanceHash) {
      const installedHashes = roleArtifacts
        .map(artifact => artifactHashes.get(artifact.path)?.sha256)
        .filter((hash): hash is string => hash !== undefined);
      if (!installedHashes.includes(provenanceHash)) {
        issues.push({ code: 'provenance-hash-mismatch', severity: 'blocker', path: `provenance.${role}.sha256`, message: `provenance sha256 does not match any installed ${role} artifact` });
      }
    }
  }
  if (manifest.provenance.native.verified && !manifest.artifacts.some(artifact => artifact.role === 'native')) {
    issues.push({ code: 'native-missing', severity: 'blocker', path: 'provenance.native', message: 'verified native provenance requires a native artifact' });
  }
  // A manifest may pin minecraft-data yet the installed tree may lack the target release.
  // That is an external data block, never something a hash in the manifest can paper over.
  const minecraftData = manifest.dependencies.find(dependency => dependency.name === 'minecraft-data');
  if (minecraftData) {
    const dataPath = `node_modules/minecraft-data/minecraft-data/data/pc/${manifest.release}/version.json`;
    if (!existsSync(resolve(options.rootDir, dataPath))) {
      issues.push({ code: 'adapter-data-absent', severity: 'blocker', path: dataPath, message: `installed minecraft-data ${minecraftData.version} has no ${manifest.release} protocol data` });
    }
  }
  let checkedDependencies = 0;
  for (const dependency of manifest.dependencies) {
    if (!dependency.installed) {
      issues.push({ code: 'dependency-not-installed', severity: 'blocker', path: `dependencies.${dependency.name}`, message: 'pinned dependency is not installed' });
      continue;
    }
    const packagePath = resolve(options.rootDir, 'node_modules', dependency.name, 'package.json');
    if (!existsSync(packagePath)) {
      issues.push({ code: 'dependency-missing', severity: 'blocker', path: `dependencies.${dependency.name}`, message: 'installed package is missing' });
      continue;
    }
    checkedDependencies += 1;
    const installedVersion = (JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown }).version;
    if (installedVersion !== dependency.version) {
      issues.push({ code: 'dependency-version-mismatch', severity: 'blocker', path: `dependencies.${dependency.name}`, message: `installed ${String(installedVersion)} != pinned ${dependency.version}` });
    }
  }
  for (const reason of manifest.unavailableReasons) {
    issues.push({ code: 'data-unavailable', severity: 'warning', path: 'unavailableReasons', message: reason });
  }
  if (manifest.status === 'unsupported') {
    issues.push({ code: 'adapter-unsupported', severity: 'warning', path: 'status', message: 'adapter status is unsupported' });
  }
  const allUnsupported = manifest.capabilities.every(capability => capability.status === 'unsupported');
  if (allUnsupported && manifest.status !== 'unsupported') {
    issues.push({ code: 'capability-matrix-all-unsupported', severity: 'blocker', path: 'capabilities', message: 'a manifest whose capabilities are all unsupported cannot be available' });
  }
  const blockers = issues.filter(issue => issue.severity === 'blocker');
  const hasSupportedDomain = manifest.capabilities.some(capability => capability.status !== 'unsupported');
  return {
    ok: blockers.length === 0,
    status: manifest.status,
    available: blockers.length === 0 && manifest.status !== 'unsupported' && manifest.unavailableReasons.length === 0 && hasSupportedDomain,
    checked: { artifacts: manifest.artifacts.length, dependencies: checkedDependencies, capabilities: manifest.capabilities.length },
    issues,
  };
}

export function digestManifest(manifest: AdapterManifest): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, normalize((value as Record<string, unknown>)[key])]));
    }
    return value;
  };
  return sha256Bytes(Buffer.from(JSON.stringify(normalize(manifest)), 'utf8'));
}

export type CapabilityMatrix = {
  release: string;
  adapterVersion: string;
  available: boolean;
  domains: AdapterCapability[];
  counts: Record<CapabilityStatus, number>;
  unavailableReasons: string[];
};

/**
 * Public capability matrix. It never collapses capability into one supported boolean, and it
 * cannot be produced without a verification result: the `available` flag is the verifier's
 * conclusion, not a claim the manifest makes about itself.
 */
export function capabilityMatrix(manifest: AdapterManifest, verification: ManifestVerification): CapabilityMatrix {
  if (!verification) throw new Error('capability-matrix-requires-verification');
  const counts: Record<CapabilityStatus, number> = { 'verified-fixture': 0, experimental: 0, unsupported: 0 };
  for (const capability of manifest.capabilities) counts[capability.status] += 1;
  const hasSupportedDomain = manifest.capabilities.some(capability => capability.status !== 'unsupported');
  return {
    release: manifest.release,
    adapterVersion: manifest.adapterVersion,
    available: verification.ok && verification.available && hasSupportedDomain && manifest.status !== 'unsupported' && manifest.unavailableReasons.length === 0,
    domains: manifest.capabilities.map(capability => ({ ...capability, limitations: [...capability.limitations] })),
    counts,
    unavailableReasons: [...manifest.unavailableReasons],
  };
}

/** Capability matrix for the legacy codec fixture, kept explicitly separate from 26.3. */
export function fixtureCapabilityMatrix(): CapabilityMatrix {
  const capabilities: AdapterCapability[] = [
    { domain: 'framing', status: 'verified-fixture', evidence: 'fixture', limitations: ['loopback-only'] },
    { domain: 'compression', status: 'experimental', evidence: 'synthetic', limitations: ['no-live-26.3-control-anchor'] },
    { domain: 'position', status: 'verified-fixture', evidence: 'fixture', limitations: ['legacy-2d-fixture'] },
    { domain: 'blocks', status: 'unsupported', evidence: 'none', limitations: ['no-26.3-schema'] },
    { domain: 'entities', status: 'unsupported', evidence: 'none', limitations: ['no-26.3-schema'] },
    { domain: 'inventory', status: 'unsupported', evidence: 'none', limitations: ['unknown-item-components'] },
    { domain: 'chat', status: 'verified-fixture', evidence: 'fixture', limitations: ['loopback-only'] },
    { domain: 'lifecycle', status: 'experimental', evidence: 'synthetic', limitations: ['no-live-26.3-observation'] },
  ];
  return {
    release: '1.20.4',
    adapterVersion: 'legacy-codec-fixture',
    available: true,
    domains: capabilities,
    counts: { 'verified-fixture': 3, experimental: 2, unsupported: 3 },
    unavailableReasons: ['not-a-26.3-adapter'],
  };
}

/**
 * Reproducible generation entry for the legacy loopback fixture manifest. It hashes the
 * installed pinned files; it is never presented as a 26.3/live adapter.
 */
export function buildFixtureManifest(rootDir: string): AdapterManifest {
  const versionPath = 'node_modules/minecraft-data/minecraft-data/data/pc/1.20.4/version.json';
  const protocolVersionsPath = 'node_modules/minecraft-data/minecraft-data/data/pc/common/protocolVersions.json';
  const nativePath = 'native/windows/FurEverCraft.Helper.ps1';
  const versionHash = sha256File(join(rootDir, versionPath));
  const protocolVersionsHash = sha256File(join(rootDir, protocolVersionsPath));
  const nativeHash = sha256File(join(rootDir, nativePath));
  const matrix = fixtureCapabilityMatrix();
  return generateAdapterManifest({
    rootDir,
    release: '1.20.4',
    protocolVersion: 765,
    dataVersion: 3700,
    javaRequirement: '17',
    inputBackend: 'SDL3',
    adapterVersion: 'legacy-codec-fixture',
    status: 'verified-fixture',
    dependencies: [
      { name: 'minecraft-data', version: '3.87.0', installed: true },
      { name: 'minecraft-protocol', version: '1.57.0', installed: true },
    ],
    provenance: {
      schema: { kind: 'schema', source: versionPath, version: '1.20.4', sha256: versionHash.sha256, verified: true, notes: ['legacy fixture only'] },
      // The per-release version.json does not carry a dataVersion; the pinned catalogue does.
      data: { kind: 'data', source: protocolVersionsPath, version: '1.20.4', sha256: protocolVersionsHash.sha256, verified: true, notes: ['legacy fixture only'] },
      native: { kind: 'native', source: nativePath, version: 'unhashed-candidate', sha256: nativeHash.sha256, verified: true, notes: ['repository hash verified; no real Windows input in this batch'] },
    },
    artifacts: [
      { path: versionPath, role: 'schema' },
      { path: protocolVersionsPath, role: 'data' },
      { path: nativePath, role: 'native' },
      { path: 'node_modules/minecraft-data/package.json', role: 'fixture' },
      { path: 'node_modules/minecraft-protocol/package.json', role: 'fixture' },
    ],
    capabilities: matrix.domains,
    unavailableReasons: [],
  });
}

const CANDIDATE_26_3_DOMAINS = ['framing', 'compression', 'position', 'blocks', 'entities', 'inventory', 'chat', 'lifecycle', 'registry'] as const;

export type Candidate26_3Generation = {
  manifest: AdapterManifest;
  /** Exact installed-tree evidence used to decide the adapter stays unavailable. */
  evidence: {
    dataPath: string;
    dataPresent: boolean;
    nativePath: string;
    nativePresent: boolean;
    schemaPresent: boolean;
  };
};

/**
 * Reproducible generation entry for the 26.3 candidate manifest.
 *
 * It hashes what is actually installed and records why the adapter stays unavailable. It
 * never invents packet fields or promotes research commit references to verified content.
 * The pinned dependency tree has no data/pc/26.3 directory, so every domain remains
 * `unsupported` with an exact reason.
 */
export function buildCandidate26_3Manifest(rootDir: string): Candidate26_3Generation {
  const dataPath = 'node_modules/minecraft-data/minecraft-data/data/pc/26.3/version.json';
  const nativePath = 'native/windows/FurEverCraft.Helper.ps1';
  const corePath = 'native/windows/FurEverCraft.Helper.Core.cs';
  const schemaPresent = existsSync(resolve(rootDir, 'node_modules/minecraft-data/minecraft-data/data/pc/26.3/protocol.json'));
  const dataPresent = existsSync(resolve(rootDir, dataPath));
  const nativePresent = existsSync(resolve(rootDir, nativePath));
  if (!nativePresent) throw new Error(`candidate-native-missing:${nativePath}`);
  if (!existsSync(resolve(rootDir, corePath))) throw new Error(`candidate-native-missing:${corePath}`);
  const artifacts: ManifestInput['artifacts'] = [
    { path: nativePath, role: 'native' },
    { path: corePath, role: 'native' },
    { path: 'node_modules/minecraft-data/package.json', role: 'fixture' },
    { path: 'node_modules/minecraft-protocol/package.json', role: 'fixture' },
  ];
  const unavailableReasons = [
    dataPresent ? '26.3-data-present-but-unverified: fixture provenance has not been validated' : `26.3-protocol-data-absent: ${dataPath}`,
    schemaPresent ? '26.3-schema-present-but-unverified: schema provenance has not been validated' : '26.3-schema-unavailable: no verified 26.3 protocol schema (protocol 777, data 5023)',
    '26.3-native-provenance-unverified: native helper has no validated Windows-host provenance',
  ];
  const manifest = generateAdapterManifest({
    rootDir,
    release: '26.3',
    protocolVersion: 777,
    dataVersion: 5023,
    javaRequirement: '25',
    inputBackend: 'SDL3',
    adapterVersion: 'furevercraft-26.3-candidate',
    status: 'unsupported',
    dependencies: [
      { name: 'minecraft-data', version: '3.87.0', commit: '924e26d6b3bb8f97a5d1e73d6190b09879c2e1e2', installed: true },
      { name: 'minecraft-protocol', version: '1.57.0', commit: 'a1a33809c49553e544a7efd3d8bc03eb0867f4ab', installed: true },
    ],
    provenance: {
      schema: { kind: 'schema', source: 'minecraft-data pc/26.3 protocol schema', version: '26.3', verified: false, notes: ['research reference only; not installed'] },
      data: { kind: 'data', source: dataPath, version: '26.3', commit: '924e26d6b3bb8f97a5d1e73d6190b09879c2e1e2', verified: false, notes: ['dataVersion 5023 has no verified fixture in the pinned tree'] },
      native: { kind: 'native', source: nativePath, version: 'unhashed-candidate', verified: false, notes: ['not validated on a real Windows host in this batch'] },
    },
    artifacts,
    capabilities: CANDIDATE_26_3_DOMAINS.map(domain => ({
      domain,
      status: 'unsupported' as const,
      evidence: 'none' as const,
      limitations: ['26.3-codec-data-unavailable'],
    })),
    unavailableReasons,
  });
  return { manifest, evidence: { dataPath, dataPresent, nativePath, nativePresent, schemaPresent } };
}
