import { describe, expect, it, vi } from 'vitest';
import { SQLiteStore } from '../../src/persistence/store.js';
import { EventHub } from '../../src/diagnostics/events.js';
import { GoalManager, TaskScheduler } from '../../src/autonomous/tasks.js';
import { MemoryService } from '../../src/autonomous/memory.js';
import { AuthCoordinator, SessionSupervisor } from '../../src/autonomous/session.js';
import { BoundedHistory } from '../../src/autonomous/bounds.js';
import { redact } from '../../src/diagnostics/redaction.js';

describe('A01-A05 autonomous modules', () => {
  it('validates goals and coalesces bounded wakeups', async () => {
    const store = new SQLiteStore(':memory:'); const events = new EventHub(32, store);
    const context = { serverProfileId: 'fixture', worldGenerationId: 'autonomous-world', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };
    const manager = new GoalManager(store, events, () => context); const goal = manager.propose({ text: 'explore', nodes: [{ id: 'a', skill: 'explore_area', args: {} }] });
    expect(store.getGoal(goal.goalId)?.revision).toBe(0);
    // The actual body context is persisted, never a shared literal.
    expect(store.getGoal(goal.goalId)?.context).toMatchObject(context);
    const wake = vi.fn(); const scheduler = new TaskScheduler(events, wake, 1); scheduler.wake('goal'); scheduler.wake('observation'); await new Promise(resolve => setTimeout(resolve, 5));
    expect(wake).toHaveBeenCalledOnce(); expect(wake.mock.calls[0][0]).toContain('goal'); scheduler.close(); store.close();
  });
  it('keeps memory domains and pagination separate', () => {
    const store = new SQLiteStore(':memory:'); store.savePlace({ placeId: 'p', context: 'simulated', status: 'known', payload: { x: 1 } }); store.saveEpisode({ episodeId: 'e', context: 'simulated', eventRefs: ['x'], summary: { outcome: 'failed' } });
    const memory = new MemoryService(store); expect(memory.querySpatial().items).toHaveLength(1); expect(memory.queryEpisodic().items).toHaveLength(1); expect(memory.queryKnowledge().items).toHaveLength(0); store.close();
  });
  it('surfaces only secret references, redacts actual secret values and bounds history', async () => {
    const auth = new AuthCoordinator([{ id: 'login', promptPattern: /password/i, response: 'secretRef', allowed: true }]);
    expect(auth.authorize('Password?')).toMatchObject({ status: 'waiting-configuration' });
    const ready = auth.authorize('Password?', { ref: 'secret://mc', configured: true });
    expect(ready).toMatchObject({ status: 'ready', secretRef: 'secret://mc' });
    // Auth only accepts a reference; prove redaction with the actual secret representation.
    const secret = 'super-secret-value';
    const redacted = redact({ password: secret, note: `token=${secret}` });
    expect(redacted).toEqual({ password: '[REDACTED]', note: 'token=[REDACTED]' });
    expect(JSON.stringify(redacted)).not.toContain(secret);
    const history = new BoundedHistory(2, 10000); history.push({ role: 'user', content: 'a' }); history.push({ role: 'assistant', content: 'b' }); history.push({ role: 'user', content: 'c' }); expect(history.size).toBe(2);
    const events = new EventHub(); const adapter = { connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), observe: vi.fn(async () => ({ context: { serverProfileId: 'fixture', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' } })) }; const supervisor = new SessionSupervisor(events, adapter); await supervisor.start(); expect(supervisor.state).toBe('ready');
  });
});
