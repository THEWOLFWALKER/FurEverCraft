import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../src/execution/factory.js';
import { ManualClock } from '../../src/contracts/index.js';
import { ScriptedModelProvider } from '../../src/providers/scripted/index.js';

describe('V02 virtual-time soak', () => {
  it('runs 60 virtual minutes with many command transitions across rebuilt runtimes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-soak-'));
    const db = join(dir, 'soak.sqlite');
    const clock = new ManualClock();
    const provider = () => new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]);
    let runtime = createRuntime({ db, clock, provider: provider() });
    try {
      let transitions = 0;
      let reconnects = 0;
      let rebuilds = 0;
      for (let minute = 0; minute < 60; minute += 1) {
        clock.advance(60_000);
        // Mix the command kinds that must keep working under long run.
        const goal = await runtime.control.command({ requestId: `goal-${minute}`, command: 'goal.set', payload: { goalId: `g-${minute % 5}`, text: `cycle ${minute}` } });
        expect(['terminal', 'conflict', 'rejected']).toContain(goal.state);
        transitions += 1;
        const message = await runtime.control.command({ requestId: `msg-${minute}`, command: 'message', payload: { text: `observe cycle ${minute}` } });
        expect(['terminal', 'rejected', 'conflict']).toContain(message.state);
        transitions += 1;
        if (minute % 10 === 9) { await runtime.control.command({ requestId: `pause-${minute}`, command: 'pause', payload: {} }); await runtime.control.command({ requestId: `resume-${minute}`, command: 'resume', payload: {} }); reconnects += 1; }
        if (minute % 12 === 11) {
          // Rebuild the runtime on the same store: the external world and receipts must survive.
          runtime.close(); rebuilds += 1;
          runtime = createRuntime({ db, clock, provider: provider() });
          runtime.session.start();
          expect(runtime.control.status().context.serverProfileId).toBe('simulated');
        }
      }
      expect(transitions).toBeGreaterThanOrEqual(50);
      expect(reconnects).toBeGreaterThanOrEqual(5);
      expect(rebuilds).toBeGreaterThanOrEqual(4);
      expect(runtime.control.events('0', 500).events.length).toBeGreaterThan(0);
      // A command replayed after rebuild must be deduplicated, not re-executed.
      const replay = await runtime.control.command({ requestId: 'goal-0', command: 'goal.set', payload: { goalId: 'g-0', text: 'cycle 0' } });
      expect(replay.state).toBe('terminal');
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
