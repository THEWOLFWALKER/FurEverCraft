import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../src/execution/factory.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ManualClock } from '../../src/contracts/index.js';

describe('V01-V04 runtime integration fixtures', () => {
  it('drives goal, chat, execution, pause/resume, and event evidence through one runtime', async () => {
    const runtime = createRuntime({ bridge: new FakeClientBridge(), clock: new ManualClock() });
    try {
      expect((await runtime.control.command({ requestId: 'goal', command: 'goal.set', payload: { goalId: 'g', text: 'send a greeting' } })).state).toBe('terminal');
      expect((await runtime.control.command({ requestId: 'chat', command: 'chat', payload: { text: 'hello fixture' } })).state).toBe('terminal');
      expect((await runtime.control.command({ requestId: 'pause', command: 'pause', payload: {} })).state).toBe('terminal');
      expect(runtime.control.status().paused).toBe(true);
      expect((await runtime.control.command({ requestId: 'resume', command: 'resume', payload: {} })).state).toBe('terminal');
      const execution = await runtime.router.invoke({ id: 'skill', name: 'start_skill', arguments: JSON.stringify({ skill: 'place_one', x: 1, y: 0, proposalId: 'place-v' }) });
      expect(execution.ok).toBe(true);
      expect(runtime.control.executions().length).toBeGreaterThanOrEqual(1);
      expect(runtime.control.events('0', 100).events.map(event => event.kind)).toContain('control.goal.set');
    } finally {
      runtime.close();
    }
  });

  it('recovers an ambiguous bridge outcome with explicit evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-v-'));
    const db = join(dir, 'runtime.sqlite');
    const bridge = new FakeClientBridge(12, { faults: { place: { fault: 'ambiguous', count: 1 } } });
    try {
      const first = createRuntime({ db, bridge });
      try {
        const result = await first.router.invoke({ id: 'place-ambiguous', name: 'start_skill', arguments: JSON.stringify({ skill: 'place_one', x: 1, y: 0, proposalId: 'ambiguous-v' }) });
        expect(result.ok).toBe(false);
      } finally {
        first.close();
      }
      const recovered = createRuntime({ db, bridge });
      try {
        const recovery = recovered.session.start();
        expect(recovery.recovered).toBe(true);
        expect(recovery.reconciled.every(item => ['ambiguous', 'confirmed'].includes(item.status))).toBe(true);
      } finally {
        recovered.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
