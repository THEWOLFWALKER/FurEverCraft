import { Command } from 'commander';
import { FakeClientBridge } from '../bridge/fake/index.js';
import { navigate } from '../skills/navigation.js';
import { SQLiteStore } from '../persistence/store.js';
import { SessionRuntime } from '../execution/session.js';
import { placeOne, sendChat, navigateTo } from '../skills/skills.js';
import { ProtocolSession, OfflineProtocolBridge, LoopbackFixtureTransport, minecraftDataSummary } from '../bridge/protocol/session.js';
import { createRawTcpRelay } from '../bridge/relay/raw.js';
import net from 'node:net';
import { createRuntime } from '../execution/factory.js';
import { redact } from '../diagnostics/redaction.js';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { getGameVersionProfile, versionProfileSummary } from '../bridge/version-profile.js';
import { createControlServer } from '../server/index.js';
import { replayTrace, exportTraceFromStore } from '../diagnostics/trace.js';
import { collectDoctorReport, unavailableDoctorReport, type DoctorReport } from '../diagnostics/doctor.js';
import { ProcessSupervisor } from '../bridge/supervisor.js';
import { spawnBridgeServiceProcess } from '../bridge/service/spawn.js';
import type { BridgeServiceEntryConfig } from '../bridge/service/entry.js';

export async function runDemo(db = process.env.MINECRAFT_AGENT_DB ?? '/tmp/minecraft-agent-phase2-demo.sqlite', scenario?: string) {
  const names = ['autonomous','obstruction','human-steering','chat-ui','crash-recovery','bridge-fixture'] as const;
  if (scenario && !names.includes(scenario as typeof names[number])) throw new Error(`unknown-scenario:${scenario}`);
  const selected = scenario ? [scenario as typeof names[number]] : [...names];
  // Each scenario gets a freshly created database so repeated runs are deterministic.
  const results = selected.map((name, index) => {
    const scenarioDb = `${db}.${index}`;
    for (const suffix of ['', '-wal', '-shm']) { try { rmSync(`${scenarioDb}${suffix}`, { force: true }); } catch { /* best effort */ } }
    return runScenario(name, scenarioDb);
  });
  console.log(JSON.stringify(redact({ simulated: true, scenarios: results, summary: { count: results.length, names: results.map(r => r.scenario) } })));
}

type ScenarioName = 'autonomous'|'obstruction'|'human-steering'|'chat-ui'|'crash-recovery'|'bridge-fixture';
function runScenario(scenario: ScenarioName, db: string) {
  const store = new SQLiteStore(db); const bridge = new FakeClientBridge(); const runtime = new SessionRuntime(bridge, store); runtime.start();
  try {
    if (scenario === 'autonomous') { const first = navigate(bridge, {x:2,y:0}); store.saveGoal({goalId:'goal_autonomous',revision:1,status:'active',text:'autonomous navigation'}); const next = navigate(bridge,{x:3,y:0}); const completed = first.status === 'succeeded' && next.status === 'succeeded'; if (completed) store.saveGoal({goalId:'goal_autonomous',revision:2,status:'completed',text:'autonomous navigation'}); return {scenario,outcome:completed?'completed':'failed',phases:['observe','navigate','milestone','next-task'],executionIds:[first.executionId,next.executionId],goal:store.getGoal('goal_autonomous')?.status,position:bridge.position}; }
    if (scenario === 'obstruction') { bridge.block(1,0); bridge.setUnknown(1,1); const result=navigate(bridge,{x:3,y:1},2); return {scenario,outcome:result.status,dynamicObstacle:true,unknownCell:true,replanned:result.path.length>0,budget:2,pathLength:result.path.length}; }
    if (scenario === 'human-steering') { const old=navigate(bridge,{x:4,y:0}); const revised=navigate(bridge,{x:0,y:2}); return {scenario,outcome:revised.status,oldExecution:old.executionId,oldResult:'superseded',steering:'target-revised',position:bridge.position}; }
    if (scenario === 'chat-ui') { const moved=navigate(bridge,{x:1,y:0}); const chat=sendChat({bridge,lease:{leaseId:'demo',owner:'demo',resources:['ui','textEntry'],until:Date.now()+1000,generation:1,contextEpoch:''},report:()=>{}},'offline hello'); return {scenario,outcome:chat.outcome,navigation:moved.status,uiHandoff:['gameplay','chat','gameplay'],unknownMessageNotRetried:true}; }
    if (scenario === 'crash-recovery') {
      // A real execution row must exist before the effect FK; the crash window leaves the
      // effect pending and a rebuilt runtime must reconcile it from evidence.
      store.saveExecution({ executionId: 'execution_demo', proposalId: 'proposal_demo', proposalHash: 'demo', goalId: 'goal_demo', skillId: 'place_one', skillVersion: '1.0.0', status: 'running' });
      bridge.position = { x: 1, y: 0 };
      store.addEffect({ effectId: 'effect_demo', executionId: 'execution_demo', context: bridge.context, status: 'may-have-dispatched', intent: { kind: 'place', x: 2, y: 0 } });
      const before = store.pendingEffects().length; store.close();
      const reopened = new SQLiteStore(db); const restored = new SessionRuntime(new FakeClientBridge(), reopened).recover();
      const after = reopened.pendingEffects().length; reopened.close();
      return { scenario, outcome: 'reconciled', pendingBefore: before, pendingAfter: after, reconciled: restored.reconciled };
    }
    const protocol=new ProtocolSession('fixture-session'); const observations:unknown[]=[]; const unsubscribe=protocol.subscribe(o=>observations.push(o)); protocol.transition('LOGIN'); protocol.transition('CONFIGURATION'); protocol.transition('PLAY'); protocol.observe('position','downstream',{x:1,y:0}); protocol.close(); unsubscribe(); return {scenario,outcome:'fixture-complete',phase:protocol.phase,observations:observations.length,syntheticCapture:true,input:'fake-transport',disconnectCleanup:true};
  } finally { if (scenario !== 'crash-recovery') store.close(); }
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
      // Compose the serving Runtime's real capability/status/provider views rather than
      // printing a static answer. A full doctor report requires the Runtime itself.
      const [capabilities, status, provider] = await Promise.all([
        request('GET', '/api/v1/capabilities'), request('GET', '/api/v1/status'), request('GET', '/api/v1/provider'),
      ]);
      printJson(output, { capabilities: capabilities.body, status: status.body, provider: provider.body });
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
export async function runServe(options: { db?: string; host?: string; port?: string; profile?: string; pairing?: boolean; pairingCode?: string; cliBearer?: string; webRoot?: string; allowedOrigin?: string }) {
  const db = options.db ?? process.env.MINECRAFT_AGENT_DB ?? '/tmp/minecraft-agent.sqlite';
  const runtime = createRuntime({ profile: (options.profile ?? 'simulated') as 'simulated' | 'simulated-3d' | 'client-offline', db });
  const host = options.host ?? '127.0.0.1';
  const pairing = options.pairing ?? true;
  const explicitPairingCode = options.pairingCode ?? process.env.MINECRAFT_AGENT_PAIRING_CODE;
  const pairingCode = explicitPairingCode ?? randomBytes(4).toString('hex');
  const cliBearer = options.cliBearer ?? process.env.MINECRAFT_AGENT_CLI_TOKEN;
  const server = createControlServer(runtime, { host, pairing, pairingCode, cliBearer, webRoot: options.webRoot, allowedOrigin: options.allowedOrigin });
  const url = await listenServer(server, host, Number(options.port ?? 3000)); runtime.session.start();
  // A generated one-time pairing code is printed once to the owning terminal; an explicitly
  // configured code is not repeated. The CLI bearer and any API key are never logged.
  console.log(JSON.stringify({ listening: url, profile: options.profile ?? 'simulated', db, pairing, ...(pairing && !explicitPairingCode ? { pairingCode } : {}), cliAccess: cliBearer ? 'bearer-configured' : pairing ? 'pair-with-code' : 'loopback-open', webRoot: options.webRoot ?? './dist/web' }));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close(); runtime.close(); };
  process.once('SIGINT', close); process.once('SIGTERM', close); await new Promise<void>(resolve => { const timer = setInterval(() => { if (closing || runtime.control.status().stopping) { clearInterval(timer); void close().then(resolve); } }, 25); });
}

/**
 * Run the P09 bridge-service orchestration from the CLI (not just a bare raw relay).
 * This is a real service child + relay child over loopback; external network gates stay off
 * and no real client body is invented.
 */
export async function runBridgeServiceCommand(config: BridgeServiceEntryConfig, options: { entryUrl?: URL } = {}): Promise<Record<string, unknown>> {
  const supervisor = new ProcessSupervisor({ spawn: () => spawnBridgeServiceProcess(config, options.entryUrl ? { entryUrl: options.entryUrl } : {}), ipcTimeoutMs: 10_000 });
  try {
    await supervisor.start();
    const sessionEpoch = await supervisor.waitForHello(10_000);
    let status: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      status = await supervisor.request<Record<string, unknown>>('status').catch(() => undefined);
      if (status?.state === 'running' || status?.state === 'degraded') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const shutdown = await supervisor.request<{ stopped: boolean }>('shutdown').catch(error => ({ stopped: false, error: error instanceof Error ? error.message : String(error) }));
    return {
      mode: 'service',
      orchestration: 'bridge-service',
      source: 'loopback-fixture',
      network: 'disabled',
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

export function main(argv = process.argv) {
  const program = new Command();
  program.name('minecraft-agent').option('--profile <profile>', 'profile', 'simulated').option('--db <path>', 'SQLite path');
  program.command('demo').option('--db <path>').option('--scenario <scenario>').action((options) => runDemo(options.db, options.scenario));
  program.command('serve').option('--db <path>').option('--host <host>', 'bind host', '127.0.0.1').option('--port <port>', 'bind port', '3000')
    .option('--no-pairing', 'disable local pairing (loopback-open development mode)')
    .option('--pairing-code <code>', 'fixed local pairing code (not printed when supplied)')
    .option('--cli-bearer <token>', 'CLI bearer token (prefer MINECRAFT_AGENT_CLI_TOKEN)')
    .option('--web-root <path>', 'static build directory', './dist/web')
    .option('--allowed-origin <origin>', 'extra development origin allowed for the web UI')
    .action((options, command) => runServe({ ...options, profile: command.parent?.opts().profile }));
  program.command('attach').requiredOption('--url <url>')
    .option('--token <token>', 'CLI bearer token (defaults to MINECRAFT_AGENT_CLI_TOKEN)')
    .option('--pair-code <code>', 'pair with a local one-time code before attaching')
    .option('--cursor <cursor>', 'initial event cursor', '0')
    .option('--no-subscribe', 'do not open the event/state subscription automatically')
    .action(options => runAttach(options.url, {}, { token: options.token, pairCode: options.pairCode, subscribe: options.subscribe, cursor: options.cursor }));
  program.command('status').option('--db <path>').action((options, command) => { const db = options.db ?? command.parent?.opts().db ?? process.env.MINECRAFT_AGENT_DB ?? ':memory:'; const runtime = new SessionRuntime(new FakeClientBridge(), new SQLiteStore(db)); try { console.log(JSON.stringify(redact({ simulated: true, status: runtime.store.listGoals().some(g => g.status === 'active') ? 'active' : 'idle', goals: runtime.store.listGoals(), executions: runtime.store.listExecutions() }))); } finally { runtime.store.close(); } });
  program.command('doctor').option('--db <path>').action((options, command) => {
    const profile = command.parent?.opts().profile ?? 'simulated';
    const db = options.db ?? command.parent?.opts().db;
    console.log(JSON.stringify(redact(runDoctorCommand({ profile, ...(db ? { db } : {}) }))));
  });
  program.command('bridge').option('--config <path>', 'profile config').option('--mode <mode>', 'fixture|inspect|service|live', 'fixture').action(async (options) => { const file = resolve(options.config ?? 'configs/client-offline.example.json'); const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; const mode = options.mode as string; if (!['fixture', 'inspect', 'service', 'live'].includes(mode)) throw new Error('invalid-bridge-mode'); if (mode === 'live') { if (config.allowMinecraftUpstream !== true) throw new Error('live-mode-requires-explicit-upstream-gate'); throw new Error('live-mode-requires-real-client-environment'); } const profile=getGameVersionProfile(); if (mode === 'inspect') { console.log(JSON.stringify(redact({ mode, source: 'fixture', network: 'disabled', profile: versionProfileSummary(profile), protocol: { legacyCodecFixture: minecraftDataSummary(), target: profile }, config }))); return; }
    const upstream=net.createServer(socket=>{socket.on('data',chunk=>socket.write(chunk));}); await new Promise<void>((resolve,reject)=>{upstream.once('error',reject);upstream.listen(0,'127.0.0.1',resolve);}); const targetPort=(upstream.address() as import('node:net').AddressInfo).port;
    if (mode === 'service') {
      if (config.allowMinecraftUpstream !== true) throw new Error('service-mode-requires-explicit-upstream-gate');
      try {
        // The service child owns the relay child + observer; the Runtime/CLI only sees IPC.
        const result = await runBridgeServiceCommand({
          relay: { listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort, allowMinecraftUpstream: true, heartbeatMs: 60 },
          observer: { enabled: true }, shutdownGraceMs: 1_000, helloTimeoutMs: 5_000, maxRestarts: 1, backoffBaseMs: 10, maxIpcMessages: 256,
        });
        console.log(JSON.stringify(redact({ ...result, profile: versionProfileSummary(profile), protocol: { legacyCodecFixture: minecraftDataSummary(), target: profile } })));
      } finally { await new Promise<void>(resolve=>upstream.close(()=>resolve())); }
      return;
    }
    const relay=createRawTcpRelay({listenHost:'127.0.0.1',listenPort:0,targetHost:'127.0.0.1',targetPort,allowMinecraftUpstream:true});
    try { await relay.start(); const client=net.createConnection(relay.address.port,'127.0.0.1'); await new Promise<void>((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);}); const payload=Buffer.from('furevercraft-relay-fixture'); const response=new Promise<Buffer>((resolve,reject)=>{const chunks:Buffer[]=[];client.on('data',chunk=>{chunks.push(Buffer.from(chunk));if(Buffer.concat(chunks).length>=payload.length)resolve(Buffer.concat(chunks));});client.once('error',reject);}); client.write(payload); const echoed=await response; client.end(); if(!echoed.equals(payload)) throw new Error('relay-fixture-byte-mismatch'); console.log(JSON.stringify(redact({mode,source:'fixture',network:'loopback-only',profile:versionProfileSummary(profile),protocol:{legacyCodecFixture:minecraftDataSummary(),target:profile},scenario:{transport:'raw-tcp',echoBytes:echoed.length,byteEquality:true,termination:'none'},sessions:relay.sessions().length}))); } finally { await relay.stop(); await new Promise<void>(resolve=>upstream.close(()=>resolve())); }
  });
  program.command('goal:revise').requiredOption('--id <goalId>').requiredOption('--revision <revision>').requiredOption('--change <change>').option('--db <path>').action((options) => { const store = new SQLiteStore(options.db ?? process.env.MINECRAFT_AGENT_DB ?? ':memory:'); try { console.log(JSON.stringify(redact(store.reviseGoal(options.id, Number(options.revision), options.change)))); } finally { store.close(); } });
  program.command('events').option('--cursor <cursor>', 'cursor', '0').option('--limit <limit>', '100').option('--db <path>').action((options) => { const store = new SQLiteStore(options.db ?? process.env.MINECRAFT_AGENT_DB ?? ':memory:'); try { console.log(JSON.stringify(new SessionRuntime(new FakeClientBridge(), store).events.read(options.cursor, Number(options.limit)))); } finally { store.close(); } });
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
      // so read globals as a fallback instead of silently using :memory:.
      const db = options.db ?? (command.optsWithGlobals().db as string | undefined);
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
  program.action(() => runDemo(program.opts().db));
  return program.parseAsync(argv);
}
if (process.argv[1]?.endsWith('main.js')) main();
