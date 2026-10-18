import { z } from 'zod';
import minecraftData from 'minecraft-data';

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

/** Whether the pinned dependency manifest actually ships decodable 26.3 data. */
export function codecDataAvailable(): boolean {
  try { return Boolean(minecraftData('26.3')); } catch { return false; }
}

/**
 * Fail-closed gate for anything that would claim to handle real 26.3 traffic. A candidate
 * profile without installed 26.3 codec data is never "supported", and an unknown profile is
 * rejected rather than silently treated as the fixture.
 */
export function assertSupportedProfile(profile: GameVersionProfile): void {
  const parsed = GameVersionProfileSchema.safeParse(profile);
  if (!parsed.success) throw new Error('invalid-game-version-profile');
  if (parsed.data.status === 'unsupported') throw new Error('unsupported-game-version-profile');
  if (!codecDataAvailable()) throw new Error('game-version-codec-unavailable:26.3');
}
export function versionProfileSummary(profile = GAME_VERSION_PROFILE) {
  const codec = codecDataAvailable();
  const limitations = profile.status === 'available' && codec ? [] : ['candidate-adapter-not-live-verified', 'unsupported-item-components', 'real-client-not-tested'];
  if (!codec) limitations.push('26.3-codec-data-unavailable');
  return { release: profile.release, protocolVersion: profile.protocolVersion, dataVersion: profile.dataVersion, status: profile.status, codecDataAvailable: codec, limitations };
}
