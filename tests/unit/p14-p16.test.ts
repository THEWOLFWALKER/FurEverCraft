import { describe, expect, it } from 'vitest';
import { createRuntime } from '../../src/execution/factory.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ScriptedModelProvider } from '../../src/providers/scripted/index.js';

describe('P14/P15 shared control state for the web UI', () => {
  it('reports observation source/freshness/fields and keeps a failed read explicit as unknown', () => {
    const bridge = new FakeClientBridge();
    bridge.setUnknown(5, 5);
    const runtime = createRuntime({ bridge });
    try {
      const status = runtime.control.status();
      expect(status.observation).toMatchObject({ source: 'simulated', freshness: 'current', gap: false, revision: '0', unknownCells: 1 });
      expect(status.observation?.fields).toMatchObject({
        position: { source: 'simulated', freshness: 'current', available: true },
        cells: { source: 'simulated', freshness: 'current', available: true },
      });
      expect(status.session).toMatchObject({ state: 'idle', recoveryBudget: 3 });
      expect(status.ui).toBe('gameplay');

      // A failed snapshot is unknown evidence, never an empty world or zero.
      bridge.configureFault('snapshot', { fault: 'failure', error: 'observer-unavailable' });
      const degraded = runtime.control.status();
      expect(degraded.observation).toMatchObject({ source: 'unknown', freshness: 'unknown', gap: true, error: 'observer-unavailable' });
      expect(degraded.position).toBeUndefined();
      expect(degraded.inventory).toBeUndefined();
      expect((degraded.context as { cells?: unknown }).cells).toBeUndefined();

      bridge.configureFault('snapshot', undefined);
      expect(runtime.control.status().observation).toMatchObject({ source: 'simulated', freshness: 'current' });
    } finally { runtime.close(); }
  });

  it('exposes recovery through the shared command path and refuses it after stop', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      const recovered = await runtime.control.command({ requestId: 'recover-1', command: 'recover', payload: {} });
      expect(recovered.state).toBe('terminal');
      expect(recovered.result).toMatchObject({ recovered: true });
      expect(runtime.control.status().session?.state).toBe('running');
      const replay = await runtime.control.command({ requestId: 'recover-1', command: 'recover', payload: {} });
      expect(replay.state).toBe('terminal');
      expect(replay.result).toEqual(recovered.result);

      await runtime.control.command({ requestId: 'stop-1', command: 'stop', payload: {} });
      const refused = await runtime.control.command({ requestId: 'recover-2', command: 'recover', payload: {} });
      expect(refused).toMatchObject({ state: 'rejected', code: 'stopping' });
      // Resume after stop is also refused; recovery must not paper over a stopped runtime.
      expect((await runtime.control.command({ requestId: 'resume-1', command: 'resume', payload: {} })).state).toBe('rejected');
    } finally { runtime.close(); }
  });

  it('makes every operator write observable through the same store the web reads', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      await runtime.control.command({ requestId: 'g1', command: 'goal.set', payload: { goalId: 'web-goal', text: 'watch the area' } });
      expect(runtime.control.goals()).toMatchObject([{ goal_id: 'web-goal', revision: 1, status: 'active' }]);
      const paused = await runtime.control.command({ requestId: 'p1', command: 'pause', payload: {} });
      expect(paused.state).toBe('terminal');
      expect(runtime.control.status().paused).toBe(true);
      const resumed = await runtime.control.command({ requestId: 'r1', command: 'resume', payload: {} });
      expect(resumed.state).toBe('terminal');
      expect(runtime.control.status().paused).toBe(false);
      const saved = await runtime.control.command({ requestId: 's1', command: 'save', payload: {} });
      expect(saved.state).toBe('terminal');
      expect(runtime.control.status().executions).toBe(0);
      expect(runtime.store.getLatestCheckpoint('runtime')?.revision).toBe(1);
    } finally { runtime.close(); }
  });
});
