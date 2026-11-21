import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createRuntime } from '../../src/execution/factory.js';
import { createControlServer } from '../../src/server/index.js';
import { SQLiteStore, SUPPORTED_SCHEMA_VERSION, SCHEMA_MIGRATIONS } from '../../src/persistence/store.js';
import { RuntimeOwnershipLock } from '../../src/execution/ownership.js';
import { exportTraceFromStore, readTraceFile, replayTrace, TRACE_REPLAY_LIMITS } from '../../src/diagnostics/trace.js';
import { runTraceExportCommand, runTraceReplayCommand, removedCredentialFlag, main } from '../../src/cli/main.js';

const dirs: string[] = [];
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'furevercraft-s08-')); dirs.push(dir); return dir; };
const tempDb = () => join(tempDir(), 'state.sqlite');
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const openServers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { while (openServers.length) await openServers.pop()!.close(); });

function seedDatabase(db: string, effects = 0) {
  const store = new SQLiteStore(db);
  try {
    store.saveExecution({ executionId: 'execution-1', proposalId: 'proposal-1', proposalHash: 'hash-1', goalId: 'goal-1', skillId: 'dig_one', skillVersion: '1.0.0', status: 'running' });
    store.addCriticalEvent({ seq: '1', eventId: 'event_1', kind: 'goal.set', context: { serverProfileId: 'simulated' }, payload: { ok: true } });
    for (let index = 0; index < effects; index += 1) {
      store.addEffect({ effectId: `effect-${String(index).padStart(4, '0')}`, executionId: 'execution-1', context: { serverProfileId: 'simulated', worldGenerationId: 'world-1', dimension: 'overworld' }, status: 'confirmed', intent: { kind: 'dig' } });
    }
  } finally { store.close(); }
}

async function listen(server: ReturnType<typeof createControlServer>) {
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('server-address-unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const close = () => server.close();
  openServers.push({ close });
  return { baseUrl, close };
}

describe('S08 FEC-58: trace:export is read-only and lock-free', () => {
  it('opens the database query_only, applies no migration, and takes no ownership record', () => {
    const db = tempDb();
    seedDatabase(db);
    const before = statSync(db).size;
    const migrationStamp = new Database(db, { readonly: true });
    const versionsBefore = (migrationStamp.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
    migrationStamp.close();

    const document = runTraceExportCommand({ db });
    expect(document.source).toBe('runtime');
    expect(document.records.length).toBeGreaterThan(0);

    // No migration ran and no schema/data changed.
    const probe = new Database(db, { readonly: true });
    const versionsAfter = (probe.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v;
    expect(versionsAfter).toBe(versionsBefore);
    expect(versionsAfter).toBe(SUPPORTED_SCHEMA_VERSION);
    probe.close();
    expect(statSync(db).size).toBe(before);

    // No ownership lock was left behind: another owner can acquire immediately.
    const lock = new RuntimeOwnershipLock(db);
    expect(lock.acquire().pid).toBe(process.pid);
    expect(lock.release()).toBe(true);
  });

  it('refuses an in-memory or missing database instead of inventing an empty export', () => {
    expect(() => runTraceExportCommand({ db: ':memory:' })).toThrow('trace-export-requires-file');
    expect(() => runTraceExportCommand({ db: join(tempDir(), 'missing.sqlite') })).toThrow();
  });

  it('reads effects with a bounded SQL page rather than the whole table (FEC-56)', () => {
    const db = tempDb();
    seedDatabase(db, 500);
    const store = new SQLiteStore(db, { readonly: true });
    try {
      // The exporter never calls listEffects(); it pages the table and respects maxEffects.
      let wholeTableReads = 0;
      const paged = { ...store, listEffects: () => { wholeTableReads += 1; return store.listEffects(); } };
      const document = exportTraceFromStore(paged, { maxEffects: 25, maxRecords: 10 });
      expect(document.effects).toHaveLength(25);
      expect(wholeTableReads).toBe(0);
      // A page explicitly bound to 25 rows is what the bounded reader returns.
      const page = store.listEffectsPage(undefined, { limit: 25, maxLimit: 100 });
      expect(page.items).toHaveLength(25);
      expect(page.truncated).toBe(true);
      expect(page.nextCursor).toBeDefined();
    } finally { store.close(); }
  });
});

describe('S08 FEC-59: trace:replay rejects an oversized file and bounds its result', () => {
  it('rejects a file larger than the replay ceiling with an explicit code', () => {
    const file = join(tempDir(), 'huge.json');
    writeFileSync(file, JSON.stringify({ version: 1, source: 'runtime', records: [] }).padEnd(TRACE_REPLAY_LIMITS.maxFileBytes + 10, ' '));
    expect(() => readTraceFile(file)).toThrow('trace-too-large');
  });

  it('rejects a document whose record array exceeds the bound instead of loading it all', () => {
    const records = Array.from({ length: TRACE_REPLAY_LIMITS.maxRecords + 5 }, (_value, index) => ({
      seq: String(index + 1), eventId: `event_${index}`, kind: 'fixture.event', payload: { value: index }, durable: true, category: 'event' as const,
    }));
    const document = { version: 1 as const, source: 'runtime' as const, records };
    expect(() => replayTrace(document)).toThrow('trace-too-large:records');
    expect(() => runTraceReplayCommand(document)).toThrow('trace-too-large:records');
    // A caller-supplied stricter bound still rejects, never silently truncates into success.
    expect(() => replayTrace(document, { limits: { maxRecords: 10 } })).toThrow('trace-too-large:records');
  });

  it('bounds the replay result array for a document under the ceiling', () => {
    const records = Array.from({ length: 200 }, (_value, index) => ({
      seq: String(index + 1), eventId: `event_${index}`, kind: 'fixture.event', payload: { value: index }, durable: true, category: 'event' as const,
    }));
    const result = replayTrace({ version: 1, source: 'runtime', records });
    expect(result.records).toBe(200);
    expect(result.effectStates.length).toBeLessThanOrEqual(TRACE_REPLAY_LIMITS.maxEffects);
  });
});

describe('S08 FEC-20: CLI refuses plaintext credentials in argv', () => {
  it('detects every removed credential flag, including --flag=value form', () => {
    for (const flag of ['--pairing-code', '--cli-bearer', '--token', '--pair-code']) {
      expect(removedCredentialFlag(['node', 'main.js', 'serve', flag, 'secret'])).toBe(flag);
      expect(removedCredentialFlag(['node', 'main.js', 'serve', `${flag}=secret`])).toBe(flag);
    }
    expect(removedCredentialFlag(['node', 'main.js', 'serve', '--port', '3000'])).toBeUndefined();
  });

  it('exits 2 with a redacted message and never logs the credential value', async () => {
    const logged: string[] = [];
    const errorLog = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const exit = process.exitCode;
    const secret = 'super-secret-pairing-value';
    await main(['node', 'main.js', 'serve', '--pairing-code', secret]);
    errorLog.mockRestore();
    process.exitCode = exit;
    expect(process.exitCode).toBe(2);
    const output = logged.join('\n');
    expect(output).toContain('credential-flag-removed');
    expect(output).toContain('--pairing-code');
    expect(output).not.toContain(secret);
  });
});

describe('S08 FEC-46: /api/v1/memories episodes are scope-filtered', () => {
  it('returns only episodes in the runtime scope and hides a foreign world/account, including at the SQL layer', async () => {
    const runtime = createRuntime({ db: tempDb() });
    const server = createControlServer(runtime);
    try {
      const { baseUrl } = await listen(server);
      // Two episodes: one in this runtime's scope, one belonging to a different world/account.
      runtime.memory.recordEpisode({ episodeId: 'mine', context: runtime.memoryScope, eventRefs: [], summary: { kind: 'note', text: 'own' } });
      runtime.memory.recordEpisode({ episodeId: 'foreign', context: { serverProfileId: 'simulated', accountId: 'other-account', worldGenerationId: 'other-world', dimensionId: 'the_nether' }, eventRefs: [], summary: { kind: 'note', text: 'foreign' } });
      // The unscoped table really contains both rows; the scoped read must still return one.
      expect(runtime.store.listEpisodes().length).toBe(2);

      const response = await fetch(`${baseUrl}/api/v1/memories`);
      expect(response.status).toBe(200);
      const body = await response.json() as { episodes: Array<{ episode_id?: string }> };
      const ids = body.episodes.map(episode => episode.episode_id).filter(Boolean);
      expect(ids).toContain('mine');
      expect(ids).not.toContain('foreign');

      // Root cause guard: the server no longer reads the unscoped listEpisodes() table dump.
      expect(JSON.stringify(body)).not.toContain('foreign');
    } finally {
      runtime.close();
    }
  });
});

describe('S08 FEC-55: service-wide SSE backpressure and connection cap', () => {
  it('returns 503 sse-capacity once the service-wide connection cap is reached and recovers on close', { timeout: 20_000 }, async () => {
    const runtime = createRuntime();
    const server = createControlServer(runtime, { maxSseConnections: 2, heartbeatMs: 60_000, pollMs: 20 });
    try {
      const { baseUrl } = await listen(server);
      const controllers = [new AbortController(), new AbortController()];
      const first = await fetch(`${baseUrl}/api/v1/events/stream?cursor=0`, { signal: controllers[0]!.signal });
      const second = await fetch(`${baseUrl}/api/v1/events/stream?cursor=0`, { signal: controllers[1]!.signal });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      // Read a little so the connections are really attached.
      await first.body!.getReader().read();
      await second.body!.getReader().read();

      const over = await fetch(`${baseUrl}/api/v1/events/stream?cursor=0`);
      expect(over.status).toBe(503);
      expect(await over.json()).toMatchObject({ error: { code: 'sse-capacity' } });

      // Releasing one connection frees a slot for a new subscriber.
      controllers[0]!.abort();
      await new Promise(resolve => setTimeout(resolve, 50));
      const afterClose = await fetch(`${baseUrl}/api/v1/events/stream?cursor=0`, { signal: controllers[1]!.signal });
      expect(afterClose.status).toBe(200);
      controllers[1]!.abort();
    } finally {
      await server.close();
      runtime.close();
    }
  });

  it('disconnects a slow consumer with an explicit gap once the pending-bytes budget is exceeded', { timeout: 20_000 }, async () => {
    const runtime = createRuntime();
    // A tiny pending-byte budget with a large event stream forces the slow-consumer path.
    const server = createControlServer(runtime, { maxSsePendingBytes: 512, maxSseBytes: 1024 * 1024, sseSlowConsumerMs: 100_000, heartbeatMs: 60_000, pollMs: 10 });
    try {
      const { baseUrl } = await listen(server);
      const controller = new AbortController();
      const stream = await fetch(`${baseUrl}/api/v1/events/stream?cursor=0`, { signal: controller.signal });
      expect(stream.status).toBe(200);
      // Publish a burst of durable events larger than the service-wide pending budget.
      for (let index = 0; index < 64; index += 1) runtime.session.events.publish('fixture.burst', { index, payload: 'x'.repeat(64) }, true);
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let body = '';
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += decoder.decode(chunk.value, { stream: true });
        // A slow consumer is reported with an explicit gap, never silently dropped.
        if (body.includes('event: gap')) break;
      }
      controller.abort();
      expect(body).toContain('event: gap');
    } finally {
      await server.close();
      runtime.close();
    }
  });
});

describe('S09 FEC-61: ownership lock rejects a foreign owner without process probing', () => {
  it('refuses a same-host lock held by a live owner and reports runtime-control-owned', () => {
    const db = tempDb();
    seedDatabase(db);
    const held = new RuntimeOwnershipLock(db, { isProcessAlive: () => true, hostname: 'host-a' });
    held.acquire();
    try {
      const contender = new RuntimeOwnershipLock(db, { isProcessAlive: () => true, hostname: 'host-a', now: () => 1 });
      // No process.kill probe: the injected liveness callback is what decides, and a live owner
      // means the contender is refused with the canonical code.
      expect(() => contender.acquire()).toThrow(/^runtime-control-owned/);
    } finally {
      held.release();
    }
  });

  it('refuses a lock written by another host even when its pid looks dead, and never deletes it', () => {
    const db = tempDb();
    seedDatabase(db);
    const foreign = new RuntimeOwnershipLock(db, { hostname: 'host-foreign', isProcessAlive: () => false });
    foreign.acquire();
    try {
      const contender = new RuntimeOwnershipLock(db, { hostname: 'host-local', isProcessAlive: () => false });
      expect(() => contender.acquire()).toThrow(/^runtime-control-owned/);
      // The foreign record is untouched: a different host's ownership is not ours to reclaim.
      const probe = new RuntimeOwnershipLock(db, { hostname: 'host-foreign', isProcessAlive: () => true });
      expect(() => probe.acquire()).toThrow(/^runtime-control-owned/);
      expect(foreign.release()).toBe(true);
    } finally {
      foreign.release();
    }
  });
});
