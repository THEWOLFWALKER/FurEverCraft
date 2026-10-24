import { afterEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/execution/factory.js';
import { createControlServer, type ControlServerOptions } from '../../src/server/index.js';

type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any };
const openServers: Array<{ close: () => Promise<void>; server: ReturnType<typeof createControlServer> }> = [];
const openStreams: AbortController[] = [];

async function listen(options: ControlServerOptions = {}) {
  const runtime = createRuntime();
  const server = createControlServer(runtime, options);
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('server-address-unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const open = { baseUrl, port: address.port, server, runtime, close: async () => { await server.close(); runtime.close(); } };
  openServers.push({ close: open.close, server });
  return open;
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }), ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text, json: () => JSON.parse(text) });
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function cookieOf(result: HttpResult): string {
  const setCookie = result.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (first ?? '').split(';')[0] ?? '';
}

async function waitUntil<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = probe();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error('wait-timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

type Frame = { event: string; id?: string; data: any };
function parseFrames(buffer: string): Frame[] {
  return buffer.replace(/\r\n/g, '\n').split('\n\n').filter(Boolean).map(frame => {
    let event = 'message'; let id: string | undefined; const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    let parsed: any = data.join('\n');
    try { parsed = JSON.parse(parsed); } catch { /* text */ }
    return { event, id, data: parsed };
  });
}

async function sse(baseUrl: string, path: string, headers: Record<string, string>, until: (frames: Frame[]) => boolean, timeoutMs = 5000) {
  const controller = new AbortController();
  openStreams.push(controller);
  const response = await fetch(`${baseUrl}${path}`, { headers, signal: controller.signal });
  if (!response.ok) { controller.abort(); return { status: response.status, frames: [] as Frame[], controller, body: await response.json().catch(() => ({})) }; }
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  let buffer = ''; const frames: Frame[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (!until(frames)) {
      if (Date.now() > deadline) throw new Error('sse-timeout');
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      frames.length = 0;
      frames.push(...parseFrames(buffer));
    }
  } catch (error) {
    controller.abort();
    if (!(error instanceof Error) || error.message !== 'sse-timeout') throw error;
  }
  return { status: response.status, frames, controller, reader };
}

afterEach(async () => {
  while (openStreams.length) openStreams.pop()!.abort();
  while (openServers.length) {
    const entry = openServers.pop()!;
    await entry.close().catch(() => undefined);
  }
});

describe('P16 local pairing, origin and CSRF', { timeout: 20_000 }, () => {
  it('requires pairing, same-origin writes and a session-bound CSRF token', async () => {
    const { baseUrl, port } = await listen({ pairing: true, pairingCode: 'pair-code-1234', cliBearer: 'cli-secret', pollMs: 10, heartbeatMs: 60_000 });

    expect((await httpGet(port, '/api/v1/status')).status).toBe(401);
    expect((await httpGet(port, '/api/v1/events/stream')).status).toBe(401);
    const unpairedWrite = await httpGet(port, '/api/v1/commands', { origin: baseUrl }, 'POST', JSON.stringify({ requestId: 'u', command: 'pause', payload: {} }));
    expect(unpairedWrite.status).toBe(401);

    const wrongOrigin = await httpGet(port, '/api/v1/pair', { origin: 'http://evil.example' }, 'POST', JSON.stringify({ code: 'pair-code-1234' }));
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.json().error.code).toBe('origin-not-allowed');

    const wrongCode = await httpGet(port, '/api/v1/pair', {}, 'POST', JSON.stringify({ code: 'nope' }));
    expect(wrongCode.status).toBe(401);

    const paired = await httpGet(port, '/api/v1/pair', { origin: baseUrl }, 'POST', JSON.stringify({ code: 'pair-code-1234' }));
    expect(paired.status).toBe(200);
    const cookieHeader = paired.headers['set-cookie'];
    const cookieText = Array.isArray(cookieHeader) ? cookieHeader[0]! : cookieHeader!;
    expect(cookieText.toLowerCase()).toContain('httponly');
    expect(cookieText.toLowerCase()).toContain('samesite=strict');
    const csrf = paired.json().csrfToken as string;
    const cookie = cookieOf(paired);
    expect(paired.body).not.toContain('pair-code-1234');
    expect(cookieText).not.toContain(csrf);

    // A paired session can read, but writes need Origin + CSRF.
    expect((await httpGet(port, '/api/v1/status', { cookie })).status).toBe(200);
    const noCsrf = await httpGet(port, '/api/v1/commands', { cookie, origin: baseUrl }, 'POST', JSON.stringify({ requestId: 'w1', command: 'pause', payload: {} }));
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.json().error.code).toBe('csrf-failed');
    const noOrigin = await httpGet(port, '/api/v1/commands', { cookie, 'x-csrf-token': csrf }, 'POST', JSON.stringify({ requestId: 'w2', command: 'pause', payload: {} }));
    expect(noOrigin.status).toBe(401);
    expect(noOrigin.json().error.code).toBe('origin-required');
    const badOrigin = await httpGet(port, '/api/v1/commands', { cookie, origin: 'http://evil.example', 'x-csrf-token': csrf }, 'POST', JSON.stringify({ requestId: 'w3', command: 'pause', payload: {} }));
    expect(badOrigin.status).toBe(403);
    const ok = await httpGet(port, '/api/v1/commands', { cookie, origin: baseUrl, 'x-csrf-token': csrf }, 'POST', JSON.stringify({ requestId: 'w4', command: 'pause', payload: {} }));
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ requestId: 'w4', command: 'pause', state: 'terminal' });

    const reuse = await httpGet(port, '/api/v1/pair', {}, 'POST', JSON.stringify({ code: 'pair-code-1234' }));
    expect(reuse.status).toBe(409);
    // Neither the one-time code nor the bearer appears in any response body.
    for (const result of [unpairedWrite, wrongOrigin, wrongCode, paired, noCsrf, noOrigin, badOrigin, ok, reuse]) {
      expect(result.body).not.toContain('cli-secret');
      expect(result.body).not.toContain('pair-code-1234');
    }
    expect((await httpGet(port, '/api/v1/config', { cookie })).body).not.toContain('cli-secret');
  });

  it('rejects a foreign Host and never lets an absent Origin bypass token auth', async () => {
    const pairedServer = await listen({ pairing: true, pairingCode: 'custom', cliBearer: 'cli-secret', pollMs: 10, heartbeatMs: 60_000 });
    const noAuth = await httpGet(pairedServer.port, '/api/v1/status');
    expect(noAuth.status).toBe(401);
    expect(noAuth.json().error.code).toBe('pairing-session-required');
    const bearer = await httpGet(pairedServer.port, '/api/v1/status', { authorization: 'Bearer cli-secret' });
    expect(bearer.status).toBe(200);
    const foreignHost = await httpGet(pairedServer.port, '/api/v1/status', { host: 'evil.example', authorization: 'Bearer cli-secret' });
    expect(foreignHost.status).toBe(403);
    expect(foreignHost.json().error.code).toBe('host-not-allowed');
    const foreignOrigin = await httpGet(pairedServer.port, '/api/v1/status', { origin: 'http://evil.example', authorization: 'Bearer cli-secret' });
    expect(foreignOrigin.status).toBe(403);
    const sseNoAuth = await fetch(`${pairedServer.baseUrl}/api/v1/events/stream`);
    expect(sseNoAuth.status).toBe(401);
    const sseAuth = await sse(pairedServer.baseUrl, '/api/v1/events/stream', { authorization: 'Bearer cli-secret' }, frames => frames.some(frame => frame.event === 'snapshot'));
    expect(sseAuth.status).toBe(200);
    expect(sseAuth.frames.some(frame => frame.event === 'snapshot')).toBe(true);
    sseAuth.controller.abort();

    // Token-only mode: no pairing, but a configured bearer closes the legacy open local surface.
    const tokenServer = await listen({ cliBearer: 'token-only' });
    const anonymous = await httpGet(tokenServer.port, '/api/v1/status');
    expect(anonymous.status).toBe(401);
    expect(anonymous.json().error.code).toBe('bearer-required');
    const wrong = await httpGet(tokenServer.port, '/api/v1/status', { authorization: 'Bearer wrong' });
    expect(wrong.status).toBe(401);
    const right = await httpGet(tokenServer.port, '/api/v1/status', { authorization: 'Bearer token-only' });
    expect(right.status).toBe(200);
    const anonymousWrite = await httpGet(tokenServer.port, '/api/v1/commands', {}, 'POST', JSON.stringify({ requestId: 't1', command: 'pause', payload: {} }));
    expect(anonymousWrite.status).toBe(401);
  });

  it('rejects expired pairing codes and expired sessions', async () => {
    let clock = 1_000_000;
    const first = await listen({ pairing: true, pairingCode: 'expires', pairingTtlMs: 1000, sessionTtlMs: 1000, now: () => clock });
    const paired = await httpGet(first.port, '/api/v1/pair', {}, 'POST', JSON.stringify({ code: 'expires' }));
    expect(paired.status).toBe(200);
    const cookie = cookieOf(paired);
    expect((await httpGet(first.port, '/api/v1/status', { cookie })).status).toBe(200);
    clock += 2000;
    const expiredSession = await httpGet(first.port, '/api/v1/status', { cookie });
    expect(expiredSession.status).toBe(401);
    expect(expiredSession.json().error.code).toBe('pairing-session-required');
    const expiredCode = await httpGet(first.port, '/api/v1/pair', {}, 'POST', JSON.stringify({ code: 'expires' }));
    expect(expiredCode.status).toBe(410);
    expect(expiredCode.json().error.code).toBe('pairing-expired');

    let codeClock = 5_000;
    const second = await listen({ pairing: true, pairingCode: 'stale-code', pairingTtlMs: 10, now: () => codeClock });
    codeClock += 20;
    const stale = await httpGet(second.port, '/api/v1/pair', {}, 'POST', JSON.stringify({ code: 'stale-code' }));
    expect(stale.status).toBe(410);
  });
});

describe('P16 static confinement and API fallback', { timeout: 20_000 }, () => {
  it('serves only files under the build directory and never swallows API errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-p16-static-'));
    const webRoot = join(dir, 'web');
    mkdirSync(join(webRoot, 'assets'), { recursive: true });
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>SPA index</title>');
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'globalThis.APP = true;');
    writeFileSync(join(dir, 'secret.txt'), 'TOP-SECRET-OUTSIDE-BUILD');
    try { symlinkSync(join(dir, 'secret.txt'), join(webRoot, 'linked.js')); } catch { /* symlink support is platform dependent */ }
    try {
      const { baseUrl, port } = await listen({ webRoot });
      const traversals = [
        '/%2e%2e%2fsecret.txt',
        '/..%2f..%2fsecret.txt',
        '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
        '/assets/..%2f..%2fsecret.txt',
        '/assets/..%5c..%5csecret.txt',
        '/%2e%2e/%2e%2e/etc/passwd',
        '/linked.js',
      ];
      for (const path of traversals) {
        const result = await httpGet(port, path);
        expect(result.status, path).toBe(404);
        expect(result.body, path).not.toContain('TOP-SECRET');
        expect(result.body, path).not.toContain('root:');
      }
      expect((await httpGet(port, '/assets/missing.js')).status).toBe(404);
      expect((await httpGet(port, '/assets')).status).toBe(404);
      const api = await httpGet(port, '/api');
      expect(api.status).toBe(404);
      expect(api.json()).toEqual({ error: { code: 'not-found' } });
      const unknownApi = await httpGet(port, '/api/v1/does-not-exist');
      expect(unknownApi.status).toBe(404);
      expect(unknownApi.body).not.toContain('SPA index');
      const fallback = await httpGet(port, '/client/route');
      expect(fallback.status).toBe(200);
      expect(fallback.body).toContain('SPA index');
      const asset = await httpGet(port, '/assets/app.js');
      expect(asset.status).toBe(200);
      expect(asset.body).toContain('APP = true');
      expect(asset.headers['content-type']).toContain('text/javascript');
      expect(baseUrl).toContain('127.0.0.1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('P16 SSE cursor consistency and cleanup', { timeout: 20_000 }, () => {
  it('emits snapshot/head watermarks, explicit overflow gaps, and cleans up disconnected streams', async () => {
    const connections: string[] = [];
    const server = await listen({ maxSseEvents: 6, pollMs: 10, heartbeatMs: 60_000, onSseConnection: state => connections.push(state) });
    for (let index = 1; index <= 10; index += 1) server.runtime.session.events.publish('test.event', { index }, true);
    const head = server.runtime.session.events.head();

    const initial = await sse(server.baseUrl, '/api/v1/events/stream?cursor=0', {}, frames => frames.some(frame => frame.event === 'snapshot') && frames.some(frame => frame.event === 'gap'));
    expect(initial.status).toBe(200);
    const firstGap = initial.frames.find(frame => frame.event === 'gap');
    const snapshot = initial.frames.find(frame => frame.event === 'snapshot');
    expect(firstGap?.data).toMatchObject({ gap: true, reason: 'replay-overflow' });
    expect(snapshot?.id).toBe(head);
    expect(snapshot?.data.cursor).toBe(head);
    expect(snapshot?.data.gap).toBe(true);
    initial.controller.abort();
    initial.reader?.cancel().catch(() => undefined);
    await waitUntil(() => (server.server as unknown as { activeSseConnections: number }).activeSseConnections === 0 ? true : undefined);

    // Reconnecting at the snapshot watermark resynchronises without a gap.
    const resumed = await sse(server.baseUrl, `/api/v1/events/stream?cursor=${head}`, {}, frames => frames.some(frame => frame.event === 'snapshot'));
    const resumedSnapshot = resumed.frames.find(frame => frame.event === 'snapshot');
    expect(resumed.frames.some(frame => frame.event === 'gap')).toBe(false);
    expect(resumedSnapshot?.id).toBe(head);

    // Live events continue after the snapshot, with matching cursor ids.
    server.runtime.session.events.publish('test.live', { live: true }, true);
    const live = await sse(server.baseUrl, `/api/v1/events/stream?cursor=${head}`, {}, frames => frames.some(frame => frame.event === 'test.live'));
    const liveEvent = live.frames.find(frame => frame.event === 'test.live');
    expect(liveEvent?.id).toBe(String(Number(head) + 1));
    live.controller.abort();
    live.reader?.cancel().catch(() => undefined);
    resumed.controller.abort();
    resumed.reader?.cancel().catch(() => undefined);

    // A cursor ahead of the server is an explicit gap, never a silent rewind.
    const ahead = await sse(server.baseUrl, '/api/v1/events/stream?cursor=999999', {}, frames => frames.some(frame => frame.event === 'snapshot'));
    expect(ahead.frames.find(frame => frame.event === 'gap')?.data).toMatchObject({ gap: true, reason: 'cursor-ahead' });
    expect(ahead.frames.find(frame => frame.event === 'snapshot')?.data.cursor).toBe(String(Number(head) + 1));
    ahead.controller.abort();
    ahead.reader?.cancel().catch(() => undefined);

    await waitUntil(() => (server.server as unknown as { activeSseConnections: number }).activeSseConnections === 0 ? true : undefined);
    expect(connections.filter(state => state === 'open').length).toBeGreaterThanOrEqual(4);
    expect(connections.filter(state => state === 'closed').length).toBe(connections.filter(state => state === 'open').length);
  });
});

describe('P16 credential handling', () => {
  it('never logs the pairing code, bearer token, CSRF token or session cookie', async () => {
    const logs: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = methods.map(method => vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); }));
    try {
      const { baseUrl, port } = await listen({ pairing: true, pairingCode: 'log-secret-code', cliBearer: 'log-secret-bearer' });
      expect((await httpGet(port, '/api/v1/status', { authorization: 'Bearer wrong' })).status).toBe(401);
      const paired = await httpGet(port, '/api/v1/pair', {}, 'POST', JSON.stringify({ code: 'log-secret-code' }));
      expect(paired.status).toBe(200);
      const csrf = paired.json().csrfToken as string;
      const cookie = cookieOf(paired);
      expect((await httpGet(port, '/api/v1/status', { cookie })).status).toBe(200);
      expect((await httpGet(port, '/api/v1/commands', { cookie, origin: baseUrl, 'x-csrf-token': csrf }, 'POST', JSON.stringify({ requestId: 'log', command: 'pause', payload: {} }))).status).toBe(200);
      const transcript = logs.join('\n');
      for (const secret of ['log-secret-code', 'log-secret-bearer', csrf, cookie, 'wrong']) expect(transcript).not.toContain(secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
