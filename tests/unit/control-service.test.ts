import { describe, expect, it } from 'vitest';
import { createRuntime } from '../../src/execution/factory.js';
import { canonicalPayloadHash } from '../../src/control/service.js';
import { ScriptedModelProvider } from '../../src/providers/scripted/index.js';


describe('U01 ControlService', () => {
  it('hashes payloads canonically and deduplicates durable requests', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      expect(canonicalPayloadHash({ b: 2, a: 1 })).toBe(canonicalPayloadHash({ a: 1, b: 2 }));
      const first = await runtime.control.command({ requestId: 'r1', command: 'goal.set', payload: { goalId: 'g1', text: 'explore' } });
      const replay = await runtime.control.command({ requestId: 'r1', command: 'goal.set', payload: { text: 'explore', goalId: 'g1' } });
      const conflict = await runtime.control.command({ requestId: 'r1', command: 'goal.set', payload: { goalId: 'g1', text: 'different' } });
      expect(first.state).toBe('terminal');
      expect(replay.state).toBe('terminal');
      expect(replay.result).toEqual(first.result);
      expect(conflict).toMatchObject({ state: 'conflict', code: 'command-payload-conflict' });
      expect(runtime.control.goals()).toHaveLength(1);
    } finally { runtime.close(); }
  });

  it('returns CAS conflict and does not claim accepted chat is succeeded', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      await runtime.control.command({ requestId: 'r1', command: 'goal.set', payload: { goalId: 'g1', text: 'one' } });
      const cas = await runtime.control.command({ requestId: 'r2', command: 'goal.revise', payload: { goalId: 'g1', expectedRevision: 0, change: 'two' } });
      expect(cas.state).toBe('conflict');
      const chat = await runtime.control.command({ requestId: 'r3', command: 'chat', payload: { text: 'hello' } });
      expect(['terminal', 'unknown']).toContain(chat.state);
      expect(chat.state).not.toBe('accepted');
    } finally { runtime.close(); }
  });

  it('persists a checkpoint on save and reports it on reload', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      const saved = await runtime.control.command({ requestId: 's1', command: 'save', payload: {} });
      expect(saved.state).toBe('terminal');
      const stored = runtime.store.getLatestCheckpoint('runtime');
      expect(stored?.revision).toBe(1);
      expect(stored?.checkpoint_id).toBe((saved.result as { checkpointId?: string }).checkpointId);
    } finally { runtime.close(); }
  });

  it('replays a conflict as conflict, never as terminal success', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      await runtime.control.command({ requestId: 'g', command: 'goal.set', payload: { goalId: 'g1', text: 'one' } });
      const conflict = await runtime.control.command({ requestId: 'c', command: 'goal.revise', payload: { goalId: 'g1', expectedRevision: 0, change: 'two' } });
      expect(conflict.state).toBe('conflict');
      const replay = await runtime.control.command({ requestId: 'c', command: 'goal.revise', payload: { goalId: 'g1', expectedRevision: 0, change: 'two' } });
      expect(replay.state).toBe('conflict');
      expect(replay.state).not.toBe('terminal');
    } finally { runtime.close(); }
  });

  it('stop cancels non-terminal executions instead of only flagging', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      runtime.store.saveExecution({ executionId: 'exec-running', proposalId: 'prop-running', proposalHash: 'h', goalId: 'g1', skillId: 'navigate_to', skillVersion: '1.0.0', status: 'running' });
      const stopped = await runtime.control.command({ requestId: 'stop', command: 'stop', payload: {} });
      expect(stopped.state).toBe('accepted');
      expect((stopped.result as { canceled?: string[] }).canceled).toContain('exec-running');
      expect(runtime.store.getExecution('exec-running')?.status).toBe('canceled');
      expect(runtime.control.status().stopping).toBe(true);
    } finally { runtime.close(); }
  });
});
