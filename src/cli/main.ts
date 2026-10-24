import { Command } from 'commander';
import Database from 'better-sqlite3';
import { FakeClientBridge } from '../bridge/fake/index.js';
import { navigate } from '../skills/navigation.js';
import { SQLiteStore } from '../persistence/store.js';
import { SessionRuntime } from '../execution/session.js';
import { RuntimeOwnershipLock } from '../execution/ownership.js';
import { placeOne, sendChat, navigateTo } from '../skills/skills.js';
import { ProtocolSession, OfflineProtocolBridge, LoopbackFixtureTransport, minecraftDataSummary } from '../bridge/protocol/session.js';
import { createRawTcpRelay } from '../bridge/relay/raw.js';
import net from 'node:net';
import { createRuntime } from '../execution/factory.js';
import { redact } from '../diagnostics/redaction.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Server } from 'node:http';
import { getGameVersionProfile, versionProfileSummary } from '../bridge/version-profile.js';
import { createControlServer, generatePairingCode } from '../server/index.js';
import { replayTrace, exportTraceFromStore } from '../diagnostics/trace.js';
import { collectDoctorReport, unavailableDoctorReport, type DoctorReport } from '../diagnostics/doctor.js';
import { ProcessSupervisor, type ChildProcessLike } from '../bridge/supervisor.js';
import { spawnBridgeServiceProcess } from '../bridge/service/spawn.js';
import type { BridgeServiceEntryConfig } from '../bridge/service/entry.js';
import { loadProfileConfig, type ProfileConfig } from '../config/profile.js';

/** A utility command must never race the owner of the same SQLite path. */
function ownershipFailure(db: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('runtime-control-owned')) throw new Error(`runtime-control-owned:${db}`);
  throw error;
}

function acquireUtilityOwnership(db: string): RuntimeOwnershipLock {
  const ownership = new RuntimeOwnershipLock(db);
  try { ownership.acquire(); } catch (error) { ownershipFailure(db, error); }
  return ownership;
}

/** Direct utility reads/writes require a persistent database; an ephemeral view is never faked. */
function utilityDatabasePath(db: string | undefined): string {
  if (!db || db === ':memory:') throw new Error('runtime-database-required');
  return db;
}

function withReadOnlyDatabase<T>(db: string | undefined, fn: (database: Database.Database) => T): T {
  const path = utilityDatabasePath(db);
  if (!existsSync(path)) throw new Error(`runtime-database-not-found:${path}`);
  // Take the same cross-process ownership lock as the serving Runtime. If another process owns
  // the store, fail closed instead of reading a database another Runtime is writing.
  const ownership = acquireUtilityOwnership(path);
  let database: Database.Database | undefined;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
    return fn(database);
  } finally {
    try { database?.close(); } finally { ownership.release(); }
  }
}

export async function runDemo(db = process.env.MINECRAFT_AGENT_DB ?? '/tmp/minecraft-agent-phase2-demo.sqlite', scenario?: string) {
  const names = ['autonomous','obstruction','human-steering','chat-ui','crash-recovery','bridge-fixture'] as const;
  if (scenario && !names.includes(scenario as typeof names[number])) throw new Error(`unknown-scenario:${scenario}`);
  const selected = scenario ? [scenario as typeof names[number]] : [...names];
  // The demo mutates SQLite, so it must be the single owner of its database path too.
  if (db !== ':memory:') mkdirSync(dirname(db), { recursive: true });
  const ownership = db === ':memory:' ? undefined : acquireUtilityOwnership(db);
  try {
    // Each scenario gets a freshly created database so repeated runs are deterministic.
    const results = selected.map((name, index) => runScenario(name, `${db}.${index}`));
    const document = { simulated: true, scenarios: results, summary: { count: results.length, names: results.map(r => r.scenario) } };
    console.log(JSON.stringify(redact(document)));
    return document;
  } finally {
    ownership?.release();
  }
}

type ScenarioName = 'autonomous'|'obstruction'|'human-steering'|'chat-ui'|'crash-recovery'|'bridge-fixture';
function runScenario(scenario: ScenarioName, db: string) {
  if (db !== ':memory:') mkdirSync(dirname(db), { recursive: true });
  const ownership = db === ':memory:' ? undefined : acquireUtilityOwnership(db);
  let store: SQLiteStore | undefined;
  try {
    // Only delete a scenario database after proving this process owns it; an owner that lost
    // the lock race must never have its files removed out from under it.
    for (const suffix of ['', '-wal', '-shm']) { try { rmSync(`${db}${suffix}`, { force: true }); } catch { /* best effort */ } }
    store = new SQLiteStore(db); const bridge = new FakeClientBridge(); const runtime = new SessionRuntime(bridge, store); runtime.start();
    if (scenario === 'autonomous') { const first = navigate(bridge, {x:2,y:0}); store.saveGoal({goalId:'goal_autonomous',revision:1,status:'active',text:'autonomous navigation'}); const next = navigate(bridge,{x:3,y:0}); const completed = first.status === 'succeeded' && next.status === 'succeeded'; if (completed) store.saveGoal({goalId:'goal_autonomous',revision:2,status:'completed',text:'autonomous navigation'}); return {scenario,outcome:completed?'completed':'failed',expectedPhases:['observe','navigate','milestone','next-task'],executionIds:[first.executionId,next.executionId],goal:store.getGoal('goal_autonomous')?.status,position:bridge.position}; }
    if (scenario === 'obstruction') { bridge.block(1,0); bridge.setUnknown(1,1); const result=navigate(bridge,{x:3,y:1},2); return {scenario,outcome:result.status,dynamicObstacle:true,unknownCell:true,replanned:result.path.length>0,budget:2,pathLength:result.path.length}; }
    // Navigation is synchronous here, so the first run has already finished when the revised
    // target starts. Report its real result; never label it superseded without observing that.
    if (scenario === 'human-steering') { const old=navigate(bridge,{x:4,y:0}); const revised=navigate(bridge,{x:0,y:2}); return {scenario,outcome:revised.status,oldExecution:old.executionId,oldResult:old.status,...(old.reason === undefined ? {} : {oldReason:old.reason}),steering:'target-revised',target:{x:0,y:2},position:bridge.position}; }
    if (scenario === 'chat-ui') {
      const moved=navigate(bridge,{x:1,y:0});
      // Derive the UI handoff and retry claim from what the bridges actually did.
      const uiHandoff: string[] = [bridge.ui];
      const setUi = bridge.setUi.bind(bridge);
      bridge.setUi = ui => { setUi(ui); if (uiHandoff.at(-1) !== ui) uiHandoff.push(ui); };
      const dispatch = bridge.dispatchChat?.bind(bridge);
      let dispatchAttempts = 0;
      if (dispatch) bridge.dispatchChat = (text: string) => { dispatchAttempts += 1; return dispatch(text); };
      const chat=sendChat({bridge,lease:{leaseId:'demo',owner:'demo',resources:['ui','textEntry'],until:Date.now()+1000,generation:1,contextEpoch:''},report:()=>{}},'offline hello');
      return {scenario,outcome:chat.outcome,navigation:moved.status,uiHandoff,dispatchAttempts,messageRetried:dispatchAttempts>1,unknownMessageNotRetried:dispatchAttempts<=1,...(chat.reason === undefined ? {} : {reason:chat.reason}),scenarioAssertions:{unknownMessageNotRetried:true}};
    }
    if (scenario === 'crash-recovery') {
      // A real execution row must exist before the effect FK; the crash window leaves the
      // effect pending and a rebuilt runtime must reconcile it from evidence.
      store.saveExecution({ executionId: 'execution_demo', proposalId: 'proposal_demo', proposalHash: 'demo', goalId: 'goal_demo', skillId: 'place_one', skillVersion: '1.0.0', status: 'running' });
      bridge.position = { x: 1, y: 0 };
      store.addEffect({ effectId: 'effect_demo', executionId: 'execution_demo', context: bridge.context, status: 'may-have-dispatched', intent: { kind: 'place', x: 2, y: 0 } });
      const before = store.pendingEffects().length; store.close(); store = undefined;
      const reopened = new SQLiteStore(db); const restored = new SessionRuntime(new FakeClientBridge(), reopened).recover();
      const after = reopened.pendingEffects().length; reopened.close();
      // Derive the outcome from the recovery result; a reconciliation may settle to
      // ambiguous (never promote an unknown effect to confirmed).
      const reconciled = restored.reconciled ?? [];
      const demo = reconciled.find(item => item.effectId === 'effect_demo');
      return { scenario, outcome: demo ? 'reconciled' : 'not-reconciled', ...(demo ? { reconciledStatus: demo.status } : {}), pendingBefore: before, pendingAfter: after, reconciled, recovered: restored.recovered };
    }
    const protocol=new ProtocolSession('fixture-session'); const observations:unknown[]=[]; const unsubscribe=protocol.subscribe(o=>observations.push(o)); protocol.transition('LOGIN'); protocol.transition('CONFIGURATION'); protocol.transition('PLAY'); protocol.observe('position','downstream',{x:1,y:0}); protocol.close(); unsubscribe();
    // Prove cleanup rather than asserting it: a late observation after close must not reach
    // the removed subscriber.
    const deliveredBeforeLate = observations.length;
    protocol.observe('position','downstream',{x:2,y:0});
    const lateObservationDelivered = observations.length > deliveredBeforeLate;
    protocol.close();
    return {scenario,outcome:protocol.phase === 'CLOSED' && !lateObservationDelivered ? 'fixture-complete' : 'fixture-incomplete',phase:protocol.phase,observations:deliveredBeforeLate,syntheticCapture:true,input:'fake-transport',disconnectCleanup:!lateObservationDelivered,lateObservationDelivered};
  } finally {
    if (store) store.close();
    ownership?.release();
  }
}

export type CliGoalView = Record<string, unknown> & { goal_id?: string; revision?: number; status?: string; context?: unknown; spec?: unknown };
export type CliExecutionView = Record<string, unknown> & { executionId?: string; status?: string };
export type CliDurableEvent = { seq: string; eventId: string; kind: string; durable: true; context: unknown; payload: unknown };

const parseJson = (value: unknown): unknown => JSON.parse(String(value));
const goalView = (row: Record<string, any>): CliGoalView => ({ ...row, context: parseJson(row.body_context), spec: parseJson(row.spec_json) });
const executionView = (row: Record<string, any>): CliExecutionView => ({
  executionId: row.execution_id,
  proposalId: row.proposal_id,
  proposalHash: row.proposal_hash,
  goalId: row.goal_id,
  skillId: row.skill_id,
  skillVersion: row.skill_version,
  status: row.status,
  reason: row.reason ?? undefined,
  outcome: row.outcome ?? undefined,
  checkpoint: row.checkpoint_json ? parseJson(row.checkpoint_json) : undefined,
  context: row.context ? parseJson(row.context) : undefined,
  execution_id: row.execution_id,
  proposal_id: row.proposal_id,
  proposal_hash: row.proposal_hash,
  goal_id: row.goal_id,
  skill_id: row.skill_id,
  skill_version: row.skill_version,
});

/**
 * Read-only status view over the durable SQLite state. This is deliberately not a simulated
 * Runtime view: a CLI reader cannot observe the serving Runtime's in-memory session, so the
 * output says so instead of inventing one. It fails closed while another owner holds the lock.
 */
export function runStatusCommand(options: { db?: string }) {
  return withReadOnlyDatabase(options.db, database => {
    const goals = (database.prepare('SELECT * FROM goals ORDER BY goal_id').all() as Array<Record<string, any>>).map(goalView);
    const executions = (database.prepare('SELECT * FROM executions ORDER BY execution_id').all() as Array<Record<string, any>>).map(executionView);
    return {
      source: 'sqlite' as const,
      mode: 'read-only' as const,
      liveSession: false as const,
      database: String(options.db),
      state: goals.some(goal => goal.status === 'active') ? 'active' : 'idle',
      goals,
      executions,
    };
  });
}

/** Read-only durable-event view; live in-memory events are intentionally not fabricated. */
export function runEventsCommand(options: { db?: string; cursor?: string; limit?: number }) {
  const cursor = options.cursor ?? '0';
  const limit = options.limit ?? 100;
  if (!/^\d+$/.test(cursor)) throw new Error('invalid-event-cursor');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('invalid-event-limit');
  return withReadOnlyDatabase(options.db, database => {
    const rows = database.prepare(`SELECT * FROM critical_events WHERE CAST(event_seq AS INTEGER)>CAST(? AS INTEGER)
      ORDER BY CAST(event_seq AS INTEGER) LIMIT CAST(? AS INTEGER)`).all(cursor, limit) as Array<Record<string, any>>;
    const events: CliDurableEvent[] = rows.map(row => ({
      seq: String(row.event_seq), eventId: String(row.event_id), kind: String(row.kind), durable: true as const,
      context: parseJson(row.context), payload: parseJson(row.payload_json),
    }));
    const first = database.prepare('SELECT event_seq FROM critical_events ORDER BY CAST(event_seq AS INTEGER) LIMIT 1').get() as { event_seq?: string } | undefined;
    const availableFrom = String(first?.event_seq ?? cursor);
    const firstSeq = /^\d+$/.test(availableFrom) ? BigInt(availableFrom) : BigInt(cursor);
    return {
      source: 'sqlite' as const,
      mode: 'read-only' as const,
      liveSession: false as const,
      retainedLiveEvents: false as const,
      database: String(options.db),
      events,
      gap: firstSeq > BigInt(cursor) + 1n,
      next: events.at(-1)?.seq ?? cursor,
      availableFrom,
    };
  });
}

/** Mutating utility command: own the database for the whole revision, then release it. */
export function runGoalReviseCommand(options: { db?: string; id: string; revision: number; change: string }) {
  const path = utilityDatabasePath(options.db);
  if (!Number.isInteger(options.revision) || options.revision < 0) throw new Error('invalid-goal-revision');
  mkdirSync(dirname(path), { recursive: true });
  const ownership = acquireUtilityOwnership(path);
  let store: SQLiteStore | undefined;
  try {
    store = new SQLiteStore(path);
    return store.reviseGoal(options.id, options.revision, options.change);
  } finally {
    try { store?.close(); } finally { ownership.release(); }
  }
}

type CliIo = { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream };
export type AttachOptions = {
  /** CLI bearer configured on the serving process. Never printed or put in a URL. */
  token?: string;
  /** One-time local pairing code; exchanged for an HttpOnly session + CSRF token. */
  pairCode?: string;
  /** Start the event/state subscription automatically (default true). */
  subscribe?: boolean;
  cursor?: string;
  /** Abort the attach session (tests and embedding callers). */
  signal?: AbortSignal;
};
const commandId = () => `cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const parseWords = (line: string) => {
  const words: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) words.push(match[1] ?? match[2] ?? match[3] ?? '');
  return words;
};
const printJson = (output: NodeJS.WritableStream, value: unknown) => output.write(`${JSON.stringify(redact(value))}\n`);

/** Parse one SSE frame. Comments/heartbeats produce no frame. */
function parseSseFrame(frame: string): { event: string; id?: string; data: string } | undefined {
  let event = 'message'; let id: string | undefined; const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length) return undefined;
  return { event, id, data: data.join('\n') };
}

/**
 * Attach CLI. Every command is an HTTP call into the same ControlService that serves the web
 * UI; the CLI never opens a second Runtime. `quit` only detaches this terminal, while
 * `shutdown` asks the owning Runtime to stop (the `quit` control command).
 */
export async function runAttach(url: string, io: CliIo = {}, options: AttachOptions = {}) {
  const input = io.input ?? process.stdin; const output = io.output ?? process.stdout;
  const baseUrl = url.replace(/\/$/, '');
  let token = options.token ?? process.env.MINECRAFT_AGENT_CLI_TOKEN;
  let sessionCookie: string | undefined; let csrfToken: string | undefined;
  let cursor = options.cursor ?? '0';
  let stream: AbortController | undefined; let streamOpen = false;
  const authHeaders = (write = false) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (sessionCookie) {
      headers.cookie = sessionCookie;
      // The server requires a same-origin Origin header for browser-session writes.
      headers.origin = baseUrl;
    }
    if (write && csrfToken) headers['x-csrf-token'] = csrfToken;
    return headers;
  };
  const request = async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...authHeaders(method !== 'GET') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, body: payload as unknown };
  };
  const postCommand = async (command: string, payload: Record<string, unknown>, expectedRevision?: number) => request('POST', '/api/v1/commands', { requestId: commandId(), command, payload, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  const readGoal = async (goalId: string) => {
    const read = await request('GET', '/api/v1/goals');
    if (read.status !== 200 || !Array.isArray(read.body)) return undefined;
    return (read.body as Array<{ goal_id?: string; revision?: number }>).find(goal => goal.goal_id === goalId);
  };

  /** Exchange a local pairing code for the HttpOnly session and CSRF token. */
  const pair = async (code: string) => {
    if (!code) throw new Error('usage: pair <code>');
    const response = await fetch(`${baseUrl}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const body = await response.json().catch(() => ({})) as { csrfToken?: string; expiresInMs?: number; error?: { code?: string } };
    if (!response.ok) throw new Error(body.error?.code ?? `http-${response.status}`);
    const cookie = response.headers.get('set-cookie') ?? '';
    const match = /furevercraft_session=([^;]+)/.exec(cookie);
    if (!match || !body.csrfToken) throw new Error('pairing-response-incomplete');
    sessionCookie = `furevercraft_session=${match[1]}`;
    csrfToken = body.csrfToken;
    token = undefined;
    // Never print the CSRF token or the session cookie.
    return { paired: true, expiresInMs: body.expiresInMs };
  };

  const disconnect = (reason = 'requested') => {
    const controller = stream; stream = undefined; streamOpen = false;
    if (controller) controller.abort();
    printJson(output, { subscription: { state: 'disconnected', cursor, reason } });
  };
  const connect = async (from = cursor) => {
    if (stream) return;
    cursor = from;
    const controller = new AbortController(); stream = controller;
    printJson(output, { subscription: { state: 'connecting', cursor } });
    try {
      const response = await fetch(`${baseUrl}/api/v1/events/stream?cursor=${encodeURIComponent(cursor)}`, { headers: authHeaders(false), signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        streamOpen = false;
        printJson(output, { subscription: { state: 'rejected', cursor, error: (body as { error?: { code?: string } })?.error?.code ?? `http-${response.status}` } });
        return;
      }
      streamOpen = true;
      printJson(output, { subscription: { state: 'open', cursor } });
      const reader = response.body!.getReader(); const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const parsed = parseSseFrame(frame); if (!parsed) continue;
          let payload: unknown = parsed.data;
          try { payload = JSON.parse(parsed.data); } catch { /* keep text */ }
          if (parsed.id && /^\d+$/.test(parsed.id)) cursor = parsed.id;
          if (parsed.event === 'snapshot') {
            const state = payload as { cursor?: string; paused?: boolean; stopping?: boolean; gap?: boolean };
            if (state.cursor) cursor = state.cursor;
            printJson(output, { subscription: { state: 'snapshot', cursor, paused: state.paused, stopping: state.stopping, gap: state.gap } });
          } else if (parsed.event === 'gap') {
            printJson(output, { gap: payload });
          } else if (parsed.event.startsWith('control.') || parsed.event.startsWith('runtime.') || parsed.event.startsWith('tool.')) {
            printJson(output, { event: { kind: parsed.event, seq: parsed.id, payload } });
          }
        }
      }
      if (!controller.signal.aborted) {
        streamOpen = false;
        printJson(output, { subscription: { state: 'closed', cursor } });
      }
    } catch (error) {
      streamOpen = false;
      if (!controller.signal.aborted) printJson(output, { subscription: { state: 'error', cursor, error: error instanceof Error ? error.message : String(error) } });
    } finally {
      if (stream === controller) stream = undefined;
    }
  };
  const eventState = () => ({ state: stream ? (streamOpen ? 'open' : 'connecting') : 'disconnected', cursor });

  const command = async (words: string[]): Promise<{ exit?: boolean }> => {
    const [verb, subverb, ...rest] = words;
    if (!verb || verb === 'help') {
      printJson(output, { commands: [
        'help', 'status', 'doctor', 'pair <code>',
        'goal show [id]', 'goal set <id> <text>', 'goal revise <id> <revision> <change>',
        'message <text>', 'chat <text>', 'pause', 'resume', 'recover', 'stop', 'save',
        'cancel <executionId>', 'executions', 'effects [executionId]', 'events [cursor] [limit]',
        'places', 'provider', 'capabilities', 'config',
        'subscribe [cursor]', 'disconnect', 'reconnect', 'stream',
        'quit (detach CLI; does not stop the Runtime)', 'shutdown (send quit to the Runtime)',
      ], note: 'All writes go through the serving ControlService. Use shutdown to stop the Runtime.' });
      return {};
    }
    if (verb === 'quit' || verb === 'exit') { printJson(output, { quit: true, runtimeStopped: false, note: 'CLI detached; the Runtime is still running. Use shutdown to stop it.' }); return { exit: true }; }
    if (verb === 'pair') { printJson(output, await pair(subverb ?? '')); return {}; }
    if (verb === 'disconnect' || verb === 'unsubscribe') { disconnect('command'); return {}; }
    if (verb === 'reconnect' || verb === 'subscribe') {
      if (stream) disconnect('reconnect');
      // The subscription runs until it is disconnected; the REPL must keep accepting commands.
      void connect(subverb && /^\d+$/.test(subverb) ? subverb : cursor);
      return {};
    }
    if (verb === 'stream' || verb === 'subscription') { printJson(output, { stream: eventState() }); return {}; }
    if (verb === 'shutdown' || verb === 'runtime-quit') { printJson(output, (await postCommand('quit', {})).body); return {}; }
    const paths: Record<string, string> = {
      status: '/api/v1/status', state: '/api/v1/status', executions: '/api/v1/executions', places: '/api/v1/places',
      provider: '/api/v1/provider', capabilities: '/api/v1/capabilities', config: '/api/v1/config',
    };
    if (paths[verb] && !subverb) { printJson(output, (await request('GET', paths[verb]!)).body); return {}; }
    if (verb === 'doctor') {
      // The serving Runtime owns the authoritative P21 report. Fetch it through the same
      // authenticated surface instead of composing a reduced local view that omits
      // ownership/recovery/store evidence. The server already redacts; printJson redacts again.
      printJson(output, (await request('GET', '/api/v1/doctor')).body);
      return {};
    }
    if (verb === 'effects') {
      const query = subverb ? `?executionId=${encodeURIComponent(subverb)}` : '';
      printJson(output, (await request('GET', `/api/v1/effects${query}`)).body); return {};
    }
    if (verb === 'events') {
      const at = subverb && /^\d+$/.test(subverb) ? subverb : '0';
      const limit = rest[0] && /^\d+$/.test(rest[0]) ? rest[0] : '100';
      printJson(output, (await request('GET', `/api/v1/events?cursor=${encodeURIComponent(at)}&limit=${limit}`)).body); return {};
    }
    if (verb === 'goal' && subverb === 'show') {
      const body = (await request('GET', '/api/v1/goals')).body as unknown;
      printJson(output, rest[0] && Array.isArray(body) ? (body as Array<{ goal_id?: string }>).filter(goal => goal.goal_id === rest[0]) : body);
      return {};
    }
    if (verb === 'goal' && subverb === 'set') {
      if (!rest[0] || rest.length < 2 || !rest.slice(1).join(' ').trim()) throw new Error('usage: goal set <id> <text>');
      const existing = await readGoal(rest[0]);
      printJson(output, (await postCommand('goal.set', { goalId: rest[0], text: rest.slice(1).join(' ') }, existing?.revision)).body);
      return {};
    }
    if (verb === 'goal' && subverb === 'revise') {
      if (!rest[0] || rest[1] === undefined || rest.length < 3) throw new Error('usage: goal revise <id> <revision> <change>');
      const revision = Number(rest[1]);
      if (!Number.isInteger(revision) || revision < 0) throw new Error('usage: goal revise <id> <revision> <change>');
      printJson(output, (await postCommand('goal.revise', { goalId: rest[0], expectedRevision: revision, change: rest.slice(2).join(' ') }, revision)).body);
      return {};
    }
    if (verb === 'message' || verb === 'chat') {
      const text = [subverb, ...rest].filter(Boolean).join(' ');
      if (!text) throw new Error(`usage: ${verb} <text>`);
      printJson(output, (await postCommand(verb, { text })).body); return {};
    }
    if (['pause', 'resume', 'recover', 'stop', 'save'].includes(verb)) { printJson(output, (await postCommand(verb, {})).body); return {}; }
    if (verb === 'cancel') {
      if (!subverb) throw new Error('usage: cancel <executionId>');
      printJson(output, (await postCommand('cancel', { executionId: subverb })).body); return {};
    }
    throw new Error(`unknown-command:${verb}`);
  };

  if (options.pairCode) {
    try { printJson(output, await pair(options.pairCode)); }
    catch (error) { printJson(output, { command: 'pair', error: error instanceof Error ? error.message : String(error) }); }
  }
  if (options.subscribe !== false) void connect();
  const abortListener = () => { disconnect('signal'); };
  options.signal?.addEventListener('abort', abortListener, { once: true });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const words = parseWords(line);
      try { const outcome = await command(words); if (outcome.exit) break; }
      catch (error) { printJson(output, { command: words.join(' '), error: error instanceof Error ? error.message : String(error) }); }
    }
  } finally {
    rl.close();
    if (stream) { const controller = stream; stream = undefined; controller.abort(); }
    options.signal?.removeEventListener('abort', abortListener);
  }
}
async function listenServer(server: import('fastify').FastifyInstance, host: string, port: number) {
  await server.listen({ port, host });
  const address = server.server.address(); if (!address || typeof address === 'string') throw new Error('server-address-unavailable'); return `http://${host}:${address.port}`;
}

export type ServePairingResolution = { pairingCode?: string; generated: boolean };

/**
 * Resolve the pairing code before a serving Runtime takes the storage lock. A generated code is
 * only usable when it can be shown to the owning terminal; non-interactive stdout therefore
 * requires an explicit code instead of silently starting an unpaired, unreachable daemon.
 */
export function resolveServePairingCode(input: { pairing: boolean; explicit?: string; isTty: boolean; generate?: () => string }): ServePairingResolution {
  if (!input.pairing) return { generated: false };
  if (input.explicit !== undefined) {
    if (!input.explicit.trim()) throw new Error('pairing-code-invalid');
    return { pairingCode: input.explicit, generated: false };
  }
  if (!input.isTty) throw new Error('pairing-code-required:non-tty');
  return { pairingCode: (input.generate ?? generatePairingCode)(), generated: true };
}

export type ServeProviderReport = {
  requested: 'openai' | 'anthropic';
  model?: string;
  baseUrl?: string;
  configured: boolean;
  networkEnabled: boolean;
  transport: string;
};

export type ServeStartupFields = {
  url: string;
  profile: string;
  db: string;
  pairing: boolean;
  cliBearer?: string;
  webRoot?: string;
  config?: { path: string; profile: string | null; allowModelNetwork: boolean };
  provider?: ServeProviderReport;
};

/** Startup JSON. A generated pairing code is disclosed only to an interactive TTY. */
export function buildServeStartupDocument(fields: ServeStartupFields, options: { generatedPairingCode?: string; isTty: boolean }): string {
  const emitGeneratedCode = Boolean(options.generatedPairingCode) && options.isTty;
  const document = {
    listening: fields.url,
    profile: fields.profile,
    db: fields.db,
    pairing: fields.pairing,
    ...(emitGeneratedCode ? { pairingCode: options.generatedPairingCode } : {}),
    cliAccess: fields.cliBearer ? 'bearer-configured' : fields.pairing ? 'pair-with-code' : 'loopback-open',
    webRoot: fields.webRoot ?? './dist/web',
    ...(fields.config ? { config: fields.config } : {}),
    ...(fields.provider ? { provider: fields.provider } : {}),
  };
  const redacted = redact(document) as Record<string, unknown>;
  // `pairingCode` is a redaction key by design; restore only the intentional TTY disclosure.
  if (emitGeneratedCode) redacted.pairingCode = options.generatedPairingCode;
  return JSON.stringify(redacted);
}

export type ServeCommandOptions = {
  db?: string;
  host?: string;
  port?: string;
  profile?: string;
  config?: string;
  pairing?: boolean;
  pairingCode?: string;
  cliBearer?: string;
  webRoot?: string;
  allowedOrigin?: string;
  /**
   * Explicit model provider selection. Only meaningful together with a serve config that
   * sets `allowModelNetwork: true`; without one the gate cannot be honored and serve fails
   * instead of silently starting the scripted provider.
   */
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
};

export async function runServe(options: ServeCommandOptions) {
  // A serve config is strict: keys the serving runtime cannot honor (relay target, upstream
  // gate, helper) fail instead of being accepted and ignored.
  const profileConfig = options.config ? loadProfileConfig(resolve(options.config), 'serve') : undefined;
  const db = options.db ?? process.env.MINECRAFT_AGENT_DB ?? '/tmp/minecraft-agent.sqlite';
  const profile = options.profile ?? profileConfig?.profile ?? 'simulated';
  const host = options.host ?? '127.0.0.1';
  const pairing = options.pairing ?? true;
  const explicitPairingCode = options.pairingCode ?? process.env.MINECRAFT_AGENT_PAIRING_CODE;
  const isTty = process.stdout.isTTY === true;
  // `allowModelNetwork` is only truthful when a concrete provider is selected. Reject both
  // an open gate with no provider (it would silently stay scripted) and a provider selection
  // while the gate is closed (it could never reach the network).
  const requestedProvider = options.provider;
  if (requestedProvider !== undefined && requestedProvider !== 'openai' && requestedProvider !== 'anthropic') {
    throw new Error(`config-invalid:provider:${requestedProvider}`);
  }
  const allowModelNetwork = profileConfig?.allowModelNetwork === true;
  if (requestedProvider !== undefined && !allowModelNetwork) throw new Error('model-network-gate-disabled');
  if (requestedProvider === undefined && allowModelNetwork) throw new Error('model-provider-required');
  const apiKey = options.apiKey ?? process.env.MINECRAFT_AGENT_MODEL_API_KEY;
  if (requestedProvider !== undefined && !apiKey) throw new Error('model-provider-not-configured');
  // Fail before taking ownership when the generated code could not be delivered to the owner.
  const startupPairing = resolveServePairingCode({
    pairing,
    ...(explicitPairingCode === undefined ? {} : { explicit: explicitPairingCode }),
    isTty,
  });
  const runtime = createRuntime({
    profile: profile as 'simulated' | 'simulated-3d' | 'client-offline',
    db,
    ...(profileConfig?.allowModelNetwork === undefined ? {} : { allowModelNetwork: profileConfig.allowModelNetwork }),
    ...(requestedProvider === undefined ? {} : { modelProvider: requestedProvider as 'openai' | 'anthropic' }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
  });
  // The factory's metadata is the source of truth. A provider selected behind a gate that
  // produced no configured network transport must not be reported as serving.
  if (requestedProvider !== undefined && (!runtime.providerMetadata.configured || !runtime.providerMetadata.networkEnabled)) {
    runtime.close();
    throw new Error('model-provider-not-configured');
  }
  const cliBearer = options.cliBearer ?? process.env.MINECRAFT_AGENT_CLI_TOKEN;
  let server: ReturnType<typeof createControlServer> | undefined;
  let closing = false;
  // Cleanup is shared by normal shutdown and a failed startup. It removes both signal
  // listeners so a failed serve attempt cannot accumulate duplicate handlers, then closes
  // the server and releases the Runtime/ownership lock before the error is rethrown.
  const close = async () => {
    if (closing) return;
    closing = true;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try { await server?.close(); } catch { /* the original failure is rethrown by the caller */ }
    runtime.close();
  };
  const onSignal = () => { void close(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    server = createControlServer(runtime, {
      host,
      pairing,
      ...(startupPairing.pairingCode === undefined ? {} : { pairingCode: startupPairing.pairingCode }),
      cliBearer,
      webRoot: options.webRoot,
      allowedOrigin: options.allowedOrigin,
    });
    const url = await listenServer(server, host, Number(options.port ?? 3000)); runtime.session.start();
    // A generated one-time pairing code is printed once to the owning terminal; an explicitly
    // configured code is not repeated. The CLI bearer and any API key are never logged.
    console.log(buildServeStartupDocument({
      url,
      profile,
      db,
      pairing,
      ...(cliBearer === undefined ? {} : { cliBearer }),
      ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
      ...(profileConfig ? { config: { path: resolve(options.config!), profile: profileConfig.profile ?? null, allowModelNetwork: profileConfig.allowModelNetwork ?? false } } : {}),
      ...(requestedProvider === undefined ? {} : {
        provider: {
          requested: requestedProvider as 'openai' | 'anthropic',
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          configured: runtime.providerMetadata.configured,
          networkEnabled: runtime.providerMetadata.networkEnabled === true,
          transport: runtime.providerMetadata.transport,
        },
      }),
    }, {
      ...(startupPairing.generated && startupPairing.pairingCode ? { generatedPairingCode: startupPairing.pairingCode } : {}),
      isTty,
    }));
  } catch (error) {
    await close();
    throw error;
  }
  await new Promise<void>(resolve => { const timer = setInterval(() => { if (closing || runtime.control.status().stopping) { clearInterval(timer); void close().then(resolve); } }, 25); });
}

/**
 * Minimal supervisor surface used for the explicit arm request. The `arm` IPC command is
 * part of the bridge-service protocol; the status is re-read afterwards so a failed request
 * is never reported as opened admission.
 */
export type BridgeArmSupervisor = { request<T = unknown>(command: 'arm' | 'status', payload?: unknown): Promise<T> };

export type BridgeArmReport = {
  requested: boolean;
  admissionOpen: boolean;
  result?: unknown;
  error?: string;
};

/**
 * Send `arm` only when explicitly requested, then re-read the service status so the caller
 * reports the actual admission state instead of assuming the request succeeded.
 */
export async function armBridgeService(supervisor: BridgeArmSupervisor, requested: boolean): Promise<BridgeArmReport> {
  if (!requested) return { requested: false, admissionOpen: false };
  let result: unknown;
  let error: string | undefined;
  try {
    // The literal `arm` request is only sent when the operator passed --arm.
    result = await supervisor.request('arm', { reason: 'cli-arm' });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const status = await supervisor.request<{ admissionOpen?: unknown }>('status').catch(() => undefined);
  return {
    requested: true,
    admissionOpen: status?.admissionOpen === true,
    ...(error === undefined ? { result } : { error }),
  };
}

export type BridgeServiceCommandOptions = {
  entryUrl?: URL;
  /** Explicit operator arming after start. Never enabled implicitly. */
  arm?: boolean;
  /** Truthful reporting of which target the relay child was configured with. */
  source?: 'loopback-fixture' | 'configured-target';
  target?: { host: string; port: number };
  network?: string;
  /**
   * Fork replacement for tests. It receives the effective child config so a regression can
   * prove exactly what crosses the process boundary. Production always forks the real entry.
   */
  spawn?: (config: BridgeServiceChildConfig) => ChildProcessLike;
};

/**
 * The child config also carries the caller's target provenance. The service entry only reads
 * the documented `BridgeServiceEntryConfig` fields, but keeping the provenance here lets the
 * CLI report the same truthful profile/network/source it actually started with instead of
 * inventing defaults.
 */
export type BridgeServiceChildConfig = BridgeServiceEntryConfig & {
  source?: 'loopback-fixture' | 'configured-target';
};

/**
 * Run the P09 bridge-service orchestration from the CLI (not just a bare raw relay).
 * This is a real service child + relay child; the caller supplies the relay target so service
 * mode can use the configured upstream while fixture mode keeps its loopback echo. No real
 * client body is invented.
 */
export async function runBridgeServiceCommand(config: BridgeServiceEntryConfig, options: BridgeServiceCommandOptions = {}): Promise<Record<string, unknown>> {
  // Carry the caller's real labels into the child. Never substitute 'client-offline' or a
  // 'disabled' network here: an omitted profile stays omitted and the child reports
  // `unspecified`; an omitted network is derived from the relay gate it was actually given.
  const serviceConfig: BridgeServiceChildConfig = {
    ...config,
    ...(options.network === undefined ? {} : { network: options.network }),
    ...(options.source === undefined ? {} : { source: options.source }),
  };
  const supervisor = new ProcessSupervisor({
    spawn: () => (options.spawn ?? (() => spawnBridgeServiceProcess(serviceConfig, options.entryUrl ? { entryUrl: options.entryUrl } : {})))(serviceConfig),
    ipcTimeoutMs: 10_000,
  });
  try {
    await supervisor.start();
    const sessionEpoch = await supervisor.waitForHello(10_000);
    let status: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await supervisor.request<Record<string, unknown>>('status').catch(() => undefined);
      if (status?.state === 'running' || status?.state === 'degraded') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const arming = await armBridgeService(supervisor, options.arm === true);
    // Re-read status after arming so the result reflects what actually happened.
    if (options.arm) status = await supervisor.request<Record<string, unknown>>('status').catch(() => status);
    const shutdown = await supervisor.request<{ stopped: boolean }>('shutdown').catch(error => ({ stopped: false, error: error instanceof Error ? error.message : String(error) }));
    // A service that never confirmed running/degraded must not be reported as a normal result:
    // the CLI would otherwise exit 0 while the child never became usable. The supervisor wait
    // above stays bounded; this is the explicit failure gate after that wait.
    if (status?.state !== 'running' && status?.state !== 'degraded') {
      throw new Error(`bridge-service-not-ready:${typeof status?.state === 'string' ? status.state : 'unknown'}`);
    }
    return {
      mode: 'service',
      orchestration: 'bridge-service',
      source: options.source ?? 'loopback-fixture',
      network: options.network ?? 'disabled',
      ...(options.target ? { target: { ...options.target, source: options.source ?? 'loopback-fixture' } } : {}),
      arm: { ...arming, ...(status?.admissionOpen === undefined ? {} : { admissionOpen: status.admissionOpen === true }) },
      // There is no real Minecraft client process/world in this environment. Report the boundary
      // instead of substituting a simulated body for a live one.
      boundary: 'client-body-unavailable',
      liveCompatibility: 'not-verified',
      sessionEpoch,
      status: status ?? null,
      shutdown,
    };
  } finally {
    await supervisor.stop().catch(() => undefined);
  }
}

export type BridgeMode = 'fixture' | 'inspect' | 'service' | 'live';
export type BridgeCommandOptions = { config?: string; mode?: string; arm?: boolean; output?: (value: unknown) => void };
export type BridgeFixtureUpstream = { port: number; close(): Promise<void> };
export type BridgeCommandDependencies = {
  runService?: typeof runBridgeServiceCommand;
  fixtureUpstream?: () => Promise<BridgeFixtureUpstream>;
};

/** Service mode connects to the operator-configured target; a missing target is an error. */
export function bridgeServiceTarget(config: ProfileConfig): { host: string; port: number } {
  if (config.targetHost === undefined || config.targetPort === undefined) throw new Error('config-key-missing:targetHost-or-targetPort');
  return { host: config.targetHost, port: config.targetPort };
}

async function startEchoUpstream(): Promise<BridgeFixtureUpstream> {
  const upstream = net.createServer(socket => { socket.on('data', chunk => socket.write(chunk)); });
  await new Promise<void>((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
  return {
    port: (upstream.address() as import('node:net').AddressInfo).port,
    close: () => new Promise<void>(resolve => upstream.close(() => resolve())),
  };
}

/**
 * Bridge modes with one strict loader. Fixture mode always uses a loopback echo target that is
 * reported as fixture, never the configured real target; service mode is the only mode that
 * uses targetHost/targetPort. The upstream gate must be explicitly true in both modes.
 */
export async function runBridgeCommand(options: BridgeCommandOptions = {}, deps: BridgeCommandDependencies = {}): Promise<void> {
  // The default command is the offline fixture. `client-offline.example.json` has the
  // upstream gate closed by design, so it can never run the default mode; the dedicated
  // fixture config is the only shipped file whose true gate authorizes the loopback echo.
  const file = resolve(options.config ?? 'configs/bridge-fixture.example.json');
  const config = loadProfileConfig(file, 'bridge');
  const mode = (options.mode ?? 'fixture') as BridgeMode;
  const write = options.output ?? ((value: unknown) => console.log(JSON.stringify(redact(value))));
  if (!['fixture', 'inspect', 'service', 'live'].includes(mode)) throw new Error('invalid-bridge-mode');
  if (options.arm && mode !== 'service') throw new Error('arm-requires-service-mode');
  const profile = getGameVersionProfile();
  const configuredTarget = config.targetHost !== undefined && config.targetPort !== undefined
    ? { host: config.targetHost, port: config.targetPort }
    : undefined;
  const configReport = {
    path: file,
    profile: config.profile ?? null,
    allowMinecraftUpstream: config.allowMinecraftUpstream ?? false,
    ...(configuredTarget ? { target: configuredTarget } : {}),
    ...(config.listenHost === undefined ? {} : { listenHost: config.listenHost }),
    ...(config.listenPort === undefined ? {} : { listenPort: config.listenPort }),
    ...(config.rewriteHandshake === undefined ? {} : { rewriteHandshake: config.rewriteHandshake }),
    ...(config.handshakeLimitBytes === undefined ? {} : { handshakeLimitBytes: config.handshakeLimitBytes }),
    ...(config.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: config.handshakeTimeoutMs }),
  };

  if (mode === 'live') {
    if (config.allowMinecraftUpstream !== true) throw new Error('live-mode-requires-explicit-upstream-gate');
    throw new Error('live-mode-requires-real-client-environment');
  }
  if (mode === 'inspect') {
    write({
      mode, source: 'fixture', network: 'disabled',
      profile: versionProfileSummary(profile), protocol: { legacyCodecFixture: minecraftDataSummary(), target: profile },
      target: configuredTarget ? { ...configuredTarget, source: 'configured-target', connected: false } : null,
      config: configReport,
    });
    return;
  }
  if (mode === 'service') {
    if (config.allowMinecraftUpstream !== true) throw new Error('service-mode-requires-explicit-upstream-gate');
    const target = bridgeServiceTarget(config);
    // This config is also handed to the service child, so it carries the real loaded profile
    // instead of leaving the child to guess or report `unspecified` for a known profile.
    const serviceConfig: BridgeServiceChildConfig = {
      relay: {
        listenHost: config.listenHost ?? '127.0.0.1',
        listenPort: config.listenPort ?? 0,
        targetHost: target.host,
        targetPort: target.port,
        allowMinecraftUpstream: true,
        heartbeatMs: 60,
        ...(config.rewriteHandshake === undefined ? {} : { rewriteHandshake: config.rewriteHandshake }),
        ...(config.handshakeLimitBytes === undefined ? {} : { handshakeLimitBytes: config.handshakeLimitBytes }),
        ...(config.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: config.handshakeTimeoutMs }),
      },
      observer: { enabled: true },
      ...(config.profile === undefined ? {} : { profile: config.profile }),
      network: 'upstream-explicit',
      source: 'configured-target',
      shutdownGraceMs: 1_000, helloTimeoutMs: 5_000, maxRestarts: 1, backoffBaseMs: 10, maxIpcMessages: 256,
    };
    const result = await (deps.runService ?? runBridgeServiceCommand)(serviceConfig, { arm: options.arm === true, source: 'configured-target', target, network: 'upstream-explicit' });
    write({ ...result, profile: versionProfileSummary(profile), protocol: { legacyCodecFixture: minecraftDataSummary(), target: profile }, config: configReport });
    return;
  }

  // Fixture: the configured target is deliberately not used. The loopback echo is reported
  // as the fixture target so it can never be mistaken for a live server connection.
  if (config.allowMinecraftUpstream !== true) throw new Error('fixture-mode-requires-explicit-upstream-gate');
  const upstream = await (deps.fixtureUpstream ?? startEchoUpstream)();
  const relay = createRawTcpRelay({ listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort: upstream.port, allowMinecraftUpstream: true });
  try {
    await relay.start();
    const client = net.createConnection(relay.address.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('error', reject); });
    const payload = Buffer.from('furevercraft-relay-fixture');
    const response = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      client.on('data', chunk => { chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length >= payload.length) resolve(Buffer.concat(chunks)); });
      client.once('error', reject);
    });
    client.write(payload);
    const echoed = await response;
    client.end();
    if (!echoed.equals(payload)) throw new Error('relay-fixture-byte-mismatch');
    write({
      mode, source: 'fixture', network: 'loopback-only',
      target: { host: '127.0.0.1', port: upstream.port, source: 'loopback-fixture' },
      ...(configuredTarget ? { configuredTarget: { ...configuredTarget, used: false } } : {}),
      profile: versionProfileSummary(profile), protocol: { legacyCodecFixture: minecraftDataSummary(), target: profile },
      scenario: { transport: 'raw-tcp', echoBytes: echoed.length, byteEquality: true, termination: 'none' },
      sessions: relay.sessions().length,
      config: configReport,
    });
  } finally {
    await relay.stop();
    await upstream.close();
  }
}

export type DoctorCommandOptions = { profile?: string; db?: string; generatedAt?: number };

/**
 * Assemble the requested profile and report what it actually has. A profile that
 * cannot be assembled (for example client-offline with no real body) is reported
 * as unavailable with the real reason instead of a static optimistic answer.
 */
export function runDoctorCommand(options: DoctorCommandOptions = {}): DoctorReport {
  const profile = options.profile ?? 'simulated';
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    runtime = createRuntime({ profile: profile as 'simulated' | 'simulated-3d' | 'client-offline', ...(options.db ? { db: options.db } : {}) });
    return collectDoctorReport(runtime, options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt });
  } catch (error) {
    return unavailableDoctorReport({
      profile,
      reason: error instanceof Error ? error.message : String(error),
      ...(options.db ? { dbPath: options.db } : {}),
      ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    });
  } finally {
    runtime?.close();
  }
}

export type TraceExportCommandOptions = {
  db?: string;
  cursor?: string;
  maxRecords?: number;
  maxRecordBytes?: number;
  maxBytes?: number;
  retentionMs?: number;
};

export function runTraceExportCommand(options: TraceExportCommandOptions = {}) {
  const store = new SQLiteStore(options.db ?? process.env.MINECRAFT_AGENT_DB ?? ':memory:');
  try {
    return exportTraceFromStore(store, {
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
      ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.retentionMs === undefined ? {} : { retentionMs: options.retentionMs }),
    });
  } finally {
    store.close();
  }
}

export type TraceReplayCommandOptions = { cursor?: string };

export function runTraceReplayCommand(document: unknown, options: TraceReplayCommandOptions = {}) {
  return replayTrace(document as Parameters<typeof replayTrace>[0], options.cursor === undefined ? {} : { cursor: options.cursor });
}

const numberOption = (name: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`invalid-${name}`);
  return parsed;
};

/**
 * Commander stores a value for duplicate option names (`--db` exists on both the root
 * program and most subcommands) in the parent Command, not in the subcommand's own options.
 * The action's local `options` object can therefore be empty; `optsWithGlobals()` is the
 * only merged view that contains the value the user actually passed.
 */
const mergedDb = (command: { optsWithGlobals(): Record<string, unknown> }): string => {
  const db = command.optsWithGlobals().db;
  return (typeof db === 'string' && db !== '' ? db : undefined) ?? process.env.MINECRAFT_AGENT_DB ?? ':memory:';
};

export function main(argv = process.argv) {
  const program = new Command();
  program.name('minecraft-agent').option('--profile <profile>', 'profile').option('--db <path>', 'SQLite path');
  program.command('demo').option('--db <path>').option('--scenario <scenario>').action(async (_options, command) => {
    const merged = command.optsWithGlobals();
    await runDemo(
      typeof merged.db === 'string' ? merged.db : undefined,
      typeof merged.scenario === 'string' ? merged.scenario : undefined,
    );
  });
  program.command('serve').option('--db <path>').option('--host <host>', 'bind host', '127.0.0.1').option('--port <port>', 'bind port', '3000')
    .option('--config <path>', 'strict profile config')
    .option('--no-pairing', 'disable local pairing (loopback-open development mode)')
    .option('--pairing-code <code>', 'fixed local pairing code (not printed when supplied)')
    .option('--cli-bearer <token>', 'CLI bearer token (prefer MINECRAFT_AGENT_CLI_TOKEN)')
    .option('--web-root <path>', 'static build directory', './dist/web')
    .option('--allowed-origin <origin>', 'extra development origin allowed for the web UI')
    // Provider selection is only honored when the serve config opens allowModelNetwork.
    // These options exist so that gate is not inert: the startup document reports the
    // effective provider metadata, and an open gate without a provider is rejected.
    .option('--provider <provider>', 'model provider (openai|anthropic); requires allowModelNetwork config')
    .option('--model <model>', 'model name for the selected provider')
    .option('--base-url <url>', 'provider base URL')
    .option('--api-key <key>', 'provider API key (prefer MINECRAFT_AGENT_MODEL_API_KEY)')
    .action((_options, command) => {
      const merged = command.optsWithGlobals() as Record<string, string | boolean | undefined>;
      return runServe({
        db: merged.db as string | undefined,
        host: merged.host as string | undefined,
        port: merged.port as string | undefined,
        profile: merged.profile as string | undefined,
        config: merged.config as string | undefined,
        pairing: merged.pairing as boolean | undefined,
        pairingCode: merged.pairingCode as string | undefined,
        cliBearer: merged.cliBearer as string | undefined,
        webRoot: merged.webRoot as string | undefined,
        allowedOrigin: merged.allowedOrigin as string | undefined,
        provider: merged.provider as string | undefined,
        model: merged.model as string | undefined,
        baseUrl: merged.baseUrl as string | undefined,
        apiKey: merged.apiKey as string | undefined,
      });
    });
  program.command('attach').requiredOption('--url <url>')
    .option('--token <token>', 'CLI bearer token (defaults to MINECRAFT_AGENT_CLI_TOKEN)')
    .option('--pair-code <code>', 'pair with a local one-time code before attaching')
    .option('--cursor <cursor>', 'initial event cursor', '0')
    .option('--no-subscribe', 'do not open the event/state subscription automatically')
    .action(options => runAttach(options.url, {}, { token: options.token, pairCode: options.pairCode, subscribe: options.subscribe, cursor: options.cursor }));
  program.command('status').option('--db <path>').action((_options, command) => {
    console.log(JSON.stringify(redact(runStatusCommand({ db: mergedDb(command) }))));
  });
  program.command('doctor').option('--db <path>').action((_options, command) => {
    const merged = command.optsWithGlobals();
    const profile = typeof merged.profile === 'string' ? merged.profile : 'simulated';
    const db = typeof merged.db === 'string' ? merged.db : undefined;
    console.log(JSON.stringify(redact(runDoctorCommand({ profile, ...(db ? { db } : {}) }))));
  });
  program.command('bridge').option('--config <path>', 'profile config').option('--mode <mode>', 'fixture|inspect|service|live', 'fixture')
    .option('--arm', 'send an explicit arm IPC request after service start')
    .action((options) => runBridgeCommand({ ...(options.config ? { config: options.config } : {}), mode: options.mode, arm: options.arm === true }));
  program.command('goal:revise').requiredOption('--id <goalId>').requiredOption('--revision <revision>').requiredOption('--change <change>').option('--db <path>').action((options, command) => {
    console.log(JSON.stringify(redact(runGoalReviseCommand({ db: mergedDb(command), id: options.id, revision: Number(options.revision), change: options.change }))));
  });
  program.command('events').option('--cursor <cursor>', 'cursor', '0').option('--limit <limit>', '100').option('--db <path>').action((options, command) => {
    console.log(JSON.stringify(redact(runEventsCommand({ db: mergedDb(command), cursor: options.cursor, limit: Number(options.limit) }))));
  });
  program.command('trace:export')
    .option('--db <path>')
    .option('--out <path>')
    .option('--cursor <cursor>', 'export events after this cursor', '0')
    .option('--max-records <n>', 'bounded event records', '4096')
    .option('--max-record-bytes <n>', 'bound per payload', '16384')
    .option('--max-bytes <n>', 'bounded total trace size', '4194304')
    .option('--retention-ms <n>', 'drop records older than this', '86400000')
    .action((options, command) => {
      // The root program also defines --db; commander stores the value on the parent,
      // so read the merged global view instead of silently using :memory:.
      const db = command.optsWithGlobals().db as string | undefined;
      const document = runTraceExportCommand({
        ...(db ? { db } : {}),
        cursor: options.cursor,
        maxRecords: numberOption('max-records', options.maxRecords),
        maxRecordBytes: numberOption('max-record-bytes', options.maxRecordBytes),
        maxBytes: numberOption('max-bytes', options.maxBytes),
        retentionMs: numberOption('retention-ms', options.retentionMs),
      });
      const summary = {
        source: document.source,
        records: document.records.length,
        inputIntents: (document.inputIntents ?? []).length,
        effects: (document.effects ?? []).length,
        dropped: document.dropped ?? 0,
        truncated: document.truncated === true,
        policy: document.policy,
      };
      if (options.out) {
        writeFileSync(options.out, JSON.stringify(document));
        console.log(JSON.stringify(redact({ written: options.out, ...summary })));
      } else console.log(JSON.stringify(redact(document)));
    });
  program.command('trace:replay')
    .requiredOption('--file <path>')
    .option('--cursor <cursor>', 'replay only events after this cursor')
    .option('--strict', 'exit 2 when the trace is not contiguous')
    .action((options) => {
      try {
        const document = JSON.parse(readFileSync(options.file, 'utf8')) as unknown;
        const result = runTraceReplayCommand(document, options.cursor === undefined ? {} : { cursor: options.cursor });
        console.log(JSON.stringify(redact(result)));
        if (options.strict && !result.contiguous) process.exitCode = 2;
      } catch (error) {
        console.log(JSON.stringify({ error: redact(error instanceof Error ? error.message : String(error)) }));
        process.exitCode = 1;
      }
    });
  program.action(async () => { await runDemo(program.opts().db); });
  return program.parseAsync(argv);
}
if (process.argv[1]?.endsWith('main.js')) main();
