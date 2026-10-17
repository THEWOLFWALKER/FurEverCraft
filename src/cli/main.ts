import { Command } from 'commander';
import { FakeClientBridge } from '../bridge/fake/index.js';
import { navigate } from '../skills/navigation.js';
import { SQLiteStore } from '../persistence/store.js';
import { SessionRuntime } from '../execution/session.js';
import { redact } from '../diagnostics/redaction.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export async function runDemo(db = process.env.MINECRAFT_AGENT_DB ?? '/tmp/minecraft-agent-phase2-demo.sqlite') {
  const store = new SQLiteStore(db); const bridge = new FakeClientBridge(); const runtime = new SessionRuntime(bridge, store);
  bridge.block(2, 0); bridge.block(2, 1);
  const result = navigate(bridge, { x: 4, y: 2 });
  store.saveGoal({ goalId: 'goal_demo', revision: 2, status: 'completed', text: 'navigate simulated' });
  const first = { simulated: true, executionId: result.executionId, phase: result.status, position: bridge.position, pathLength: result.path.length, evidence: ['fake bridge', 'A* path', 'sqlite goal'] };
  store.close();
  const reopened = new SQLiteStore(db); const recovered = new SessionRuntime(new FakeClientBridge(), reopened).start();
  console.log(JSON.stringify(redact({ ...first, restart: { goal: reopened.getGoal('goal_demo')?.spec, recovered: recovered.recovered } })));
  reopened.close();
}

export function main(argv = process.argv) {
  const program = new Command();
  program.name('minecraft-agent').option('--profile <profile>', 'profile', 'simulated').option('--db <path>', 'SQLite path');
  program.command('demo').option('--db <path>').action((options) => runDemo(options.db));
  program.command('status').action(() => console.log(JSON.stringify({ simulated: true, status: 'idle' })));
  program.command('doctor').action((_, command) => console.log(JSON.stringify({ profile: command.parent?.opts().profile ?? 'simulated', simulated: true, network: 'disabled', credentials: 'not-required-offline', capabilities: { capture_view: 'synthetic-only' } })));
  program.command('bridge').option('--config <path>', 'profile config').action((options) => { const file = resolve(options.config ?? 'configs/client-offline.example.json'); const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; console.log(JSON.stringify(redact({ bridge: 'offline-protocol', config, network: config.allowMinecraftUpstream === true ? 'enabled-by-explicit-config' : 'disabled' }))); });
  program.command('goal:revise').requiredOption('--id <goalId>').requiredOption('--revision <revision>').requiredOption('--change <change>').option('--db <path>').action((options) => { const store = new SQLiteStore(options.db ?? process.env.MINECRAFT_AGENT_DB ?? ':memory:'); try { console.log(JSON.stringify(redact(store.reviseGoal(options.id, Number(options.revision), options.change)))); } finally { store.close(); } });
  program.command('events').option('--cursor <cursor>', 'cursor', '0').option('--limit <limit>', '100').option('--db <path>').action((options) => { const store = new SQLiteStore(options.db ?? process.env.MINECRAFT_AGENT_DB ?? ':memory:'); try { console.log(JSON.stringify(new SessionRuntime(new FakeClientBridge(), store).events.read(options.cursor, Number(options.limit)))); } finally { store.close(); } });
  program.action(() => runDemo(program.opts().db));
  return program.parseAsync(argv);
}
if (process.argv[1]?.endsWith('main.js')) main();
