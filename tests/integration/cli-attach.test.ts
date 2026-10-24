import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createRuntime } from '../../src/execution/factory.js';
import { createControlServer } from '../../src/server/index.js';
import { runAttach } from '../../src/cli/main.js';
import { ScriptedModelProvider } from '../../src/providers/scripted/index.js';

const openServers: Array<{ close: () => Promise<void> }> = [];
const harnesses: AttachHarness[] = [];

async function listen(server: ReturnType<typeof createControlServer>) {
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('server-address-unavailable');
  const close = async () => { await server.close(); };
  openServers.push({ close });
  return { baseUrl: `http://127.0.0.1:${address.port}`, close };
}

async function waitUntil<T>(probe: () => T | undefined, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error('wait-timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Drives the actual readline loop and records the same JSON lines a user would see. */
class AttachHarness {
  readonly input = new PassThrough();
  readonly output = new PassThrough();
  raw = '';
  private pendingText = '';
  private readonly entries: any[] = [];
  private readonly responses: any[] = [];
  private readonly responseWaiters: Array<(value: any) => void> = [];
  private subscriptionIndex = 0;
  private eventIndex = 0;
  readonly attach: Promise<void>;
  private readonly controller = new AbortController();

  constructor(url: string, token?: string, pairCode?: string) {
    harnesses.push(this);
    this.output.on('data', (chunk: Buffer) => {
      this.raw += chunk.toString();
      this.pendingText += chunk.toString();
      let newline: number;
      while ((newline = this.pendingText.indexOf('\n')) >= 0) {
        const line = this.pendingText.slice(0, newline).trim();
        this.pendingText = this.pendingText.slice(newline + 1);
        if (!line) continue;
        let entry: any;
        try { entry = JSON.parse(line); } catch { entry = { raw: line }; }
        this.entries.push(entry);
        const isSubscription = entry && typeof entry === 'object' && !Array.isArray(entry) && entry.subscription !== undefined;
        const isEvent = entry && typeof entry === 'object' && (entry.event !== undefined || (entry.gap !== undefined && typeof entry.gap === 'object'));
        if (isSubscription || isEvent) continue;
        const waiter = this.responseWaiters.shift();
        if (waiter) waiter(entry); else this.responses.push(entry);
      }
    });
    this.attach = runAttach(url, { input: this.input, output: this.output }, { token, pairCode, subscribe: true, signal: this.controller.signal });
  }

  abort() { this.controller.abort(); this.input.end(); }

  send(line: string) { this.input.write(`${line}\n`); }
  async command(line: string): Promise<any> {
    const response = this.responses.length
      ? Promise.resolve(this.responses.shift())
      : new Promise<any>(resolve => this.responseWaiters.push(resolve));
    this.send(line);
    return Promise.race([
      response,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`response-timeout:${line}`)), 6000)),
    ]);
  }
  async waitSubscription(state: string): Promise<any> {
    return waitUntil(() => {
      for (let index = this.subscriptionIndex; index < this.entries.length; index += 1) {
        if (this.entries[index]?.subscription?.state === state) {
          this.subscriptionIndex = index + 1;
          return this.entries[index].subscription;
        }
      }
      return undefined;
    });
  }
  async waitEvent(kind: string): Promise<any> {
    return waitUntil(() => {
      for (let index = this.eventIndex; index < this.entries.length; index += 1) {
        if (this.entries[index]?.event?.kind === kind) {
          this.eventIndex = index + 1;
          return this.entries[index].event;
        }
      }
      return undefined;
    });
  }
}

async function cleanup() {
  while (harnesses.length) harnesses.pop()!.abort();
  while (openServers.length) await openServers.pop()!.close();
}

describe('P14 attach CLI over the real ControlService', { timeout: 30_000 }, () => {
  it('drives every command through readline against one Runtime and distinguishes quit from shutdown', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    const server = createControlServer(runtime, { pairing: true, pairingCode: 'cli-pair', cliBearer: 'cli-secret', pollMs: 10, heartbeatMs: 60_000 });
    try {
      const { baseUrl } = await listen(server);
      const cli = new AttachHarness(baseUrl, 'cli-secret');
      const open = await cli.waitSubscription('open');
      expect(open).toMatchObject({ state: 'open' });
      // The bearer is a credential: it must never appear in the terminal transcript.
      expect(cli.raw).not.toContain('cli-secret');

      const help = await cli.command('help');
      expect(help.commands).toEqual(expect.arrayContaining(['status', 'goal show [id]', 'goal set <id> <text>', 'shutdown (send quit to the Runtime)']));

      const status = await cli.command('status');
      expect(status).toMatchObject({ state: 'idle', paused: false, stopping: false });
      expect(status.observation).toMatchObject({ source: 'simulated', freshness: 'current' });
      expect(status.session).toMatchObject({ state: 'idle' });

      const set = await cli.command('goal set g1 "Explore the local area"');
      expect(set).toMatchObject({ command: 'goal.set', state: 'terminal' });
      expect(set.result.spec.text).toBe('Explore the local area');
      const shown = await cli.command('goal show g1');
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({ goal_id: 'g1', revision: 1, status: 'active' });

      expect(await cli.command('executions')).toEqual([]);
      expect(await cli.command('effects')).toEqual([]);
      expect(await cli.command('places')).toEqual([]);
      const events = await cli.command('events');
      expect(Array.isArray(events.events)).toBe(true);
      expect(events.events.some((event: { kind: string }) => event.kind === 'control.goal.set')).toBe(true);
      expect(await cli.command('provider')).toMatchObject({ provider: 'scripted' });
      expect(await cli.command('capabilities')).toMatchObject({ profile: 'simulated' });
      expect(await cli.command('config')).toMatchObject({ profile: 'simulated', cliAccess: 'configured' });

      const saved = await cli.command('save');
      expect(saved.state).toBe('terminal');
      expect(runtime.store.getLatestCheckpoint('runtime')?.revision).toBe(1);

      const paused = await cli.command('pause');
      expect(paused.state).toBe('terminal');
      expect(runtime.control.status().paused).toBe(true);
      // The subscription reports the runtime state change, not a locally derived one.
      expect(await cli.waitEvent('runtime.pausing')).toMatchObject({ kind: 'runtime.pausing' });
      expect((await cli.command('resume')).state).toBe('terminal');
      expect(runtime.control.status().paused).toBe(false);

      const recovered = await cli.command('recover');
      expect(recovered.state).toBe('terminal');
      expect(recovered.result.recovered).toBe(true);
      expect(runtime.control.status().session?.state).toBe('running');

      const missing = await cli.command('cancel does-not-exist');
      expect(missing).toMatchObject({ state: 'unknown', code: 'execution-not-found' });

      // Bad arguments are answered with an error line and the service keeps working.
      for (const bad of ['goal set', 'goal revise g1 nope change', 'cancel', 'definitely-not-a-command']) {
        const error = await cli.command(bad);
        expect(error.error).toBeTruthy();
        expect((await cli.command('status')).state).toBeDefined();
      }

      // Explicit detach/reconnect: state changes made while detached are visible after reconnect.
      cli.send('disconnect');
      await cli.waitSubscription('disconnected');
      expect((await cli.command('pause')).state).toBe('terminal');
      cli.send('reconnect');
      await cli.waitSubscription('open');
      expect((await cli.command('stream')).stream.state).toBe('open');
      expect(runtime.control.status().paused).toBe(true);
      expect((await cli.command('resume')).state).toBe('terminal');

      const stopped = await cli.command('stop');
      expect(stopped).toMatchObject({ command: 'stop', state: 'accepted' });
      expect(runtime.control.status().stopping).toBe(true);
      expect((await cli.command('resume')).state).toBe('rejected');

      // `quit` only detaches the CLI; the Runtime keeps running.
      cli.send('quit');
      await cli.attach;
      expect(runtime.control.closedValue).toBe(false);
      expect(cli.raw).not.toContain('cli-secret');

      // A fresh attach can still read the stopped Runtime, then explicitly ask it to shut down.
      const second = new AttachHarness(baseUrl, 'cli-secret');
      await second.waitSubscription('open');
      expect((await second.command('status')).stopping).toBe(true);
      const shutdown = await second.command('shutdown');
      expect(shutdown).toMatchObject({ command: 'quit', state: 'accepted' });
      expect(shutdown.result.closed).toBe(true);
      expect(runtime.control.closedValue).toBe(true);
      second.send('quit');
      await second.attach;
    } finally {
      await cleanup();
      runtime.close();
    }
  });

  it('pairs with a one-time code and then reads through the HttpOnly session', async () => {
    const runtime = createRuntime();
    const server = createControlServer(runtime, { pairing: true, pairingCode: 'pair-me', pollMs: 10, heartbeatMs: 60_000 });
    try {
      const { baseUrl } = await listen(server);
      const cli = new AttachHarness(baseUrl, undefined, 'pair-me');
      await cli.waitSubscription('open');
      // The automatic pairing result is the first non-subscription line.
      expect(await cli.command('')).toMatchObject({ paired: true });
      expect((await cli.command('status')).state).toBe('idle');
      const paused = await cli.command('pause');
      expect(paused.state).toBe('terminal');
      expect(runtime.control.status().paused).toBe(true);
      // Neither the csrf token nor the session cookie is printed.
      expect(cli.raw).not.toMatch(/csrfToken|furevercraft_session/i);
      cli.send('quit');
      await cli.attach;
    } finally {
      await cleanup();
      runtime.close();
    }
  });
});
