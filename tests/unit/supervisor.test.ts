import { describe, expect, it } from 'vitest';
import { ProcessSupervisor, type ChildProcessLike } from '../../src/bridge/supervisor.js';

class FakeChild implements ChildProcessLike {
  readonly pid = 4242;
  readonly sent: unknown[] = [];
  killed = false;
  private readonly handlers = new Map<string, Set<(value?: unknown) => void>>();
  send(message: unknown) { this.sent.push(message); return true; }
  on(event: 'message' | 'exit' | 'error', listener: (value?: unknown) => void) { const set = this.handlers.get(event) ?? new Set(); set.add(listener); this.handlers.set(event, set); return this; }
  kill() { this.killed = true; return true; }
  emit(event: 'message' | 'exit' | 'error', value?: unknown) { for (const listener of this.handlers.get(event) ?? []) listener(value); }
}

describe('B06 process supervisor', () => {
  it('greets the child with its owner epoch and stops all processes on quit', async () => {
    const child = new FakeChild();
    const supervisor = new ProcessSupervisor({ spawn: () => child });
    await supervisor.start();
    expect(supervisor.state).toBe('running');
    expect(child.sent[0]).toMatchObject({ type: 'hello', sessionEpoch: supervisor.ownerEpoch });
    await supervisor.stop();
    expect(supervisor.state).toBe('stopped');
    expect(child.killed).toBe(true);
  });

  it('detects owner loss after the configured heartbeat window', () => {
    let now = 0;
    const supervisor = new ProcessSupervisor({ spawn: () => new FakeChild(), now: () => now, ownerLossMs: 1_000 });
    void supervisor.start();
    now = 999; expect(supervisor.checkOwner()).toMatchObject({ ownerLost: false });
    now = 1_001; expect(supervisor.checkOwner()).toMatchObject({ ownerLost: true, revoked: true });
    expect(supervisor.state).toBe('paused');
  });

  it('pauses instead of looping after exceeding the restart budget', async () => {
    let now = 0;
    let spawned = 0;
    const supervisor = new ProcessSupervisor({ spawn: () => { spawned += 1; return new FakeChild(); }, now: () => now, maxRestarts: 3, restartWindowMs: 60_000 });
    await supervisor.start();
    now = 1; expect(await supervisor.restart()).toBe(true);
    now = 2; expect(await supervisor.restart()).toBe(true);
    now = 3; expect(await supervisor.restart()).toBe(true);
    now = 4; expect(await supervisor.restart()).toBe(false);
    expect(supervisor.state).toBe('paused');
    expect(spawned).toBe(4);
  });

  it('allows restarts again after the window passes', async () => {
    let now = 0;
    const supervisor = new ProcessSupervisor({ spawn: () => new FakeChild(), now: () => now, maxRestarts: 3, restartWindowMs: 60_000 });
    await supervisor.start();
    for (const at of [1, 2, 3]) { now = at; expect(await supervisor.restart()).toBe(true); }
    now = 4; expect(await supervisor.restart()).toBe(false);
    now = 70_000; expect(await supervisor.restart()).toBe(true);
  });

  it('adopts the first child epoch and rejects an in-flight identity change', async () => {
    const child = new FakeChild();
    const supervisor = new ProcessSupervisor({ spawn: () => child });
    await supervisor.start();
    child.emit('message', { type: 'hello', protocolVersion: 1, process: 'relay', sessionEpoch: 'child-session-1', bootEpoch: 'b', capabilities: [] });
    expect(supervisor.state).toBe('running');
    child.emit('message', { type: 'hello', protocolVersion: 1, process: 'relay', sessionEpoch: 'foreign-owner', bootEpoch: 'b', capabilities: [] });
    expect(supervisor.state).toBe('failed');
    expect(child.killed).toBe(true);
  });
});
