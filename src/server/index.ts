import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { RuntimeAssembly } from '../execution/factory.js';
import type { ControlService } from '../control/service.js';
import { CommandRequestSchema } from '../control/dto.js';
import { redact } from '../diagnostics/redaction.js';

export type ControlServerOptions = {
  host?: string;
  heartbeatMs?: number;
  pollMs?: number;
  maxSseEvents?: number;
  maxSseBytes?: number;
  maxBodyBytes?: number;
  allowedOrigin?: string;
  webRoot?: string;
  /** Enables local pairing. When set, browser writes require a paired HttpOnly session. */
  pairing?: boolean;
  /** Fixture/test transport for pairing codes; production prints the code to the terminal. */
  pairingCode?: string;
  cliBearer?: string;
};

type PairingState = { codeHash: string; expiresAt: number; used: boolean; sessions: Map<string, { expiresAt: number; csrf: string }> };

const hash = (value: string) => createHash('sha256').update(value).digest();
const safeEqual = (a: string, b: string) => { const left = hash(a); const right = hash(b); return timingSafeEqual(left, right); };

export function createControlServer(runtimeOrControl: RuntimeAssembly | ControlService, options: ControlServerOptions = {}): FastifyInstance {
  const runtime = 'control' in runtimeOrControl && 'store' in runtimeOrControl ? runtimeOrControl as RuntimeAssembly : undefined;
  const control = runtime?.control ?? runtimeOrControl as ControlService;
  const app = Fastify({ logger: false, bodyLimit: options.maxBodyBytes ?? 1024 * 1024, exposeHeadRoutes: false });
  void app.register(fastifyCookie);
  const host = options.host ?? '127.0.0.1';
  const pairing: PairingState | undefined = options.pairing ? {
    codeHash: hash(options.pairingCode ?? randomBytes(4).toString('hex')).toString('hex'),
    expiresAt: Date.now() + 5 * 60_000,
    used: false,
    sessions: new Map(),
  } : undefined;

  const isLoopback = (request: FastifyRequest) => {
    const source = request.ip;
    return source === '127.0.0.1' || source === '::1' || source === '::ffff:127.0.0.1';
  };
  const originOk = (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (!origin) return true;
    const expected = `http://${request.headers.host ?? 'localhost'}`;
    if (origin !== expected && origin !== options.allowedOrigin) { void reply.code(403).send({ error: { code: 'origin-not-allowed' } }); return false; }
    return true;
  };
  const sessionOf = (request: FastifyRequest) => {
    const cookie = request.cookies[SESSION_COOKIE];
    if (!pairing || !cookie) return undefined;
    const entry = pairing.sessions.get(cookie);
    return entry && entry.expiresAt > Date.now() ? entry : undefined;
  };
  const hasSession = (request: FastifyRequest) => Boolean(sessionOf(request));
  const authorizeWrite = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!isLoopback(request)) { void reply.code(403).send({ error: { code: 'non-loopback-denied' } }); return false; }
    if (!originOk(request, reply)) return false;
    const auth = request.headers.authorization;
    if (auth && options.cliBearer && safeEqual(auth.replace(/^Bearer /, ''), options.cliBearer)) return true;
    if (!pairing) return true;
    const origin = request.headers.origin;
    if (!origin) { void reply.code(401).send({ error: { code: 'pairing-session-required' } }); return false; }
    const session = sessionOf(request);
    if (!session) { void reply.code(401).send({ error: { code: 'pairing-session-required' } }); return false; }
    const csrf = request.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !safeEqual(csrf, session.csrf)) { void reply.code(403).send({ error: { code: 'csrf-failed' } }); return false; }
    return true;
  };

  app.get('/api/v1/status', async () => control.status());
  app.get('/api/v1/capabilities', async () => control.capabilities());
  app.get('/api/v1/goals', async () => control.goals());
  app.get('/api/v1/tasks', async () => control.goals());
  app.get('/api/v1/executions', async () => control.executions());
  app.get('/api/v1/effects', async request => control.effects((request.query as { executionId?: string }).executionId));
  app.get('/api/v1/places', async () => control.places());
  app.get('/api/v1/memories', async () => ({ places: control.places(), episodes: runtime?.store.listEpisodes() ?? [] }));
  app.get('/api/v1/provider', async () => control.provider());
  app.get('/api/v1/config', async () => redact({ provider: control.provider(), profile: control.capabilities().profile }));
  app.get('/api/v1/events', async (request, reply) => {
    const query = request.query as { cursor?: string; limit?: string; filter?: string };
    try { return control.events(query.cursor ?? '0', Number(query.limit ?? 100), query.filter); }
    catch { return reply.code(400).send({ error: { code: 'invalid-event-cursor' } }); }
  });

  app.post('/api/v1/pair', async (request, reply) => {
    if (!pairing) return reply.code(404).send({ error: { code: 'pairing-disabled' } });
    if (!isLoopback(request)) return reply.code(403).send({ error: { code: 'non-loopback-denied' } });
    const now = Date.now();
    if (pairing.used) return reply.code(409).send({ error: { code: 'pairing-used' } });
    const body = (request.body ?? {}) as { code?: string };
    if (typeof body.code !== 'string' || createHash('sha256').update(body.code).digest('hex') !== pairing.codeHash) return reply.code(401).send({ error: { code: 'pairing-code-invalid' } });
    if (now > pairing.expiresAt) return reply.code(410).send({ error: { code: 'pairing-expired' } });
    pairing.used = true;
    const session = randomBytes(32).toString('hex');
    const csrf = randomBytes(24).toString('hex');
    pairing.sessions.set(session, { expiresAt: now + 12 * 3600_000, csrf });
    void reply.setCookie(SESSION_COOKIE, session, { httpOnly: true, sameSite: 'strict', path: '/', secure: false });
    return { paired: true, csrfToken: csrf };
  });

  app.post('/api/v1/commands', async (request, reply) => {
    if (!authorizeWrite(request, reply)) return reply;
    const parsed = CommandRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const requestId = typeof (request.body as { requestId?: unknown })?.requestId === 'string' ? (request.body as { requestId: string }).requestId : 'invalid';
      return reply.code(400).send({ requestId, command: 'invalid', state: 'rejected', code: 'invalid-command' });
    }
    const result = await control.command(parsed.data);
    if (result.state === 'conflict') return reply.code(409).send(result);
    if (result.state === 'rejected') return reply.code(400).send(result);
    return result;
  });

  app.get('/api/v1/events/stream', streamHandler);
  app.get('/events', streamHandler);
  async function streamHandler(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers['last-event-id'];
    const query = request.query as { cursor?: string };
    const cursor = Array.isArray(header) ? header[0] : header ?? query.cursor ?? '0';
    if (!cursor || !/^\d+$/.test(String(cursor))) return reply.code(400).send({ error: { code: 'invalid-event-cursor' } });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    let position = String(cursor); let closed = false; let sent = 0; let bytes = 0;
    const maxEvents = options.maxSseEvents ?? 256; const maxBytes = options.maxSseBytes ?? 1024 * 1024;
    const finish = () => { if (closed) return; closed = true; clearInterval(poll); clearInterval(heartbeat); raw.end(); };
    const emit = (event: string, payload: unknown, id?: string) => {
      if (closed) return false;
      const data = JSON.stringify(redact(payload));
      const frame = `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${data}\n\n`;
      const size = Buffer.byteLength(frame);
      if (sent >= maxEvents || bytes + size > maxBytes) { finish(); return false; }
      raw.write(frame); sent += 1; bytes += size; return true;
    };
    const initial = control.events(position, maxEvents);
    const watermark = initial.events.length ? initial.next : position;
    if (initial.gap) emit('gap', { gap: true, availableFrom: initial.availableFrom, cursor: initial.scannedCursor }, initial.scannedCursor);
    emit('snapshot', { ...control.status(), capabilities: control.capabilities(), goals: control.goals(), executions: control.executions(), effects: control.effects(), places: control.places(), provider: control.provider(), cursor: watermark, gap: initial.gap }, watermark);
    position = watermark;
    const poll = setInterval(() => {
      if (closed) return;
      try {
        const read = control.events(position, Math.min(256, maxEvents - sent));
        if (read.gap) { emit('gap', { gap: true, availableFrom: read.availableFrom, cursor: read.scannedCursor }, read.scannedCursor); emit('snapshot', { ...control.status(), cursor: read.scannedCursor, gap: true }, read.scannedCursor); position = read.scannedCursor; return; }
        for (const event of read.events) { if (!emit(event.kind, event.payload, event.seq)) return; position = event.seq; }
      } catch { finish(); }
    }, options.pollMs ?? 250);
    const heartbeat = setInterval(() => { if (closed || raw.writableNeedDrain) return; raw.write(': heartbeat\n\n'); }, options.heartbeatMs ?? 15_000);
    if (closed) { clearInterval(poll); clearInterval(heartbeat); }
    request.raw.on('close', finish);
  }

  // Serve real files under /assets (and other static extensions); SPA fallback only for
  // extensionless paths so a missing script is a 404, not an HTML body served as JS.
  const serveStatic = (request: FastifyRequest, reply: FastifyReply) => {
    const root = options.webRoot ?? './dist/web';
    const path = (request.url ?? '/').split('?')[0]!;
    const safe = path.replace(/\.\./g, '');
    const candidate = `${root}${safe === '/' ? '/index.html' : safe}`;
    if (existsSync(candidate) && !candidate.endsWith('/')) return reply.type(contentType(candidate)).send(readFileSync(candidate));
    const extension = /\.[a-z0-9]+$/i.test(path);
    if (extension && path !== '/') return reply.code(404).send({ error: { code: 'not-found' } });
    const index = `${root}/index.html`;
    if (existsSync(index)) return reply.type('text/html; charset=utf-8').send(readFileSync(index));
    return reply.code(404).send({ error: { code: 'not-found' } });
  };
  app.get('/assets/*', serveStatic);
  app.get('/', serveStatic);
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(request.url.split('?')[0]!)) return serveStatic(request, reply);
    return reply.code(404).send({ error: { code: 'not-found' } });
  });
  return app;
}

const SESSION_COOKIE = 'furevercraft_session';
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function contentType(path: string) { const ext = path.slice(path.lastIndexOf('.')).toLowerCase(); return contentTypes[ext] ?? 'application/octet-stream'; }

export default createControlServer;
