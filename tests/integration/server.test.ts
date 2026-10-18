import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/execution/factory.js';
import { createControlServer } from '../../src/server/index.js';

const openServers: Array<{ close: () => Promise<void> }> = [];

async function listen(server: ReturnType<typeof createControlServer>) {
  await server.listen({ port: 0, host: '127.0.0.1' });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('server-address-unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const close = () => server.close();
  openServers.push({ close });
  return { baseUrl, close };
}

async function jsonResponse(response: Response) {
  return { status: response.status, body: await response.json() as Record<string, any> };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, predicate: (body: string) => boolean) {
  const decoder = new TextDecoder();
  let body = '';
  while (!predicate(body)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += decoder.decode(chunk.value, { stream: true });
  }
  return body + decoder.decode();
}

afterEach(async () => {
  while (openServers.length) await openServers.pop()!.close();
});

describe('control server offline integration', () => {
  it('serves JSON routes and a JSON 404', async () => {
    const runtime = createRuntime();
    try {
      const server = createControlServer(runtime);
      const { baseUrl, close } = await listen(server);
      try {
        const status = await jsonResponse(await fetch(`${baseUrl}/api/v1/status`));
        expect(status.status).toBe(200);
        expect(status.body).toMatchObject({ state: 'idle', paused: false, stopping: false });

        const missing = await jsonResponse(await fetch(`${baseUrl}/api/v1/no-such-route`));
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ error: { code: 'not-found' } });
      } finally {
        await close();
        const index = openServers.findIndex(item => item.close === close);
        if (index >= 0) openServers.splice(index, 1);
      }
    } finally {
      runtime.close();
    }
  });

  it('validates commands and preserves idempotency and payload conflicts', async () => {
    const runtime = createRuntime();
    try {
      const server = createControlServer(runtime);
      const { baseUrl, close } = await listen(server);
      try {
        const invalid = await jsonResponse(await fetch(`${baseUrl}/api/v1/commands`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'bad', command: 'unknown' }),
        }));
        expect(invalid.status).toBe(400);
        expect(invalid.body).toMatchObject({ state: 'rejected', code: 'invalid-command', requestId: 'bad' });

        const command = { requestId: 'goal-1', command: 'goal.set', payload: { goalId: 'g1', text: 'explore' } };
        const first = await jsonResponse(await fetch(`${baseUrl}/api/v1/commands`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
        }));
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ requestId: 'goal-1', command: 'goal.set', state: 'terminal' });

        const replay = await jsonResponse(await fetch(`${baseUrl}/api/v1/commands`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...command, payload: { text: 'explore', goalId: 'g1' } }),
        }));
        expect(replay.status).toBe(200);
        expect(replay.body).toMatchObject({ state: 'terminal', result: first.body.result });

        const conflict = await jsonResponse(await fetch(`${baseUrl}/api/v1/commands`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...command, payload: { goalId: 'g1', text: 'different' } }),
        }));
        expect(conflict.status).toBe(409);
        expect(conflict.body).toMatchObject({ requestId: 'goal-1', state: 'conflict', code: 'command-payload-conflict' });

        const revisionConflict = await jsonResponse(await fetch(`${baseUrl}/api/v1/commands`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'goal-2', command: 'goal.revise', expectedRevision: 0, payload: { goalId: 'g1', change: 'change' } }),
        }));
        expect(revisionConflict.status).toBe(409);
        expect(revisionConflict.body).toMatchObject({ state: 'conflict', code: 'goal-revision-conflict:1' });
      } finally {
        await close();
        const index = openServers.findIndex(item => item.close === close);
        if (index >= 0) openServers.splice(index, 1);
      }
    } finally {
      runtime.close();
    }
  });

  it('streams a snapshot, durable command event, and honors cursor headers', async () => {
    const runtime = createRuntime();
    try {
      const server = createControlServer(runtime, { maxSseEvents: 8, heartbeatMs: 60_000, pollMs: 10 });
      const { baseUrl, close } = await listen(server);
      try {
        const command = await fetch(`${baseUrl}/api/v1/commands`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'pause-1', command: 'pause', payload: {} }),
        });
        expect(command.status).toBe(200);

        const streamController = new AbortController();
        const stream = await fetch(`${baseUrl}/api/v1/events/stream?cursor=0`, { signal: streamController.signal });
        expect(stream.status).toBe(200);
        expect(stream.headers.get('content-type')).toContain('text/event-stream');
        const reader = stream.body!.getReader();
        // The snapshot is sent at a consistent watermark; new events arrive on the poll.
        const body = await readUntil(reader, text => text.includes('event: snapshot'));
        await reader.cancel();
        streamController.abort();
        expect(body).toContain('event: snapshot');
        const snapshotId = Number(body.match(/id: (\d+)\nevent: snapshot/)![1]);
        const parsedSnapshot = JSON.parse(body.match(/event: snapshot\ndata: (.+)\n\n/)![1]!);
        expect(parsedSnapshot).toMatchObject({ paused: true, gap: false });
        expect(Number(parsedSnapshot.cursor)).toBe(snapshotId);

        const replayController = new AbortController();
        const replay = await fetch(`${baseUrl}/events`, { headers: { 'last-event-id': String(snapshotId) }, signal: replayController.signal });
        expect(replay.status).toBe(200);
        const replayReader = replay.body!.getReader();
        const replayBody = await readUntil(replayReader, text => text.includes('event: snapshot'));
        await replayReader.cancel();
        replayController.abort();
        expect(replayBody).toContain('event: snapshot');
        // Resuming at the snapshot watermark must not replay the already-consumed event.
        expect(replayBody).not.toContain('event: runtime.pausing');
      } finally {
        await close();
        const index = openServers.findIndex(item => item.close === close);
        if (index >= 0) openServers.splice(index, 1);
      }
    } finally {
      runtime.close();
    }
  });

  it('serves the same-origin control UI while keeping unknown API paths closed', async () => {
    const runtime = createRuntime();
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>FurEverCraft Control</title>');
    try {
      const server = createControlServer(runtime, { webRoot: dir, heartbeatMs: 60_000, pollMs: 50 });
      const { baseUrl, close } = await listen(server);
      try {
        const root = await fetch(`${baseUrl}/`);
        expect(root.status).toBe(200);
        expect(await root.text()).toContain('FurEverCraft Control');
        const unknownApi = await fetch(`${baseUrl}/api/v1/unknown`);
        expect(unknownApi.status).toBe(404);
        const missingAsset = await fetch(`${baseUrl}/assets/missing.js`);
        expect(missingAsset.status).toBe(404);
      } finally {
        await close();
        const index = openServers.findIndex(item => item.close === close);
        if (index >= 0) openServers.splice(index, 1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      runtime.close();
    }
  });
});

describe('U02 local pairing and CSRF', () => {
  it('requires a paired HttpOnly session and matching CSRF for browser writes', async () => {
    const runtime = createRuntime();
    try {
      const server = createControlServer(runtime, { pairing: true, pairingCode: 'abcd1234' });
      const { baseUrl, close } = await listen(server);
      try {
        const unpaired = await fetch(`${baseUrl}/api/v1/commands`, {
          method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl }, body: JSON.stringify({ requestId: 'p0', command: 'pause', payload: {} }),
        });
        expect(unpaired.status).toBe(401);

        const badCode = await fetch(`${baseUrl}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'wrong' }) });
        expect(badCode.status).toBe(401);

        const paired = await fetch(`${baseUrl}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'abcd1234' }) });
        expect(paired.status).toBe(200);
        const cookie = paired.headers.get('set-cookie') ?? '';
        expect(cookie.toLowerCase()).toContain('httponly');
        expect(cookie.toLowerCase()).toContain('samesite=strict');
        const csrf = ((await paired.json()) as { csrfToken: string }).csrfToken;
        const sessionCookie = cookie.split(';')[0]!;

        const noCsrf = await fetch(`${baseUrl}/api/v1/commands`, {
          method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl, cookie: sessionCookie }, body: JSON.stringify({ requestId: 'p1', command: 'pause', payload: {} }),
        });
        expect(noCsrf.status).toBe(403);

        const ok = await fetch(`${baseUrl}/api/v1/commands`, {
          method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl, cookie: sessionCookie, 'x-csrf-token': csrf }, body: JSON.stringify({ requestId: 'p2', command: 'resume', payload: {} }),
        });
        expect(ok.status).toBe(200);

        const reuse = await fetch(`${baseUrl}/api/v1/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'abcd1234' }) });
        expect(reuse.status).toBe(409);
      } finally {
        await close();
        const index = openServers.findIndex(item => item.close === close);
        if (index >= 0) openServers.splice(index, 1);
      }
    } finally {
      runtime.close();
    }
  });

  it('allows a CLI bearer write without browser origin', async () => {
    const runtime = createRuntime();
    try {
      const server = createControlServer(runtime, { pairing: true, pairingCode: 'x', cliBearer: 'cli-secret' });
      const { baseUrl, close } = await listen(server);
      try {
        const rejected = await fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'b0', command: 'pause', payload: {} }) });
        expect(rejected.status).toBe(401);
        const accepted = await fetch(`${baseUrl}/api/v1/commands`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer cli-secret' }, body: JSON.stringify({ requestId: 'b1', command: 'pause', payload: {} }) });
        expect(accepted.status).toBe(200);
      } finally {
        await close();
        const index = openServers.findIndex(item => item.close === close);
        if (index >= 0) openServers.splice(index, 1);
      }
    } finally {
      runtime.close();
    }
  });
});
