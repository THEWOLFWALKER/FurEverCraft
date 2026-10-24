import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/execution/factory.js';
import { createControlServer } from '../../src/server/index.js';

type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any };

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

const cookieOf = (result: HttpResult): string => {
  const setCookie = result.headers['set-cookie'];
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return (first ?? '').split(';')[0] ?? '';
};

const withoutTimestamp = (report: Record<string, unknown>) => {
  const { generatedAt: _generatedAt, ...rest } = report;
  return rest;
};

const openServers: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (openServers.length) await openServers.pop()!.close().catch(() => undefined);
});

describe('P24 authenticated doctor endpoint', { timeout: 20_000 }, () => {
  it('denies unauthenticated access and returns the same truthful P21 report to a CLI bearer and a paired session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-p24-doctor-'));
    const db = join(dir, 'state.sqlite');
    const runtime = createRuntime({ db, modelProvider: 'openai', allowModelNetwork: false, apiKey: 'sk-p24-doctor-secret' });
    const server = createControlServer(runtime, { pairing: true, pairingCode: 'p24-pair-code', cliBearer: 'p24-cli-bearer' });
    const close = async () => { await server.close(); runtime.close(); rmSync(dir, { recursive: true, force: true }); };
    openServers.push({ close });
    try {
      await server.listen({ port: 0, host: '127.0.0.1' });
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('server-address-unavailable');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const port = address.port;

      // Same authorization path as every other read: no session and no bearer is denied.
      const anonymous = await httpGet(port, '/api/v1/doctor');
      expect(anonymous.status).toBe(401);
      expect(anonymous.json().error.code).toBe('pairing-session-required');
      const wrongBearer = await httpGet(port, '/api/v1/doctor', { authorization: 'Bearer wrong' });
      expect(wrongBearer.status).toBe(401);
      // Origin rules apply even when a valid CLI bearer is present.
      const foreignOrigin = await httpGet(port, '/api/v1/doctor', { authorization: 'Bearer p24-cli-bearer', origin: 'http://evil.example' });
      expect(foreignOrigin.status).toBe(403);
      expect(foreignOrigin.json().error.code).toBe('origin-not-allowed');

      // A paired browser session can read the same report.
      const paired = await httpGet(port, '/api/v1/pair', { origin: baseUrl }, 'POST', JSON.stringify({ code: 'p24-pair-code' }));
      expect(paired.status).toBe(200);
      const cookie = cookieOf(paired);
      const csrf = paired.json().csrfToken as string;
      const sessionRead = await httpGet(port, '/api/v1/doctor', { cookie });
      expect(sessionRead.status).toBe(200);

      // A CLI bearer gets the truthful diagnostic report, not a static optimistic answer.
      const bearerRead = await httpGet(port, '/api/v1/doctor', { authorization: 'Bearer p24-cli-bearer' });
      expect(bearerRead.status).toBe(200);
      const report = bearerRead.json();
      expect(report).toMatchObject({
        version: 1,
        status: 'degraded',
        provider: { state: 'unavailable', reason: 'network-gate-disabled', provider: 'openai', configured: false },
        network: { state: 'disabled', reason: 'network-gate-disabled' },
        paidModelApi: { state: 'disabled', reason: 'offline-batch-paid-api-disabled' },
        body: { state: 'available', reason: 'legacy-2d-body', mode: 'legacy-2d', threeDimensional: false },
        recovery: { state: 'disabled', reason: 'session-not-started', sessionState: 'idle' },
        store: { state: 'available', path: db, durable: true, health: 'ok' },
        external: { liveMinecraft: { state: 'disabled', reason: 'live-minecraft-not-connected' } },
      });
      expect(report.warnings).toContain('network:network-gate-disabled');
      // The endpoint returns the P21 report from the same attached Runtime (read-only).
      expect(withoutTimestamp(report)).toEqual(withoutTimestamp(runtime.control.diagnostics() as unknown as Record<string, unknown>));
      expect(withoutTimestamp(sessionRead.json())).toEqual(withoutTimestamp(report));

      // No credential, pairing code, CSRF token or session cookie leaks in the doctor responses.
      // The pairing response itself intentionally returns its CSRF token, so it is excluded from
      // the CSRF/cookie assertions while still being checked for the other secrets.
      for (const result of [anonymous, wrongBearer, foreignOrigin, sessionRead, bearerRead]) {
        expect(result.body).not.toContain('sk-p24-doctor-secret');
        expect(result.body).not.toContain('p24-cli-bearer');
        expect(result.body).not.toContain('p24-pair-code');
        expect(result.body).not.toContain(csrf);
        expect(result.body).not.toContain(cookie);
      }
      expect(paired.body).not.toContain('sk-p24-doctor-secret');
      expect(paired.body).not.toContain('p24-cli-bearer');
      expect(paired.body).not.toContain('p24-pair-code');
    } finally {
      await close();
      openServers.pop();
    }
  });
});
