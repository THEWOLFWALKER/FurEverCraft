import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const GameVersionProfileSchema = z.object({
  edition: z.literal('java'), release: z.literal('26.3'), protocolVersion: z.literal(777), dataVersion: z.literal(5023),
  gameJavaRequirement: z.literal('25'), inputBackend: z.literal('SDL3'), adapterVersion: z.string().min(1),
  dependencyManifestRef: z.string().min(1), dataManifestRef: z.string().min(1), validationProfileRefs: z.array(z.string()),
  status: z.enum(['candidate', 'available', 'unsupported']),
}).strict();
export type GameVersionProfile = z.infer<typeof GameVersionProfileSchema>;
export const GAME_VERSION_PROFILE: GameVersionProfile = {
  edition: 'java', release: '26.3', protocolVersion: 777, dataVersion: 5023, gameJavaRequirement: '25', inputBackend: 'SDL3',
  adapterVersion: 'furevercraft-26.3-candidate',
  dependencyManifestRef: 'minecraft-data#924e26d6b3bb8f97a5d1e73d6190b09879c2e1e2;node-minecraft-protocol#a1a33809c49553e544a7efd3d8bc03eb0867f4ab',
  dataManifestRef: 'minecraft-data#1301 + node-minecraft-protocol#1538 + prismarine-chunk#334',
  validationProfileRefs: ['schema-fixture', 'vecDelta#f8f8a20a300e9bf3914580b8cea6573691c55036'], status: 'candidate',
};
export function getGameVersionProfile(): GameVersionProfile { return { ...GAME_VERSION_PROFILE, validationProfileRefs: [...GAME_VERSION_PROFILE.validationProfileRefs] }; }

/** Verified identity of the codec data actually installed in the pinned dependency tree. */
export type InstalledGameIdentity = {
  release: string;
  protocolVersion: number;
  dataVersion: number;
  versionName?: string;
  /** Relative path of the installed per-release data marker. */
  dataPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the installed identity from the pinned minecraft-data catalogue. The per-release
 * `version.json` only proves a data directory exists; protocolVersion and dataVersion come
 * from `pc/common/protocolVersions.json`. Absence of either is treated as unavailable rather
 * than filled in from the profile's claims.
 */
export function installedGameIdentity(rootDir = process.cwd(), release = GAME_VERSION_PROFILE.release): InstalledGameIdentity | undefined {
  const cataloguePath = join(rootDir, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', 'common', 'protocolVersions.json');
  let catalogue: unknown;
  try {
    catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(catalogue)) return undefined;
  const entry = catalogue.find(item => isRecord(item) && item.minecraftVersion === release);
  if (!isRecord(entry)) return undefined;
  const protocolVersion = entry.version ?? entry.protocolVersion;
  const dataVersion = entry.dataVersion ?? entry.data_version;
  if (typeof protocolVersion !== 'number' || typeof dataVersion !== 'number') return undefined;
  const dataPath = join('node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', release, 'version.json');
  if (!existsSync(join(rootDir, dataPath))) return undefined;
  return {
    release,
    protocolVersion,
    dataVersion,
    versionName: typeof entry.minecraftVersion === 'string' ? entry.minecraftVersion : undefined,
    dataPath: dataPath.split('\\').join('/'),
  };
}

/** Whether the pinned dependency manifest actually ships decodable 26.3 data. */
export function codecDataAvailable(rootDir = process.cwd()): boolean {
  return installedGameIdentity(rootDir) !== undefined;
}

/**
 * Verification supplied by the adapter-manifest gate. Availability is never inferred from
 * the profile declaring itself available; only a passing verification for the same target
 * can satisfy the gate.
 */
export type GameVersionVerification = {
  release: string;
  protocolVersion: number;
  dataVersion: number;
  ok: boolean;
  available: boolean;
  status: 'verified-fixture' | 'experimental' | 'unsupported';
};

export type VersionProfileAvailability = {
  release: string;
  protocolVersion: number;
  dataVersion: number;
  status: GameVersionProfile['status'];
  installedIdentity: InstalledGameIdentity | null;
  identityMatched: boolean;
  codecDataAvailable: boolean;
  verified: boolean;
  available: boolean;
  reasons: string[];
  limitations: string[];
};

export type VersionProfileOptions = {
  rootDir?: string;
  verification?: GameVersionVerification | null;
};

/** Truthful availability summary for the profile and the verified manifest, if one is given. */
export function versionProfileAvailability(profile: GameVersionProfile = GAME_VERSION_PROFILE, options: VersionProfileOptions = {}): VersionProfileAvailability {
  const reasons: string[] = [];
  const installedIdentity = installedGameIdentity(options.rootDir ?? process.cwd(), profile.release) ?? null;
  const codecAvailable = installedIdentity !== null;
  if (!codecAvailable) reasons.push('26.3-codec-data-unavailable');
  const identityMatched = installedIdentity !== null
    && installedIdentity.release === profile.release
    && installedIdentity.protocolVersion === profile.protocolVersion
    && installedIdentity.dataVersion === profile.dataVersion;
  if (installedIdentity && !identityMatched) reasons.push('installed-identity-mismatch');
  const verification = options.verification ?? null;
  const verified = verification !== null
    && verification.ok === true
    && verification.available === true
    && verification.status !== 'unsupported'
    && verification.release === profile.release
    && verification.protocolVersion === profile.protocolVersion
    && verification.dataVersion === profile.dataVersion;
  if (!verified) reasons.push('manifest-not-verified');
  if (profile.status !== 'available') reasons.push(`profile-status-${profile.status}`);
  const available = codecAvailable && identityMatched && verified && profile.status === 'available';
  const limitations = available ? [] : ['candidate-adapter-not-live-verified', 'unsupported-item-components', 'real-client-not-tested'];
  if (!codecAvailable) limitations.push('26.3-codec-data-unavailable');
  return {
    release: profile.release,
    protocolVersion: profile.protocolVersion,
    dataVersion: profile.dataVersion,
    status: profile.status,
    installedIdentity,
    identityMatched,
    codecDataAvailable: codecAvailable,
    verified,
    available,
    reasons,
    limitations,
  };
}

/**
 * Fail-closed gate for anything that would claim to handle real 26.3 traffic. It compares
 * the profile's claimed identity against the installed pinned data and requires a passing
 * manifest verification; a `candidate` profile can never pass merely because a dependency
 * happens to be installed.
 */
export function assertSupportedProfile(profile: GameVersionProfile, options: VersionProfileOptions = {}): void {
  const parsed = GameVersionProfileSchema.safeParse(profile);
  if (!parsed.success) throw new Error('invalid-game-version-profile');
  if (parsed.data.status === 'unsupported') throw new Error('unsupported-game-version-profile');
  const availability = versionProfileAvailability(parsed.data, options);
  if (!availability.codecDataAvailable) throw new Error(`game-version-codec-unavailable:${parsed.data.release}`);
  if (!availability.identityMatched) {
    const installed = availability.installedIdentity;
    const field = installed
      ? (installed.release !== parsed.data.release ? 'release' : installed.protocolVersion !== parsed.data.protocolVersion ? 'protocolVersion' : 'dataVersion')
      : 'installed';
    throw new Error(`game-version-identity-mismatch:${field}`);
  }
  if (parsed.data.status !== 'available') throw new Error(`game-version-profile-not-supported:${parsed.data.status}`);
  if (!availability.verified) throw new Error(`game-version-not-verified:${parsed.data.release}`);
}

export function versionProfileSummary(profile: GameVersionProfile = GAME_VERSION_PROFILE, options: VersionProfileOptions = {}) {
  const availability = versionProfileAvailability(profile, options);
  return {
    release: availability.release,
    protocolVersion: availability.protocolVersion,
    dataVersion: availability.dataVersion,
    status: availability.status,
    codecDataAvailable: availability.codecDataAvailable,
    installedIdentity: availability.installedIdentity,
    identityMatched: availability.identityMatched,
    verified: availability.verified,
    available: availability.available,
    reasons: availability.reasons,
    limitations: availability.limitations,
  };
}
