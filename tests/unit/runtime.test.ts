import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { navigate } from '../../src/skills/navigation.js';
import { SQLiteStore } from '../../src/persistence/store.js';
import { ScriptedModelProvider } from '../../src/providers/scripted/index.js';
import { createRuntime } from '../../src/execution/factory.js';

describe('offline runtime', () => {
  it('navigates around barriers', () => { const b = new FakeClientBridge(); b.block(1, 0); const r = navigate(b, { x: 2, y: 1 }); expect(r.status).toBe('succeeded'); expect(b.position).toEqual({ x: 2, y: 1 }); });
  it('persists and reloads goals in an isolated sqlite directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-')); const db = join(dir, 'runtime.sqlite');
    try { const s = new SQLiteStore(db); s.saveGoal({ goalId: 'g', revision: 1, status: 'active', text: 'x' }); s.close(); const r = new SQLiteStore(db); expect(r.getGoal('g')?.spec.text).toBe('x'); r.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('scripted provider returns fixture', async () => { const p = new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]); expect((await p.complete([], [])).text).toBe('ok'); });
  it('factory assembles one bridge, store, router and loop', () => { const runtime = createRuntime(); expect(runtime.router).toBeDefined(); expect(runtime.loop).toBeDefined(); expect(runtime.bridge.context.serverProfileId).toBe('simulated'); runtime.close(); });
});
