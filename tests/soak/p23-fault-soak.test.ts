import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../../src/execution/factory.js';
import { ManualClock } from '../../src/contracts/index.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import type { ModelMessage, ModelProvider, ModelResponse } from '../../src/providers/scripted/index.js';

/**
 * P23 virtual-time soak.
 *
 * This exercises 60 minutes of virtual scheduling with faults injected across reconnects and
 * store rebuilds. It proves bounded state-machine/resource behaviour inside the tested model.
 * It is NOT evidence of long-term real-world stability: no wall clock is advanced by the soak
 * loop and no real client/server is involved. The short wall-clock process smoke lives in
 * tests/integration/p23-process-faults.test.ts.
 */

class TransientProvider implements ModelProvider {
  messageCalls = 0;
  faults = 0;
  async complete(messages: ModelMessage[], _tools: unknown[]): Promise<ModelResponse> {
    const last = messages[messages.length - 1];
    // Keep scheduler wake turns successful; only user-driven message turns fail transiently.
    if (typeof last?.content === 'string' && last.content.startsWith('observe cycle')) {
      this.messageCalls += 1;
      // Every 13th model call fails transiently; the runtime must stay alive and keep accepting
      // later commands instead of terminating the session or replaying a write.
      if (this.messageCalls % 13 === 0) { this.faults += 1; throw new Error('provider-transient'); }
    }
    return { text: 'ok', stopReason: 'end_turn' };
  }
  cancel(): void { /* no in-flight request in this fixture */ }
}

const dbBytes = (db: string) => ['', '-wal', '-shm']
  .map(suffix => `${db}${suffix}`)
  .filter(file => existsSync(file))
  .reduce((total, file) => total + statSync(file).size, 0);

describe('P23 long virtual-time soak with combined faults', () => {
  it('keeps 60 virtual minutes of transitions bounded across faults, reconnects and rebuilds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-p23-soak-'));
    const db = join(dir, 'soak.sqlite');
    const clock = new ManualClock();
    const bridge = new FakeClientBridge(12);
    const provider = new TransientProvider();
    let runtime = createRuntime({ db, bridge, clock, provider });
    const wallStarted = Date.now();
    let transitions = 0;
    let reconnects = 0;
    let rebuilds = 0;
    let ambiguousRuns = 0;
    let injectedWriteFailures = 0;
    let providerFailures = 0;
    try {
      runtime.session.start();
      for (let minute = 0; minute < 60; minute += 1) {
        clock.advance(60_000);

        const goal = await runtime.control.command({ requestId: `goal-${minute}`, command: 'goal.set', payload: { goalId: `g-${minute % 5}`, text: `cycle ${minute}` } });
        expect(goal.state).toBe('terminal');
        transitions += 1;

        const message = await runtime.control.command({ requestId: `msg-${minute}`, command: 'message', payload: { text: `observe cycle ${minute}` } });
        expect(['terminal', 'rejected', 'conflict']).toContain(message.state);
        if (message.state === 'rejected') providerFailures += 1;
        transitions += 1;

        // Replayed request ids are deduplicated, not re-executed.
        if (minute % 7 === 6) {
          const replay = await runtime.control.command({ requestId: `msg-${minute}`, command: 'message', payload: { text: `observe cycle ${minute}` } });
          expect(replay.state).toBe(message.state);
        }

        // An ambiguous write that never changed the world stays unknown across rebuilds.
        if (minute % 15 === 14) {
          bridge.configureFault('place', { fault: 'drop', count: 1 });
          const placed = await runtime.router.invoke({
            id: `ambiguous-${minute}`,
            name: 'start_skill',
            arguments: JSON.stringify({ skill: 'place_one', x: 1, y: 0, proposalId: `ambiguous-${minute}` }),
          });
          expect(placed.ok).toBe(false);
          bridge.configureFault('place', undefined);
          ambiguousRuns += 1;
        }

        // A real SQLite write failure at the prepared-effect boundary must fail closed and be
        // repaired without taking the runtime down.
        if (minute % 17 === 16) {
          runtime.store.db.exec("CREATE TRIGGER p23_soak_fail BEFORE INSERT ON effects BEGIN SELECT RAISE(ABORT, 'soak-disk-io'); END;");
          const failed = await runtime.router.invoke({
            id: `write-fail-${minute}`,
            name: 'start_skill',
            arguments: JSON.stringify({ skill: 'place_one', x: 0, y: 1, proposalId: `write-fail-${minute}` }),
          });
          expect(failed.ok).toBe(false);
          expect(String(failed.error)).toContain('soak-disk-io');
          runtime.store.db.exec('DROP TRIGGER p23_soak_fail');
          injectedWriteFailures += 1;
        }

        if (minute % 10 === 9) {
          const paused = await runtime.control.command({ requestId: `pause-${minute}`, command: 'pause', payload: {} });
          expect(paused.state).toBe('terminal');
          const resumed = await runtime.control.command({ requestId: `resume-${minute}`, command: 'resume', payload: {} });
          expect(resumed.state).toBe('terminal');
          reconnects += 1;
        }

        if (minute % 12 === 11) {
          // Rebuild on the same store: durable receipts, effects and goals survive; pending
          // effects are re-observed but never promoted to success without fresh evidence.
          runtime.close();
          rebuilds += 1;
          runtime = createRuntime({ db, bridge, clock, provider });
          const recovery = runtime.session.start();
          expect(recovery.recovered).toBe(true);
          expect(runtime.control.status().context.serverProfileId).toBe('simulated');
          expect(runtime.store.listEffects().every(effect => effect.status === 'ambiguous' || effect.status === 'confirmed')).toBe(true);
        }
      }

      expect(clock.now()).toBe(60 * 60_000);
      expect(transitions).toBeGreaterThanOrEqual(110);
      expect(reconnects).toBeGreaterThanOrEqual(5);
      expect(rebuilds).toBeGreaterThanOrEqual(4);
      expect(ambiguousRuns).toBe(4);
      expect(injectedWriteFailures).toBe(3);
      expect(providerFailures).toBe(provider.faults);
      expect(provider.faults).toBe(4);

      // Resource upper bounds inside this model: goal set, execution/effect rows and retained
      // events stay proportional to the injected cycles, not to virtual minutes × unbounded work.
      const goals = runtime.store.listGoals();
      expect(goals).toHaveLength(5);
      expect(goals.every(goal => (goal.revision as number) <= 60)).toBe(true);
      const executions = runtime.store.listExecutions();
      expect(executions.length).toBeLessThanOrEqual(10);
      expect(executions.every(execution => execution.status !== 'running' && execution.status !== 'stopping')).toBe(true);
      const effects = runtime.store.listEffects();
      expect(effects.length).toBeLessThanOrEqual(4);
      // The ambiguous effects are never rewritten to confirmed by recovery.
      expect(effects.every(effect => effect.status === 'ambiguous')).toBe(true);
      expect(runtime.store.pendingEffects()).toHaveLength(effects.length);

      const events = runtime.control.events('0', 10_000).events;
      expect(events.length).toBeLessThanOrEqual(transitions + rebuilds * 5 + 50);
      expect(events.length).toBeLessThanOrEqual(1_024);

      const bytes = dbBytes(db);
      expect(bytes).toBeLessThan(32 * 1024 * 1024);
      const heap = process.memoryUsage().heapUsed;
      expect(heap, `heapUsed=${heap}`).toBeLessThan(512 * 1024 * 1024);

      // Command replay after the last rebuild is still deduplicated.
      const replay = await runtime.control.command({ requestId: 'goal-0', command: 'goal.set', payload: { goalId: 'g-0', text: 'cycle 0' } });
      expect(replay.state).toBe('terminal');

      // The soak itself is fast; its proof comes from virtual time, not from elapsed wall time.
      expect(Date.now() - wallStarted).toBeLessThan(60_000);
      console.log('[p23-soak]', JSON.stringify({
        virtualMs: clock.now(), wallMs: Date.now() - wallStarted, transitions, rebuilds,
        executions: executions.length, effects: effects.length, events: events.length,
        dbBytes: bytes, heapUsed: heap, providerFaults: provider.faults,
        injectedWriteFailures, ambiguousRuns,
      }));
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
