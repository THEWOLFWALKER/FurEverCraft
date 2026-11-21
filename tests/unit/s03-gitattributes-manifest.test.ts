import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCandidate26_3Manifest,
  loadAdapterManifest,
  serializeAdapterManifest,
  verifyAdapterManifest,
} from '../../src/bridge/adapter/manifest.js';

function nativeFiles(dir = 'native'): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => entry.isDirectory() ? nativeFiles(join(dir, entry.name)) : [join(dir, entry.name)]);
}

describe('FEC-60 line endings and candidate manifest', () => {
  it('keeps native sources LF-only and pins them in .gitattributes', () => {
    const files = nativeFiles();
    expect(files).toContain(join('native', 'windows', 'FurEverCraft.Helper.ps1'));
    expect(files).toContain(join('native', 'windows', 'FurEverCraft.Helper.Core.cs'));
    for (const file of files) {
      const bytes = readFileSync(file);
      expect(bytes.includes(0x0d), `${file} contains CR bytes`).toBe(false);
    }
    const attributes = readFileSync('.gitattributes', 'utf8');
    expect(attributes).toMatch(/^native\/\*\*\s+text\s+eol=lf$/m);
    expect(attributes).toMatch(/^configs\/\*\*\s+text\s+eol=lf$/m);
  });

  it('candidate artifacts hash raw LF bytes and verify without hash/size mismatches', () => {
    const candidate = loadAdapterManifest('configs/adapters/target-26.3.candidate.json');
    const verification = verifyAdapterManifest(candidate, {
      rootDir: process.cwd(),
      expected: { release: '26.3', protocolVersion: 777, dataVersion: 5023 },
    });
    const artifactIssues = verification.issues.filter(issue => issue.code === 'artifact-hash-mismatch' || issue.code === 'artifact-size-mismatch' || issue.code === 'artifact-missing');
    expect(artifactIssues).toEqual([]);
    expect(candidate.status).toBe('unsupported');
    expect(candidate.provenance.native.verified).toBe(false);
    expect(verification.issues.some(issue => issue.code === 'native-provenance-unverified')).toBe(true);

    const paths = candidate.artifacts.map(artifact => artifact.path);
    expect(paths).toContain('native/windows/FurEverCraft.Helper.ps1');
    expect(paths).toContain('native/windows/FurEverCraft.Helper.Core.cs');
    for (const artifact of candidate.artifacts) {
      const bytes = readFileSync(resolve(process.cwd(), artifact.path));
      expect(bytes.length).toBe(artifact.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    }
  });

  it('regenerates the committed candidate byte-for-byte from installed files', () => {
    const generated = buildCandidate26_3Manifest(process.cwd());
    const committed = readFileSync('configs/adapters/target-26.3.candidate.json', 'utf8');
    expect(serializeAdapterManifest(generated.manifest)).toBe(committed);
    expect(generated.manifest.artifacts.map(artifact => artifact.path)).toContain('native/windows/FurEverCraft.Helper.Core.cs');
    expect(generated.manifest.status).toBe('unsupported');
  });
});
