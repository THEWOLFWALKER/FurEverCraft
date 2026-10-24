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
  it('factory assembles one bridge, store, router and loop', async () => {
    const runtime = createRuntime();
    try {
      expect(runtime.loop).toBeDefined();
      // Invoke a read-only tool through the router and compare it with the runtime's bridge.
      const snapshot = runtime.bridge.snapshot();
      const state = await runtime.router.invoke({ id: 'state-1', name: 'get_state', arguments: '{}' });
      expect(state).toMatchObject({
        ok: true,
        result: {
          mode: 'legacy-2d', threeDimensional: false, legacy2d: true,
          source: 'simulated', freshness: 'current', revision: snapshot.revision, gap: false,
          position: snapshot.position, inventory: snapshot.inventory, ui: snapshot.ui,
        },
      });

      // The router reads the same store instance the runtime exposes.
      runtime.store.saveExecution({ executionId: 'exec-shared', proposalId: 'proposal-shared', proposalHash: 'hash-shared', goalId: 'goal-shared', skillId: 'observe_ui', skillVersion: '1.0.0', status: 'queued', context: runtime.bridge.context });
      const execution = await runtime.router.invoke({ id: 'execution-1', name: 'get_execution', arguments: JSON.stringify({ executionId: 'exec-shared' }) });
      expect(execution).toMatchObject({ ok: true, result: { executionId: 'exec-shared', proposalId: 'proposal-shared', goalId: 'goal-shared' } });

      // The router's event reader is the runtime's own event hub.
      runtime.session.events.publish('runtime.test-marker', { marker: 'shared' });
      const read = await runtime.router.invoke({ id: 'events-1', name: 'read_events', arguments: JSON.stringify({ cursor: '0', limit: 10 }) });
      expect(read.ok).toBe(true);
      const readResult = read.result as { events: Array<{ seq: string; kind: string; payload: unknown }>; next: string };
      expect(readResult.events).toContainEqual(expect.objectContaining({ kind: 'runtime.test-marker', payload: { marker: 'shared' } }));
      expect(readResult.next).toBe(readResult.events.at(-1)!.seq);
    } finally { runtime.close(); }
  });
});
