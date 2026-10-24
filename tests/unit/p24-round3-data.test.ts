import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/execution/factory.js';
import { SQLiteStore } from '../../src/persistence/store.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ManualClock, type BodyContext } from '../../src/contracts/index.js';
import { commandScopeOf } from '../../src/control/service.js';
import { createControlServer } from '../../src/server/index.js';
import { collectDoctorReport } from '../../src/diagnostics/doctor.js';
import { exportTraceFromStore } from '../../src/diagnostics/trace.js';

const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'furevercraft-round3-data-'));
  return { dir, db: join(dir, 'state.sqlite') };
};

const openServers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (openServers.length) await openServers.pop()!().catch(() => undefined);
});

async function listen(runtime: ReturnType<typeof createRuntime>) {
  const server = createControlServer(runtime, { pollMs: 10, heartbeatMs: 60_000, maxSseEvents: 32 });
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('server-address-unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const close = async () => { await server.close(); };
  openServers.push(close);
  return { baseUrl, close };
}

async function snapshotOf(baseUrl: string, cursor: string) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/v1/events/stream?cursor=${encodeURIComponent(cursor)}`, { signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 4000;
  while (!text.includes('event: snapshot') && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  controller.abort();
  reader.cancel().catch(() => undefined);
  const match = text.match(/event: snapshot\ndata: (.+)\n\n/);
  if (!match) throw new Error('snapshot-not-received');
  return JSON.parse(match[1]!) as Record<string, any>;
}

const bodyA: BodyContext = { serverProfileId: 'simulated', accountId: 'account-a', worldGenerationId: 'world-a', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };
const bodyB: BodyContext = { serverProfileId: 'simulated', accountId: 'account-b', worldGenerationId: 'world-b', connectionEpoch: '1', bodyEpoch: '1', dimension: 'the_nether' };
const memoryA = { serverProfileId: 'simulated', accountId: 'account-a', worldGenerationId: 'world-a', dimensionId: 'overworld' };
const memoryB = { serverProfileId: 'simulated', accountId: 'account-b', worldGenerationId: 'world-b', dimensionId: 'the_nether' };

const execution = (suffix: string, context: BodyContext) => ({
  executionId: `exec-${suffix}`, proposalId: `proposal-${suffix}`, proposalHash: `hash-${suffix}`,
  goalId: `goal-${suffix}`, skillId: 'place_one', skillVersion: '1.0.0', status: 'succeeded', context,
});

describe('Round 3 — memory timestamps use the wall clock, not a monotonic runtime clock', () => {
  it('does not persist 1970 uptime values and treats a restarted process as stale', () => {
    const { dir, db } = tempDb();
    const fakeWall = Date.parse('2026-05-01T00:00:00.000Z');
    const wall = vi.spyOn(Date, 'now').mockReturnValue(fakeWall);
    try {
      const first = createRuntime({ db, clock: new ManualClock() });
      const scope = first.memoryScope;
      try {
        const created = first.memory.rememberPlace({ placeId: 'short-lived', context: scope, payload: { x: 3, y: 4 } });
        // A ManualClock at 0 must never become a 1970 timestamp.
        expect(created.lastVerifiedAt).toBe(new Date(fakeWall).toISOString());
        expect(Date.parse(created.lastVerifiedAt!)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'));
      } finally { first.close(); }

      // The next process has a different monotonic clock and a later wall clock.
      wall.mockReturnValue(fakeWall + 10 * 60_000);
      const restartedClock = new ManualClock();
      restartedClock.advance(1_000_000);
      const second = createRuntime({ db, clock: restartedClock });
      try {
        const view = second.memory.resolvePlace('short-lived', scope);
        expect(view).toMatchObject({ freshness: 'stale', fresh: false });
        expect(second.memory.returnToPlaceTarget('short-lived', scope)).toBeUndefined();
        expect(second.memory.resolveReturnToPlace('short-lived', scope)).toEqual({ ok: false, reason: 'place-stale' });
      } finally { second.close(); }
    } finally {
      wall.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Round 3 — control reads and SSE snapshots are stable-scope filtered', () => {
  it('returns only the attached world/account from every route and exposes place pagination', async () => {
    const store = new SQLiteStore(':memory:');
    const runtime = createRuntime({ store, bridge: new FakeClientBridge(12, { context: bodyA }), clock: new ManualClock() });
    try {
      store.saveGoal({ goalId: 'goal-a', revision: 1, status: 'active', text: 'scope A', context: bodyA });
      store.saveGoal({ goalId: 'goal-b', revision: 1, status: 'active', text: 'scope B', context: bodyB });
      store.saveExecution(execution('a', bodyA));
      store.saveExecution(execution('b', bodyB));
      store.addEffect({ effectId: 'effect-a', executionId: 'exec-a', context: bodyA, status: 'prepared', intent: { kind: 'place', x: 1, y: 0 } });
      store.addEffect({ effectId: 'effect-b', executionId: 'exec-b', context: bodyB, status: 'prepared', intent: { kind: 'place', x: 9, y: 0 } });
      store.savePlace({ placeId: 'place-b', context: memoryB, status: 'known', payload: { x: 90, y: 90 } });
      for (let index = 0; index < 25; index += 1) {
        store.savePlace({ placeId: `place-a-${String(index).padStart(2, '0')}`, context: memoryA, status: 'known', payload: { x: index, y: 0 } });
      }
      store.saveEpisode({ episodeId: 'episode-a', context: memoryA, eventRefs: [], summary: { kind: 'note', text: 'A' } });
      store.saveEpisode({ episodeId: 'episode-b', context: memoryB, eventRefs: [], summary: { kind: 'note', text: 'B' } });
      store.addCriticalEvent({ seq: '1', eventId: 'event-a', kind: 'test.event', context: bodyA, payload: { scope: 'a' } });
      store.addCriticalEvent({ seq: '2', eventId: 'event-b', kind: 'test.event', context: bodyB, payload: { scope: 'b' } });

      // Direct control reads.
      expect(runtime.control.goals().map(goal => goal.goal_id)).toEqual(['goal-a']);
      expect(runtime.control.executions().map(item => item.execution_id)).toEqual(['exec-a']);
      expect(runtime.control.effects().map(item => item.effect_id)).toEqual(['effect-a']);
      expect(runtime.control.status().executions).toBe(1);
      expect(runtime.control.placesPage().items.every(place => place.scope.accountId === 'account-a')).toBe(true);
      expect(runtime.control.memories().episodes.items.map(episode => episode.episode_id)).toEqual(['episode-a']);
      expect(runtime.control.events('0', 100).events.map(event => event.eventId)).toEqual(['event-a']);

      // Explicit pagination exposes the remainder instead of silently slicing to 20.
      const firstPage = runtime.control.placesPage();
      expect(firstPage.items).toHaveLength(20);
      expect(firstPage.truncated).toBe(true);
      expect(firstPage.nextCursor).toBe('20');
      const remainder = runtime.control.placesPage({ cursor: firstPage.nextCursor! });
      expect(remainder.items).toHaveLength(5);
      expect(remainder.truncated).toBe(false);
      expect(remainder.items.some(place => place.placeId === 'place-b')).toBe(false);

      const { baseUrl } = await listen(runtime);
      const goals = await (await fetch(`${baseUrl}/api/v1/goals`)).json() as Array<{ goal_id: string }>;
      expect(goals.map(goal => goal.goal_id)).toEqual(['goal-a']);
      const executions = await (await fetch(`${baseUrl}/api/v1/executions`)).json() as Array<{ execution_id: string }>;
      expect(executions.map(item => item.execution_id)).toEqual(['exec-a']);
      const effects = await (await fetch(`${baseUrl}/api/v1/effects`)).json() as Array<{ effect_id: string }>;
      expect(effects.map(item => item.effect_id)).toEqual(['effect-a']);
      const places = await (await fetch(`${baseUrl}/api/v1/places`)).json() as { items: Array<{ placeId: string }>; truncated: boolean; nextCursor?: string };
      expect(places.items).toHaveLength(20);
      expect(places.truncated).toBe(true);
      expect(places.nextCursor).toBe('20');
      const remainingPlaces = await (await fetch(`${baseUrl}/api/v1/places?cursor=${places.nextCursor}`)).json() as { items: Array<{ placeId: string }>; truncated: boolean };
      expect(remainingPlaces.items).toHaveLength(5);
      expect(remainingPlaces.truncated).toBe(false);
      const memories = await (await fetch(`${baseUrl}/api/v1/memories`)).json() as { places: { items: unknown[] }; episodes: { items: Array<{ episode_id: string }> } };
      expect(memories.places.items).toHaveLength(20);
      expect(memories.episodes.items.map(episode => episode.episode_id)).toEqual(['episode-a']);
      const events = await (await fetch(`${baseUrl}/api/v1/events?limit=10`)).json() as { events: Array<{ eventId: string }> };
      expect(events.events.map(event => event.eventId)).toEqual(['event-a']);

      // The SSE snapshot carries the same scoped lists and place pagination metadata.
      const snapshot = await snapshotOf(baseUrl, runtime.control.eventsHead());
      expect((snapshot.goals as Array<{ goal_id: string }>).map(goal => goal.goal_id)).toEqual(['goal-a']);
      expect((snapshot.executions as Array<{ execution_id: string }>).map(item => item.execution_id)).toEqual(['exec-a']);
      expect((snapshot.effects as Array<{ effect_id: string }>).map(item => item.effect_id)).toEqual(['effect-a']);
      const snapshotPlaces = snapshot.places as Array<{ placeId: string }>;
      expect(snapshotPlaces).toHaveLength(20);
      expect(snapshotPlaces.some(place => place.placeId === 'place-b')).toBe(false);
      expect(snapshot.placesTruncated).toBe(true);
      expect(snapshot.placesNextCursor).toBe('20');
    } finally {
      runtime.close();
      store.close();
    }
  });
});

describe('Round 3 — command receipt scope includes world and dimension', () => {
  it('executes the same requestId again in another dimension with a distinct durable receipt', async () => {
    const { dir, db } = tempDb();
    const bridge = new FakeClientBridge(12, { context: { ...bodyA } });
    const runtime = createRuntime({ db, bridge, clock: new ManualClock() });
    try {
      // Goal ids are scoped, so each dimension names its own goal while the requestId is reused.
      const requestA = { requestId: 'reused-request', command: 'goal.set' as const, payload: { goalId: 'goal-receipt-a', text: 'one' } };
      const first = await runtime.control.command(requestA);
      expect(first.state).toBe('terminal');
      const scopeA = commandScopeOf(bridge.context);
      const receiptA = runtime.store.getActionReceipt(scopeA, 'reused-request');
      expect(receiptA).toMatchObject({ status: 'completed' });
      expect(runtime.store.getGoal('goal-receipt-a')?.revision).toBe(1);

      bridge.context.dimension = 'the_nether';
      const scopeB = commandScopeOf(bridge.context);
      expect(scopeB).not.toBe(scopeA);
      // Control reads follow the current body scope immediately after the dimension change.
      expect(runtime.control.goals().map(goal => goal.goal_id)).toEqual([]);
      const second = await runtime.control.command({ ...requestA, payload: { goalId: 'goal-receipt-b', text: 'one' } });
      expect(second.state).toBe('terminal');
      expect(second.result).toMatchObject({ goal_id: 'goal-receipt-b', revision: 1 });
      expect(runtime.control.goals().map(goal => goal.goal_id)).toEqual(['goal-receipt-b']);
      expect(runtime.store.getGoal('goal-receipt-b')?.revision).toBe(1);
      const receiptB = runtime.store.getActionReceipt(scopeB, 'reused-request');
      expect(receiptB).toMatchObject({ status: 'completed' });
      expect(receiptB?.receipt_id).not.toBe(receiptA?.receipt_id);

      // The new dimension cannot rewrite the old dimension's goal even by reusing its id.
      const hijack = await runtime.control.command({ requestId: 'hijack-scope', command: 'goal.set', payload: { goalId: 'goal-receipt-a', text: 'overwrite' } });
      expect(hijack.state).toBe('rejected');
      expect(hijack.code).toContain('goal-scope-mismatch');
      expect(runtime.store.getGoal('goal-receipt-a')).toMatchObject({ revision: 1, context: { dimension: 'overworld' } });

      // The new dimension's receipt replays only in the new dimension.
      const replayB = await runtime.control.command({ ...requestA, payload: { goalId: 'goal-receipt-b', text: 'one' } });
      expect(replayB.state).toBe('terminal');
      expect(runtime.store.getGoal('goal-receipt-b')?.revision).toBe(1);
      // The foreign-scope goal from dimension A was never overwritten by the new scope.
      expect(runtime.store.getGoal('goal-receipt-a')?.context).toMatchObject({ dimension: 'overworld' });
    } finally {
      runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Round 3 — execution scope cannot leak through the shared DB', () => {
  it('hides executions from another account/world even by the same id prefix', () => {
    const store = new SQLiteStore(':memory:');
    const runtime = createRuntime({ store, bridge: new FakeClientBridge(12, { context: bodyA }), clock: new ManualClock() });
    try {
      store.saveExecution(execution('a', bodyA));
      store.saveExecution(execution('b', bodyB));
      expect(runtime.control.executions().map(item => item.execution_id)).toEqual(['exec-a']);
      // Effects are linked to their execution scope; the foreign effect is not listed.
      store.addEffect({ effectId: 'effect-b', executionId: 'exec-b', context: bodyB, status: 'prepared', intent: { kind: 'place', x: 9, y: 0 } });
      expect(runtime.control.effects().map(item => item.effect_id)).toEqual([]);
      expect(runtime.store.getExecution('exec-b')).toMatchObject({ context: bodyB });
    } finally {
      runtime.close();
      store.close();
    }
  });
});

describe('Round 3 — a throwing 3D peek is reported as an unknown body', () => {
  it('keeps status and capabilities available and returns HTTP 200 with an unknown body', async () => {
    const runtime = createRuntime({ profile: 'simulated-3d', clock: new ManualClock() });
    try {
      const adapter = runtime.bodyAdapter!;
      adapter.peek = () => { throw new Error('peek-unavailable'); };
      expect(runtime.control.status().body).toMatchObject({ mode: '3d', revision: 'unknown', freshness: 'unknown', gap: true });
      let capabilities: ReturnType<typeof runtime.control.capabilities> | undefined;
      expect(() => { capabilities = runtime.control.capabilities(); }).not.toThrow();
      expect(capabilities?.body).toMatchObject({ mode: '3d', threeDimensional: true });

      const { baseUrl } = await listen(runtime);
      const response = await fetch(`${baseUrl}/api/v1/status`);
      expect(response.status).toBe(200);
      const body = await response.json() as { body?: { mode?: string; revision?: string; freshness?: string }; observation?: { freshness?: string; gap?: boolean } };
      expect(body.body).toMatchObject({ mode: '3d', revision: 'unknown', freshness: 'unknown' });
      expect(body.observation).toMatchObject({ freshness: 'unknown', gap: true });
    } finally {
      runtime.close();
    }
  });
});

describe('Round 3 — goals are body-scope isolated', () => {
  it('reports, schedules and revises only goals in the attached stable scope', async () => {
    const store = new SQLiteStore(':memory:');
    const runtime = createRuntime({ store, bridge: new FakeClientBridge(12, { context: bodyA }), clock: new ManualClock() });
    try {
      store.saveGoal({ goalId: 'goal-a', revision: 1, status: 'active', text: 'scope A', context: bodyA });
      store.saveGoal({ goalId: 'goal-b', revision: 1, status: 'active', text: 'scope B', context: bodyB });

      // Control reads expose only the attached scope, including the single status goal.
      expect(runtime.control.status().goal).toMatchObject({ goal_id: 'goal-a' });
      expect(runtime.control.goals().map(goal => goal.goal_id)).toEqual(['goal-a']);

      // The scheduler picks the scoped active goal, never the foreign one.
      const run = vi.spyOn(runtime.loop, 'run').mockImplementation(async () => ({
        response: { stopReason: 'end_turn', text: '' }, trace: [],
      }));
      expect(runtime.scheduler.wake('goal.proposed')).toBe(true);
      await runtime.scheduler.flush();
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]![3]).toMatchObject({ goalId: 'goal-a', goalRevision: 1 });
      run.mockRestore();

      // A foreign goal id cannot be revised through the agent tool or the control command.
      const tool = await runtime.router.invoke({ id: 'revise-foreign', name: 'revise_goal', arguments: JSON.stringify({ goalId: 'goal-b', expectedRevision: 1, change: 'hijack' }) });
      expect(tool).toMatchObject({ ok: false });
      expect(String(tool.error)).toContain('goal-scope-mismatch');
      const command = await runtime.control.command({ requestId: 'revise-foreign', command: 'goal.revise', payload: { goalId: 'goal-b', expectedRevision: 1, change: 'hijack' } });
      expect(command.state).toBe('rejected');
      expect(command.code).toContain('goal-scope-mismatch');
      // The foreign row (and its revision/context) is untouched.
      expect(store.getGoal('goal-b')).toMatchObject({ revision: 1, context: bodyB, spec: { text: 'scope B' } });

      // A goal.set reusing a foreign id is rejected instead of overwriting its body_context.
      const overwrite = await runtime.control.command({ requestId: 'overwrite-foreign', command: 'goal.set', payload: { goalId: 'goal-b', text: 'overwrite' } });
      expect(overwrite.state).toBe('rejected');
      expect(overwrite.code).toContain('goal-scope-mismatch');
      expect(store.getGoal('goal-b')).toMatchObject({ revision: 1, context: bodyB, spec: { text: 'scope B' } });

      // GoalManager writes the assembled body context, not the literal 'simulated'.
      const proposed = runtime.goalManager.propose({ text: 'runtime goal' });
      expect(store.getGoal(proposed.goalId)?.context).toMatchObject(bodyA);
    } finally {
      runtime.close();
      store.close();
    }
  });
});

describe('Round 3 — execution records, recovery and proposal ids are body-scope isolated', () => {
  it('leaves a foreign no-effect execution untouched and never replays its proposal as success', async () => {
    const store = new SQLiteStore(':memory:');
    const runtime = createRuntime({ store, bridge: new FakeClientBridge(12, { context: bodyB }), clock: new ManualClock() });
    try {
      store.saveExecution({ executionId: 'exec-a-no-effect', proposalId: 'proposal-shared', proposalHash: 'hash-a', goalId: 'goal-a', skillId: 'navigate_to', skillVersion: '1.0.0', status: 'running', context: bodyA });
      store.saveExecution({ executionId: 'exec-b-no-effect', proposalId: 'proposal-owned', proposalHash: 'hash-b', goalId: 'goal-b', skillId: 'navigate_to', skillVersion: '1.0.0', status: 'running', context: bodyB });

      const recovery = runtime.session.start();
      // A running execution with no effect rows is still classified by its stored context.
      expect(recovery.suspendedExecutions).toContain('exec-b-no-effect');
      expect(recovery.suspendedExecutions ?? []).not.toContain('exec-a-no-effect');
      expect(store.getExecution('exec-a-no-effect')?.status).toBe('running');
      expect(store.getExecution('exec-b-no-effect')?.status).toBe('suspended');

      // Agent tools cannot read or cancel the foreign execution.
      const read = await runtime.router.invoke({ id: 'read-foreign', name: 'get_execution', arguments: JSON.stringify({ executionId: 'exec-a-no-effect' }) });
      expect(read).toMatchObject({ ok: false, error: 'execution-not-found' });
      const cancel = await runtime.router.invoke({ id: 'cancel-foreign', name: 'cancel_execution', arguments: JSON.stringify({ executionId: 'exec-a-no-effect' }) });
      expect(cancel).toMatchObject({ ok: false, error: 'execution-not-found' });
      expect(store.getExecution('exec-a-no-effect')?.status).toBe('running');

      // Reusing a foreign proposal id is rejected, never returned as this body's success.
      const duplicate = await runtime.router.invoke({ id: 'dup-foreign', name: 'start_skill', arguments: JSON.stringify({ skill: 'observe_ui', proposalId: 'proposal-shared' }) });
      expect(duplicate.ok).toBe(false);
      expect(String(duplicate.error)).toContain('proposal-id-scope-conflict');
      expect(store.getExecution('exec-a-no-effect')).toMatchObject({ status: 'running', context: bodyA });
    } finally {
      runtime.close();
      store.close();
    }
  });
});

describe('Round 3 — runtime profile is reported separately from the server profile id', () => {
  it('reports simulated-3d as the assembly profile while the body/server stays simulated and 3D', async () => {
    const runtime = createRuntime({ profile: 'simulated-3d', clock: new ManualClock() });
    try {
      expect(runtime.runtimeProfile).toBe('simulated-3d');
      expect(runtime.control.capabilities()).toMatchObject({
        runtimeProfile: 'simulated-3d',
        serverProfileId: 'simulated',
        profile: 'simulated',
        body: { mode: '3d', threeDimensional: true },
      });
      const doctor = collectDoctorReport(runtime, { generatedAt: 1 });
      expect(doctor).toMatchObject({ runtimeProfile: 'simulated-3d', serverProfileId: 'simulated', profile: { id: 'simulated' }, body: { mode: '3d' } });

      const { baseUrl } = await listen(runtime);
      const capabilities = await (await fetch(`${baseUrl}/api/v1/capabilities`)).json() as Record<string, any>;
      expect(capabilities).toMatchObject({ runtimeProfile: 'simulated-3d', serverProfileId: 'simulated', profile: 'simulated', body: { mode: '3d' } });
      const config = await (await fetch(`${baseUrl}/api/v1/config`)).json() as Record<string, any>;
      expect(config).toMatchObject({ runtimeProfile: 'simulated-3d', serverProfileId: 'simulated', profile: 'simulated' });
      const doctorRoute = await (await fetch(`${baseUrl}/api/v1/doctor`)).json() as Record<string, any>;
      expect(doctorRoute).toMatchObject({ runtimeProfile: 'simulated-3d', profile: { id: 'simulated' } });
    } finally {
      runtime.close();
    }

    const legacy = createRuntime({ clock: new ManualClock() });
    try {
      expect(legacy.runtimeProfile).toBe('simulated');
      expect(legacy.control.capabilities()).toMatchObject({ runtimeProfile: 'simulated', serverProfileId: 'simulated', body: { mode: 'legacy-2d' } });
      expect(collectDoctorReport(legacy)).toMatchObject({ runtimeProfile: 'simulated', body: { mode: 'legacy-2d' } });
    } finally {
      legacy.close();
    }
  });
});

describe('Round 3 — diagnostics and control reads stay bounded', () => {
  it('uses aggregates/limited SELECTs instead of materialising effect, execution and goal tables', () => {
    const store = new SQLiteStore(':memory:');
    const runtime = createRuntime({ store, bridge: new FakeClientBridge(12, { context: bodyA }), clock: new ManualClock() });
    try {
      for (let index = 0; index < 250; index += 1) {
        const suffix = String(index).padStart(3, '0');
        store.saveExecution({
          executionId: `bulk-exec-${suffix}`, proposalId: `bulk-proposal-${suffix}`, proposalHash: `hash-${suffix}`,
          goalId: `bulk-goal-${suffix}`, skillId: 'place_one', skillVersion: '1.0.0', status: 'running', context: bodyA,
        });
        store.addEffect({ effectId: `bulk-effect-${suffix}`, executionId: `bulk-exec-${suffix}`, context: bodyA, status: 'prepared', intent: { kind: 'place', x: 1, y: 0 } });
      }
      for (let index = 0; index < 40; index += 1) store.saveGoal({ goalId: `bulk-goal-${String(index).padStart(3, '0')}`, revision: 1, status: 'active', text: 'bulk', context: bodyA });

      // Any whole-table materialisation would throw and fail these reads.
      const listEffects = vi.spyOn(store, 'listEffects').mockImplementation(() => { throw new Error('materialized-listEffects'); });
      const listExecutions = vi.spyOn(store, 'listExecutions').mockImplementation(() => { throw new Error('materialized-listExecutions'); });
      const listGoals = vi.spyOn(store, 'listGoals').mockImplementation(() => { throw new Error('materialized-listGoals'); });
      const pendingEffects = vi.spyOn(store, 'pendingEffects').mockImplementation(() => { throw new Error('materialized-pendingEffects'); });
      try {
        const report = collectDoctorReport(runtime, { generatedAt: 1 });
        expect(report.store).toMatchObject({ state: 'available', executions: 250, effects: 250, goals: 40 });
        expect(report.recovery).toMatchObject({ pendingEffects: 250, effectCounts: { prepared: 250 } });
        expect(report.status).not.toBeUndefined();

        expect(runtime.control.status().executions).toBe(250);
        expect(runtime.control.effects()).toHaveLength(100);

        const trace = exportTraceFromStore(store, { maxEffects: 5, maxRecords: 10 });
        expect(trace.effects).toHaveLength(5);
        expect(trace.inputIntents).toHaveLength(5);
      } finally {
        listEffects.mockRestore();
        listExecutions.mockRestore();
        listGoals.mockRestore();
        pendingEffects.mockRestore();
      }
    } finally {
      runtime.close();
      store.close();
    }
  });
});
