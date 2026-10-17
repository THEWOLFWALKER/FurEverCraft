import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/execution/factory.js';
import { createControlServer } from '../../src/server/index.js';

const openServers: Array<{ close: () => Promise<void> }> = [];

async function listen(server: ReturnType<typeof createControlServer>) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server-address-unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const close = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
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
        const body = await readUntil(reader, text => text.includes('event: runtime.pausing'));
        await reader.cancel();
        streamController.abort();
        expect(body).toContain('event: snapshot');
        // Snapshot watermark precedes every replayed event so resume cannot skip or duplicate ids.
        expect(body.indexOf('event: snapshot')).toBeLessThan(body.indexOf('event: runtime.pausing'));
        const snapshotId = Number(body.match(/id: (\d+)\nevent: snapshot/)![1]);
        const eventId = Number(body.match(/id: (\d+)\nevent: runtime.pausing/)![1]);
        expect(eventId).toBeGreaterThan(snapshotId);
        expect(JSON.parse(body.match(/event: snapshot\ndata: (.+)\n\n/)![1]!)).toMatchObject({ paused: true, cursor: String(snapshotId), gap: false });

        const replayController = new AbortController();
        const replay = await fetch(`${baseUrl}/events`, { headers: { 'last-event-id': String(eventId) }, signal: replayController.signal });
        expect(replay.status).toBe(200);
        const replayReader = replay.body!.getReader();
        const replayBody = await readUntil(replayReader, text => text.includes('event: snapshot'));
        await replayReader.cancel();
        replayController.abort();
        expect(replayBody).toContain('event: snapshot');
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
