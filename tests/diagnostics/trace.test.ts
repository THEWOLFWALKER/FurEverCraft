import { describe, expect, it } from 'vitest';
import { TraceRecorder, replayTrace } from '../../src/diagnostics/trace.js';
import { createRuntime } from '../../src/execution/factory.js';

describe('offline trace and replay', () => {
  it('exports redacted runtime events and replays diagnostics without side effects', async () => {
    const runtime = createRuntime();
    try {
      const recorder = new TraceRecorder();
      const first = await runtime.control.command({ requestId: 'trace-goal', command: 'goal.set', payload: { goalId: 'g', text: 'inspect' } });
      expect(first.state).toBe('terminal');
      const read = runtime.control.events('0', 100);
      recorder.appendRead(read);
      const trace = recorder.export();
      expect(trace.records.some(record => record.kind === 'control.goal.set')).toBe(true);
      expect(JSON.stringify(trace)).not.toContain('sk-test-secret');
      const seen: string[] = [];
      const result = replayTrace(trace, record => seen.push(record.kind));
      expect(result.records).toBe(seen.length);
      expect(runtime.control.status().executions).toBe(0);
    } finally {
      runtime.close();
    }
  });

  it('bounds capture without inventing continuity', () => {
    const runtime = createRuntime();
    try {
      const recorder = new TraceRecorder(1);
      const events = runtime.session.events;
      recorder.append(events.publish('fixture.one', { value: 1 }));
      recorder.append(events.publish('fixture.two', { value: 2 }));
      const result = replayTrace(recorder.export());
      expect(result.records).toBe(1);
      expect(result.contiguous).toBe(true);
    } finally {
      runtime.close();
    }
  });
});
