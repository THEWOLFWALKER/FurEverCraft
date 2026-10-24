import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GAME_VERSION_PROFILE, assertSupportedProfile, codecDataAvailable, installedGameIdentity, versionProfileSummary } from '../../src/bridge/version-profile.js';

const fixtureRoot = (label: string) => mkdtempSync(join(tmpdir(), `furevercraft-vp-${label}-`));

/** Write the pinned-dependency shape the profile reads, without claiming it is real 26.3 data. */
function writeCodecFixture(root: string, entry: { minecraftVersion: string; version: number; dataVersion: number }): void {
  const dataDir = join(root, 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc');
  mkdirSync(join(dataDir, 'common'), { recursive: true });
  mkdirSync(join(dataDir, entry.minecraftVersion), { recursive: true });
  writeFileSync(join(dataDir, 'common', 'protocolVersions.json'), JSON.stringify([entry]));
  writeFileSync(join(dataDir, entry.minecraftVersion, 'version.json'), JSON.stringify({ version: entry.minecraftVersion }));
}

describe('26.3 version profile', () => {
  it('records candidate release and exact compatibility metadata', () => {
    expect(GAME_VERSION_PROFILE).toMatchObject({ release: '26.3', protocolVersion: 777, dataVersion: 5023, gameJavaRequirement: '25', inputBackend: 'SDL3', status: 'candidate' });
    expect(versionProfileSummary().limitations.length).toBeGreaterThan(0);
  });

  it('fails closed when the pinned dependency has no 26.3 codec data', () => {
    // Environment premise for this repository: the installed pinned catalogue has no 26.3 entry.
    expect(installedGameIdentity()).toBeUndefined();
    expect(codecDataAvailable()).toBe(false);

    // A labelled empty root drives the unavailable branch deterministically and unconditionally.
    const root = fixtureRoot('unavailable');
    try {
      expect(installedGameIdentity(root)).toBeUndefined();
      expect(codecDataAvailable(root)).toBe(false);
      const summary = versionProfileSummary(GAME_VERSION_PROFILE, { rootDir: root });
      expect(summary).toMatchObject({ codecDataAvailable: false, identityMatched: false, installedIdentity: null });
      expect(summary.reasons).toContain('26.3-codec-data-unavailable');
      expect(summary.limitations).toContain('26.3-codec-data-unavailable');
      expect(() => assertSupportedProfile(GAME_VERSION_PROFILE, { rootDir: root })).toThrow(/^game-version-codec-unavailable:26\.3$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches a labelled installed identity but still fails closed for a candidate profile', () => {
    const root = fixtureRoot('available');
    try {
      writeCodecFixture(root, { minecraftVersion: '26.3', version: 777, dataVersion: 5023 });
      expect(installedGameIdentity(root)).toMatchObject({ release: '26.3', protocolVersion: 777, dataVersion: 5023 });
      expect(codecDataAvailable(root)).toBe(true);
      const summary = versionProfileSummary(GAME_VERSION_PROFILE, { rootDir: root });
      expect(summary).toMatchObject({ codecDataAvailable: true, identityMatched: true, verified: false, available: false });
      expect(summary.reasons).not.toContain('26.3-codec-data-unavailable');
      expect(summary.limitations).not.toContain('26.3-codec-data-unavailable');
      // Availability of codec data is not enough: a candidate profile is still unsupported.
      expect(() => assertSupportedProfile(GAME_VERSION_PROFILE, { rootDir: root })).toThrow(/^game-version-profile-not-supported:candidate$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects mismatched and unsupported profiles', () => {
    expect(() => assertSupportedProfile({ ...GAME_VERSION_PROFILE, protocolVersion: 765 as 777 })).toThrow();
    expect(() => assertSupportedProfile({ ...GAME_VERSION_PROFILE, status: 'unsupported' })).toThrow('unsupported-game-version-profile');
  });
});
