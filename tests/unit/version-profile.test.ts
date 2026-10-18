import { describe, expect, it } from 'vitest';
import { GAME_VERSION_PROFILE, assertSupportedProfile, codecDataAvailable, versionProfileSummary } from '../../src/bridge/version-profile.js';
describe('26.3 version profile', () => {
  it('records candidate release and exact compatibility metadata', () => {
    expect(GAME_VERSION_PROFILE).toMatchObject({ release: '26.3', protocolVersion: 777, dataVersion: 5023, gameJavaRequirement: '25', inputBackend: 'SDL3', status: 'candidate' });
    expect(versionProfileSummary().limitations.length).toBeGreaterThan(0);
  });
  it('fails closed when the pinned dependency has no 26.3 codec data', () => {
    const codec = codecDataAvailable();
    expect(versionProfileSummary().codecDataAvailable).toBe(codec);
    if (!codec) {
      expect(versionProfileSummary().limitations).toContain('26.3-codec-data-unavailable');
      expect(() => assertSupportedProfile(GAME_VERSION_PROFILE)).toThrow('game-version-codec-unavailable:26.3');
    }
  });
  it('rejects mismatched and unsupported profiles', () => {
    expect(() => assertSupportedProfile({ ...GAME_VERSION_PROFILE, protocolVersion: 765 as 777 })).toThrow();
    expect(() => assertSupportedProfile({ ...GAME_VERSION_PROFILE, status: 'unsupported' })).toThrow('unsupported-game-version-profile');
  });
});
