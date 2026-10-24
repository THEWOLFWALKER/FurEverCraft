#!/usr/bin/env node
/**
 * E2E server harness.
 *
 * Starts the real factory/ControlService/Fastify stack from the compiled `dist` output, with a
 * temporary SQLite database, local pairing, a CLI bearer and the built web app. It is a separate
 * process so the Playwright spec can prove process lifecycle, single ownership and cleanup.
 *
 * The injected model provider is a deterministic offline fixture. Only an explicit browser
 * message ("execute placement") produces a tool call; scheduler wakes and other commands return
 * a text turn. This keeps the browser workflow reproducible without pretending to call a model.
 */
import { createRuntime } from '../../dist/execution/factory.js';
import { createControlServer } from '../../dist/server/index.js';
import { FakeClientBridge } from '../../dist/bridge/fake/index.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const db = arg('--db');
const webRoot = arg('--web-root', 'dist/web');
const pairingCode = arg('--pairing-code', 'e2e-pair-code');
const cliBearer = arg('--cli-bearer', 'e2e-cli-bearer');
const host = arg('--host', '127.0.0.1');
if (!db) {
  console.error(JSON.stringify({ ready: false, error: 'missing-db-argument' }));
  process.exit(2);
}

/** Deterministic fixture model: one placement execution only for the requested user message. */
class E2EProvider {
  constructor() { this.used = false; }
  async complete(messages) {
    const userText = messages
      .filter(message => message.role === 'user')
      .map(message => typeof message.content === 'string' ? message.content : '')
      .join('\n');
    if (!this.used && /execute placement/i.test(userText)) {
      this.used = true;
      return {
        text: '',
        stopReason: 'tool_calls',
        toolCalls: [{
          id: 'e2e-place-call',
          name: 'start_skill',
          arguments: JSON.stringify({ skill: 'place_one', x: 1, y: 0, proposalId: 'e2e-place-proposal' }),
        }],
      };
    }
    return { text: 'done', stopReason: 'end_turn' };
  }
  cancel() { /* fixture provider has no transport to cancel */ }
}

// The first placement is applied by the body but its receipt is ambiguous, so the execution is
// suspended and its effect stays ambiguous. That gives the UI a real non-terminal execution to
// cancel, without upgrading ambiguity to success.
const bridge = new FakeClientBridge(12, { faults: { place: { fault: 'ambiguous', count: 1 } } });
const provider = new E2EProvider();

let runtime;
let server;
let closing = false;

async function shutdown(exitCode = 0) {
  if (closing) return;
  closing = true;
  try { if (server) await server.close(); } catch { /* best effort */ }
  try { if (runtime) runtime.close(); } catch { /* best effort */ }
  process.exit(exitCode);
}

process.once('SIGTERM', () => { void shutdown(0); });
process.once('SIGINT', () => { void shutdown(0); });
process.on('unhandledRejection', error => {
  console.error(JSON.stringify({ ready: false, error: error instanceof Error ? error.message : String(error) }));
  void shutdown(3);
});

try {
  runtime = createRuntime({ profile: 'simulated', db, bridge, provider });
  server = createControlServer(runtime, {
    host,
    pairing: true,
    pairingCode,
    cliBearer,
    webRoot,
    pollMs: 25,
    heartbeatMs: 5_000,
  });
  await server.listen({ port: 0, host });
  runtime.session.start();
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('server-address-unavailable');
  console.log(JSON.stringify({ ready: true, url: `http://${host}:${address.port}`, db, pid: process.pid }));
} catch (error) {
  // Startup failure is explicit and non-zero: the Playwright helper refuses the test run.
  console.error(JSON.stringify({ ready: false, error: error instanceof Error ? error.message : String(error) }));
  try { if (server) await server.close(); } catch { /* best effort */ }
  try { if (runtime) runtime.close(); } catch { /* best effort */ }
  process.exit(2);
}
