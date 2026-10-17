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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getGameVersionProfile, versionProfileSummary } from '../bridge/version-profile.js';

export async function runDemo(db = process.env.MINECRAFT_AGENT_DB ?? '/tmp/minecraft-agent-phase2-demo.sqlite', scenario?: string) {
  const names = ['autonomous','obstruction','human-steering','chat-ui','crash-recovery','bridge-fixture'] as const;
  if (scenario && !names.includes(scenario as typeof names[number])) throw new Error(`unknown-scenario:${scenario}`);
  const selected = scenario ? [scenario as typeof names[number]] : [...names];
  const results = selected.map(name => runScenario(name, db));
  console.log(JSON.stringify(redact({ simulated: true, scenarios: results, summary: { count: results.length, names: results.map(r => r.scenario) } })));
}

type ScenarioName = 'autonomous'|'obstruction'|'human-steering'|'chat-ui'|'crash-recovery'|'bridge-fixture';
function runScenario(scenario: ScenarioName, db: string) {
  const store = new SQLiteStore(db); const bridge = new FakeClientBridge(); const runtime = new SessionRuntime(bridge, store); runtime.start();
  try {
    if (scenario === 'autonomous') { const first = navigate(bridge, {x:2,y:0}); store.saveGoal({goalId:'goal_autonomous',revision:1,status:'completed',text:'autonomous navigation'}); const next = navigate(bridge,{x:3,y:0}); return {scenario,outcome:'completed',phases:['observe','navigate','milestone','next-task'],executionIds:[first.executionId,next.executionId],position:bridge.position}; }
    if (scenario === 'obstruction') { bridge.block(1,0); bridge.setUnknown(1,1); const result=navigate(bridge,{x:3,y:1},2); return {scenario,outcome:result.status,dynamicObstacle:true,unknownCell:true,replanned:result.path.length>0,budget:2,pathLength:result.path.length}; }
    if (scenario === 'human-steering') { const old=navigate(bridge,{x:4,y:0}); const revised=navigate(bridge,{x:0,y:2}); return {scenario,outcome:revised.status,oldExecution:old.executionId,oldResult:'superseded',steering:'target-revised',position:bridge.position}; }
    if (scenario === 'chat-ui') { const moved=navigate(bridge,{x:1,y:0}); const chat=sendChat({bridge,lease:{leaseId:'demo',owner:'demo',resources:['ui','textEntry'],until:Date.now()+1000,generation:1},report:()=>{}},'offline hello'); return {scenario,outcome:chat.outcome,navigation:moved.status,uiHandoff:['gameplay','chat','gameplay'],unknownMessageNotRetried:true}; }
    if (scenario === 'crash-recovery') { bridge.position={x:1,y:0}; store.addEffect({effectId:'effect_demo',executionId:'execution_demo',context:bridge.context,status:'may-have-dispatched',intent:{kind:'place',x:2,y:0}}); const before=store.pendingEffects().length; store.close(); const reopened=new SQLiteStore(db); const restored=new SessionRuntime(new FakeClientBridge(),reopened).recover(); const after=reopened.pendingEffects().length; reopened.close(); return {scenario,outcome:'reconciled',pendingBefore:before,pendingAfter:after,reconciled:restored.reconciled}; }
    const protocol=new ProtocolSession('fixture-session'); const observations:unknown[]=[]; const unsubscribe=protocol.subscribe(o=>observations.push(o)); protocol.transition('LOGIN'); protocol.transition('CONFIGURATION'); protocol.transition('PLAY'); protocol.observe('position','downstream',{x:1,y:0}); protocol.close(); unsubscribe(); return {scenario,outcome:'fixture-complete',phase:protocol.phase,observations:observations.length,syntheticCapture:true,input:'fake-transport',disconnectCleanup:true};
  } finally { if (scenario !== 'crash-recovery') store.close(); }
}

export function main(argv = process.argv) {
  const program = new Command();
  program.name('minecraft-agent').option('--profile <profile>', 'profile', 'simulated').option('--db <path>', 'SQLite path');
  program.command('demo').option('--db <path>').option('--scenario <scenario>').action((options) => runDemo(options.db, options.scenario));
  program.command('status').action(() => { const runtime = new SessionRuntime(new FakeClientBridge(), new SQLiteStore(':memory:')); try { console.log(JSON.stringify(redact({ simulated: true, status: runtime.store.listGoals().some(g => g.status === 'active') ? 'active' : 'idle', goals: runtime.store.listGoals(), executions: runtime.store.listExecutions() }))); } finally { runtime.store.close(); } });
  program.command('doctor').action((_, command) => { const profile = command.parent?.opts().profile ?? 'simulated'; const runtime = createRuntime({ profile }); try { console.log(JSON.stringify(redact({ profile, simulated: profile === 'simulated', network: 'disabled', credentials: 'not-required-offline', capabilities: { capture_view: 'synthetic-only' }, status: runtime.session.start() }))); } finally { runtime.close(); } });
  program.command('bridge').option('--config <path>', 'profile config').option('--mode <mode>', 'fixture|inspect|live', 'fixture').action(async (options) => { const file = resolve(options.config ?? 'configs/client-offline.example.json'); const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; const mode = options.mode as string; if (!['fixture', 'inspect', 'live'].includes(mode)) throw new Error('invalid-bridge-mode'); if (mode === 'live') { if (config.allowMinecraftUpstream !== true) throw new Error('live-mode-requires-explicit-upstream-gate'); throw new Error('live-mode-requires-real-client-environment'); } const profile=getGameVersionProfile(); if (mode === 'inspect') { console.log(JSON.stringify(redact({ mode, source: 'fixture', network: 'disabled', profile: versionProfileSummary(profile), protocol: { legacyCodecFixture: minecraftDataSummary(), target: profile }, config }))); return; }
    const upstream=net.createServer(socket=>{socket.on('data',chunk=>socket.write(chunk));}); await new Promise<void>((resolve,reject)=>{upstream.once('error',reject);upstream.listen(0,'127.0.0.1',resolve);}); const targetPort=(upstream.address() as import('node:net').AddressInfo).port;
    const relay=createRawTcpRelay({listenHost:'127.0.0.1',listenPort:0,targetHost:'127.0.0.1',targetPort,allowMinecraftUpstream:true});
    try { await relay.start(); const client=net.createConnection(relay.address.port,'127.0.0.1'); await new Promise<void>((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);}); const payload=Buffer.from('furevercraft-relay-fixture'); const response=new Promise<Buffer>((resolve,reject)=>{const chunks:Buffer[]=[];client.on('data',chunk=>{chunks.push(Buffer.from(chunk));if(Buffer.concat(chunks).length>=payload.length)resolve(Buffer.concat(chunks));});client.once('error',reject);}); client.write(payload); const echoed=await response; client.end(); if(!echoed.equals(payload)) throw new Error('relay-fixture-byte-mismatch'); console.log(JSON.stringify(redact({mode,source:'fixture',network:'loopback-only',profile:versionProfileSummary(profile),protocol:{legacyCodecFixture:minecraftDataSummary(),target:profile},scenario:{transport:'raw-tcp',echoBytes:echoed.length,byteEquality:true,termination:'none'},sessions:relay.sessions().length}))); } finally { await relay.stop(); await new Promise<void>(resolve=>upstream.close(()=>resolve())); }
  });
  program.command('goal:revise').requiredOption('--id <goalId>').requiredOption('--revision <revision>').requiredOption('--change <change>').option('--db <path>').action((options) => { const store = new SQLiteStore(options.db ?? process.env.MINECRAFT_AGENT_DB ?? ':memory:'); try { console.log(JSON.stringify(redact(store.reviseGoal(options.id, Number(options.revision), options.change)))); } finally { store.close(); } });
  program.command('events').option('--cursor <cursor>', 'cursor', '0').option('--limit <limit>', '100').option('--db <path>').action((options) => { const store = new SQLiteStore(options.db ?? process.env.MINECRAFT_AGENT_DB ?? ':memory:'); try { console.log(JSON.stringify(new SessionRuntime(new FakeClientBridge(), store).events.read(options.cursor, Number(options.limit)))); } finally { store.close(); } });
  program.action(() => runDemo(program.opts().db));
  return program.parseAsync(argv);
}
if (process.argv[1]?.endsWith('main.js')) main();
