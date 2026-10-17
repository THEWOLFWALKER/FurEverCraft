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
});
