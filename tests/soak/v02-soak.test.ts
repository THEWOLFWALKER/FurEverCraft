import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../src/execution/factory.js';
import { ManualClock } from '../../src/contracts/index.js';
import { ScriptedModelProvider } from '../../src/providers/scripted/index.js';
import { commandScopeOf } from '../../src/control/service.js';

describe('V02 virtual-time soak', () => {
  it('runs 60 virtual minutes with many command transitions across rebuilt runtimes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-soak-'));
    const db = join(dir, 'soak.sqlite');
    const clock = new ManualClock();
    const provider = () => new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]);
    let runtime = createRuntime({ db, clock, provider: provider() });
    try {
      for (let minute = 0; minute < 60; minute += 1) {
        clock.advance(60_000);
        // Mix the command kinds that must keep working under long run. Every goal.set uses a
        // unique requestId and goalId + next revision, so a terminal result is the only truthful
        // outcome; accepting conflict/rejected here would let a broken write path pass.
        const goalId = `g-${minute % 5}`;
        const goal = await runtime.control.command({ requestId: `goal-${minute}`, command: 'goal.set', payload: { goalId, text: `cycle ${minute}` } });
        expect(goal.state).toBe('terminal');
        expect(goal.result).toMatchObject({ goal_id: goalId, revision: Math.floor(minute / 5) + 1, spec: { text: `cycle ${minute}` } });
        const message = await runtime.control.command({ requestId: `msg-${minute}`, command: 'message', payload: { text: `observe cycle ${minute}` } });
        expect(message.state).toBe('terminal');
        expect(message.result).toMatchObject({ response: { stopReason: 'end_turn', text: 'ok' } });
        if (minute % 10 === 9) {
          const pause = await runtime.control.command({ requestId: `pause-${minute}`, command: 'pause', payload: {} });
          expect(pause.state).toBe('terminal');
          const resume = await runtime.control.command({ requestId: `resume-${minute}`, command: 'resume', payload: {} });
          expect(resume.state).toBe('terminal');
        }
        if (minute % 12 === 11) {
          // Rebuild the runtime on the same store: the external world and receipts must survive.
          runtime.close();
          runtime = createRuntime({ db, clock, provider: provider() });
          runtime.session.start();
          expect(runtime.control.status().context.serverProfileId).toBe('simulated');
        }
      }
      // Persisted goals are the authority: five goals, each written twelve times with no skipped revision.
      const goals = runtime.store.listGoals();
      expect(goals).toHaveLength(5);
      expect(goals.map(goal => [goal.goal_id, goal.revision, goal.spec.text])).toEqual(
        [0, 1, 2, 3, 4].map(index => [`g-${index}`, 12, `cycle ${55 + index}`]),
      );

      // Derive transition/reconnect counts from the durable event log rather than local counters.
      const events = runtime.control.events('0', 1000).events;
      const controlEvents = events.filter(event => event.kind.startsWith('control.'));
      expect(controlEvents).toHaveLength(132);
      for (const event of controlEvents) expect(event.payload).toMatchObject({ state: 'terminal' });
      expect(events.filter(event => event.kind === 'control.goal.set')).toHaveLength(60);
      expect(events.filter(event => event.kind === 'control.message')).toHaveLength(60);
      expect(events.filter(event => event.kind === 'control.pause')).toHaveLength(6);
      expect(events.filter(event => event.kind === 'control.resume')).toHaveLength(6);
      expect(events.filter(event => event.kind === 'runtime.pausing')).toHaveLength(6);
      // Five rebuilds each started a recovered session on the same store.
      expect(events.filter(event => event.kind === 'runtime.recovered')).toHaveLength(5);
      const lastGoalEvent = events.filter(event => event.kind === 'control.goal.set').at(-1);
      expect(lastGoalEvent?.payload).toMatchObject({ state: 'terminal', result: { goal_id: 'g-4', revision: 12, spec: { text: 'cycle 59' } } });

      // A command replayed after rebuild must be deduplicated, not re-executed: the receipt result
      // is the original revision 1, the live goal stays at revision 12, and no event is appended.
      const headBeforeReplay = runtime.control.eventsHead();
      expect(runtime.store.getGoal('g-0')?.revision).toBe(12);
      const replay = await runtime.control.command({ requestId: 'goal-0', command: 'goal.set', payload: { goalId: 'g-0', text: 'cycle 0' } });
      expect(replay).toMatchObject({ state: 'terminal', result: { goal_id: 'g-0', revision: 1 } });
      expect(runtime.store.getGoal('g-0')?.revision).toBe(12);
      expect(runtime.control.eventsHead()).toBe(headBeforeReplay);
      expect(runtime.control.events('0', 1000).events.filter(event => event.kind === 'control.goal.set')).toHaveLength(60);
      expect(runtime.store.getActionReceipt(commandScopeOf(runtime.bridge.context), 'goal-0')).toMatchObject({ status: 'completed' });
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
