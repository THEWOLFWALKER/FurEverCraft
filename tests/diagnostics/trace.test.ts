import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceRecorder, replayTrace, exportTraceFromStore, type TraceDocument, type TraceRecord } from '../../src/diagnostics/trace.js';
import { createRuntime } from '../../src/execution/factory.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ManualClock, type BodyContext } from '../../src/contracts/index.js';
import { SparseVoxelWorld } from '../../src/motor/geometry.js';
import { SimulatedBody } from '../../src/fixtures/simulated-body.js';
import { SimulatedBodyAdapter } from '../../src/fixtures/body-adapter.js';
import { runTraceReplayCommand } from '../../src/cli/main.js';

const cleanup: string[] = [];
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDb = () => { const dir = mkdtempSync(join(tmpdir(), 'furevercraft-trace-')); cleanup.push(dir); return join(dir, 'state.sqlite'); };

const event = (seq: string, kind = 'fixture.event', payload: unknown = { value: seq }, durable = true) => ({
  seq, eventId: `event_${seq}`, kind, payload, durable,
});
const record = (seq: string, kind = 'fixture.event'): TraceRecord => ({ ...event(seq, kind), category: 'event' });

describe('P21 offline trace and replay', () => {
  it('exports redacted runtime events and replays diagnostics without side effects', async () => {
    const runtime = createRuntime();
    try {
      const recorder = new TraceRecorder();
      const first = await runtime.control.command({ requestId: 'trace-goal', command: 'goal.set', payload: { goalId: 'g', text: 'inspect' } });
      expect(first.state).toBe('terminal');
      const read = runtime.control.events('0', 100);
      recorder.appendRead(read);
      const trace = recorder.export();
      expect(trace.records.some(entry => entry.kind === 'control.goal.set')).toBe(true);
      expect(JSON.stringify(trace)).not.toContain('sk-test-secret');
      const seen: string[] = [];
      const result = replayTrace(trace, entry => seen.push(entry.kind));
      expect(result.records).toBe(seen.length);
      expect(result.contiguous).toBe(true);
      expect(result.boundaries).toEqual({ mode: 'diagnostic-only', input: 'disabled', network: 'disabled', paidApis: 'disabled', sideEffects: 'not-resent' });
      expect(runtime.control.status().executions).toBe(0);
    } finally {
      runtime.close();
    }
  });

  it('bounds capture, reports the retention gap and never invents continuity', () => {
    const runtime = createRuntime();
    try {
      const recorder = new TraceRecorder(1);
      const events = runtime.session.events;
      recorder.append(events.publish('fixture.one', { value: 1 }));
      recorder.append(events.publish('fixture.two', { value: 2 }));
      const document = recorder.export();
      expect(document.records).toHaveLength(1);
      expect(document.dropped).toBe(1);
      const result = replayTrace(document);
      expect(result.records).toBe(1);
      expect(result.contiguous).toBe(false);
      expect(result.retentionGap).toEqual({ dropped: 1, firstSeq: document.records[0]!.seq });
    } finally {
      runtime.close();
    }
  });

  it('detects an explicit cursor gap and a requested cursor gap', () => {
    const document: TraceDocument = { version: 1, source: 'offline-fixture', records: [record('1'), record('3')] };
    const result = replayTrace(document);
    expect(result.contiguous).toBe(false);
    expect(result.gaps).toEqual([{ after: '1', before: '3', missing: 1 }]);
    expect(runTraceReplayCommand(document).gaps).toHaveLength(1);

    const fromCursor = replayTrace({ version: 1, source: 'offline-fixture', records: [record('2'), record('3')] }, { cursor: '0' });
    expect(fromCursor.contiguous).toBe(false);
    expect(fromCursor.gaps).toEqual([{ after: '0', before: '2', missing: 1 }]);

    // A cursor already inside the retained range stays contiguous.
    expect(replayTrace({ version: 1, source: 'offline-fixture', records: [record('2'), record('3')] }, { cursor: '1' }).contiguous).toBe(true);

    // An exported start cursor is remembered, so replay reports the leading gap without extra flags.
    const exported = replayTrace({ version: 1, source: 'offline-fixture', startCursor: '5', records: [record('7')] });
    expect(exported.gaps).toEqual([{ after: '5', before: '7', missing: 1 }]);
  });

  it('exports no API keys, bearer tokens or passwords from events, intents and effect state', () => {
    const db = tempDb();
    const runtime = createRuntime({ db, clock: new ManualClock() });
    try {
      runtime.session.events.publish('provider.request', {
        apiKey: 'sk-live-secret',
        authorization: 'Bearer abc.def.ghi',
        nested: { password: 'hunter2' },
        note: 'token=sk-abc123',
      }, true);
      runtime.session.events.publish('input.intent', { apiKey: 'sk-input-secret', text: 'hello' }, true);
      runtime.store.saveExecution({ executionId: 'execution_secret', proposalId: 'proposal_secret', proposalHash: 'hash', goalId: 'goal', skillId: 'place_one', skillVersion: '1.0.0', status: 'running' });
      runtime.store.addEffect({
        effectId: 'effect_secret', executionId: 'execution_secret', context: runtime.bridge.context,
        status: 'may-have-dispatched',
        intent: { kind: 'place', x: 1, y: 0, secret: 'sk-effect-secret', bearer: 'Bearer xyz.123' },
        evidence: { note: 'password=opensesame' },
      });
      const document = exportTraceFromStore(runtime.store);
      const text = JSON.stringify(document);
      for (const secret of ['sk-live-secret', 'Bearer abc.def.ghi', 'hunter2', 'sk-abc123', 'sk-input-secret', 'sk-effect-secret', 'Bearer xyz.123', 'opensesame']) {
        expect(text).not.toContain(secret);
      }
      expect(text).toContain('[REDACTED]');
      expect(document.effects).toHaveLength(1);
      expect(document.inputIntents?.length).toBeGreaterThan(0);
    } finally { runtime.close(); }
  });

  it('explains why a runtime stopped from a durable fault trace', () => {
    const runtime = createRuntime({ maxRecoveryAttempts: 1 });
    try {
      // Inject a store failure during recovery. The session consumes its only attempt,
      // records the failure durably and stays suspended instead of pretending success.
      Object.defineProperty(runtime.store, 'pendingEffects', { value: () => { throw new Error('store-unavailable'); } });
      expect(() => runtime.session.start()).toThrow('store-unavailable');
      expect(runtime.session.state).toBe('suspended');
      const document = exportTraceFromStore(runtime.store);
      const result = replayTrace(document);
      expect(result.faults).toContainEqual(expect.objectContaining({
        kind: 'recovery-exhausted', reason: 'recovery-budget-exhausted', detail: 'attempts=1 budget=1',
      }));

      // A control revocation caused by owner heartbeat loss is reported as owner loss.
      const recorder = new TraceRecorder();
      recorder.append(runtime.session.events.publish('bridge.control-revoked', { reason: 'owner-heartbeat-expired' }, true));
      const owner = replayTrace(recorder.export());
      expect(owner.faults).toContainEqual(expect.objectContaining({ kind: 'owner-lost', reason: 'owner-heartbeat-expired' }));
    } finally { runtime.close(); }
  });

  it('replays input intents and effect state with zero external dispatch', () => {
    const context: BodyContext = { serverProfileId: 'simulated', worldGenerationId: 'trace-world', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };
    const clock = new ManualClock();
    const world = new SparseVoxelWorld(context);
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) world.setBlock({ x, y: -1, z }, 'full_cube', 'stone');
    const body = new SimulatedBody(context, world, clock);
    const adapter = new SimulatedBodyAdapter(body, world, clock);
    const counters = { networkRequests: 0 };
    const transport = { post: async () => { counters.networkRequests += 1; return { ok: true }; } };
    const runtime = createRuntime({
      bridge: new FakeClientBridge(12, { context }), bodyAdapter: adapter, clock,
      modelProvider: 'openai', apiKey: 'sk-injected', transport,
    });
    try {
      const recorder = new TraceRecorder({ source: 'runtime' });
      recorder.appendInputIntent({ kind: 'move', intent: { x: 1, z: 0 }, source: 'test' });
      recorder.appendEffect({ effectId: 'effect_1', executionId: 'execution_1', status: 'may-have-dispatched', intent: { kind: 'place', x: 1, y: 0 } });
      const document = recorder.export();
      const effects: string[] = [];
      const intents: string[] = [];
      const result = replayTrace(document, {
        onInputIntent: intent => intents.push(intent.kind),
        onEffectState: effect => effects.push(`${effect.effectId}:${effect.status}`),
      });
      expect(result.inputIntents).toBe(1);
      expect(result.effects).toEqual({ count: 1, byStatus: { 'may-have-dispatched': 1 }, records: [{ effectId: 'effect_1', status: 'may-have-dispatched' }] });
      expect(intents).toEqual(['move']);
      expect(effects).toEqual(['effect_1:may-have-dispatched']);
      // Replay had no sink/transport handle and dispatched nothing.
      expect(adapter.counters).toMatchObject({ submitted: 0, accepted: 0, rejected: 0, releases: 0 });
      expect(counters.networkRequests).toBe(0);
      expect(runtime.control.status().executions).toBe(0);
    } finally { runtime.close(); }
  });

  it('enforces payload, total-size and retention bounds', () => {
    let now = 1_000;
    const recorder = new TraceRecorder({ capacity: 10, maxRecordBytes: 512, maxBytes: 1_024, retentionMs: 1_000, now: () => now });
    const first = recorder.append(event('1', 'fixture.large', { blob: 'x'.repeat(5_000) }));
    expect(first.payload).toMatchObject({ truncated: true });
    expect(JSON.stringify(first.payload).length).toBeLessThan(512);
    const document = recorder.export();
    expect(document.truncated).toBe(true);
    expect(document.policy).toEqual({ maxRecords: 10, maxRecordBytes: 512, maxBytes: 1_024, retentionMs: 1_000 });

    recorder.append(event('2', 'fixture.small', { value: 2 }));
    now = 3_000;
    recorder.append(event('3', 'fixture.small', { value: 3 }));
    const aged = recorder.export();
    expect(aged.records.map(entry => entry.seq)).not.toContain('1');
    expect(aged.dropped).toBeGreaterThanOrEqual(1);

    const sized = new TraceRecorder({ capacity: 100, maxRecordBytes: 400, maxBytes: 900, retentionMs: 0 });
    for (let seq = 1; seq <= 20; seq += 1) sized.append(event(String(seq), 'fixture.bulk', { blob: 'y'.repeat(300) }));
    const bounded = sized.export();
    const payloads = [...bounded.records, ...(bounded.inputIntents ?? []), ...(bounded.effects ?? [])];
    const bytes = Buffer.byteLength(JSON.stringify(payloads), 'utf8');
    expect(bytes).toBeLessThanOrEqual(900);
    expect(bounded.records.length).toBeLessThan(20);
  });
});
