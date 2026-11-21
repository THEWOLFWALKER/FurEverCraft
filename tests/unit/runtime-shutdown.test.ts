import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { createRuntime } from '../../src/execution/factory.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

describe('Runtime shutdown owns resources until cleanup settles', () => {
  it('keeps the owner lock and store until async body shutdown has finished', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-shutdown-')); const db = join(dir, 'runtime.sqlite');
    const done = deferred(); let shutdowns = 0;
    const bridge = Object.assign(new FakeClientBridge(), { shutdown: () => { shutdowns += 1; return done.promise; } });
    const runtime = createRuntime({ db, bridge });
    try {
      const closing = runtime.close();
      expect(runtime.close()).toBe(closing);
      expect(shutdowns).toBe(1);
      expect(runtime.store.db.open).toBe(true);
      expect(runtime.ownership?.held).toBe(true);
      expect(() => createRuntime({ db })).toThrow('runtime-control-owned');
      expect((await runtime.control.command({ requestId: 'closed-write', command: 'goal.set', payload: { goalId: 'g', text: 'must not write' } })).state).toBe('rejected');
      done.resolve();
      expect(await closing).toEqual({ complete: true, uncertain: [] });
      expect(runtime.store.db.open).toBe(false);
      expect(runtime.ownership?.held).toBe(false);
      const next = createRuntime({ db }); await next.close();
    } finally { done.resolve(); await runtime.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('does not release ownership when shutdown times out or throws', async () => {
    for (const failure of ['timeout', 'throws']) {
      const dir = mkdtempSync(join(tmpdir(), 'furevercraft-shutdown-')); const db = join(dir, 'runtime.sqlite');
      const done = deferred();
      const bridge = Object.assign(new FakeClientBridge(), { shutdown: () => failure === 'timeout' ? done.promise : Promise.reject(new Error('test failure')) });
      const runtime = createRuntime({ db, bridge, shutdownGraceMs: 10 });
      try {
        const result = await runtime.close();
        expect(result.complete).toBe(false);
        expect(result.uncertain).toContain(failure === 'timeout' ? 'shutdown-deadline-exceeded' : 'body-shutdown-failed');
        expect(runtime.store.db.open).toBe(true);
        expect(runtime.ownership?.held).toBe(true);
        expect(() => createRuntime({ db })).toThrow('runtime-control-owned');
      } finally {
        done.resolve();
        // Test-only teardown after deliberately unresolved resources; product stays fenced.
        runtime.store.close(); runtime.ownership?.release(); rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  it('waits for canceled skill settlement before closing SQLite', async () => {
    const runtime = createRuntime();
    const running = runtime.router.invoke({ id: 'waiting-tool', name: 'start_skill', arguments: JSON.stringify({ skill: 'wait_for_condition', ms: 10000, proposalId: 'shutdown-wait' }) });
    expect(runtime.store.listExecutions().some(execution => execution.status === 'running')).toBe(true);
    const closing = runtime.close();
    expect(runtime.store.db.open).toBe(true);
    await running;
    expect((await closing).complete).toBe(true);
    expect(runtime.store.db.open).toBe(false);
  });
});
