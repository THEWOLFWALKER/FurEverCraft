import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
  /** Extra Host header names accepted for same-origin checks. Loopback names are always accepted. */
  allowedHosts?: string[];
  webRoot?: string;
  /** Enables local pairing. When set, browser reads and writes require a paired HttpOnly session. */
  pairing?: boolean;
  /** Fixture/test transport for pairing codes; production prints the code to the terminal. */
  pairingCode?: string;
  cliBearer?: string;
  /** Pairing code lifetime (default 5 minutes). */
  pairingTtlMs?: number;
  /** Paired browser session lifetime (default 12 hours). */
  sessionTtlMs?: number;
  /** Injectable clock for credential-expiry tests. */
  now?: () => number;
  /** Observes SSE connection lifecycle; used by tests to prove disconnect cleanup. */
  onSseConnection?: (state: 'open' | 'closed') => void;
};

type PairingState = { codeHash: string; expiresAt: number; used: boolean; sessions: Map<string, { expiresAt: number; csrfHash: string }> };

const SESSION_COOKIE = 'furevercraft_session';
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];
const hash = (value: string) => createHash('sha256').update(value).digest();
const safeEqual = (a: string, b: string) => { const left = hash(a); const right = hash(b); return timingSafeEqual(left, right); };
const safeEqualHashes = (left: Buffer, right: string) => timingSafeEqual(left, Buffer.from(right, 'hex'));

/** Extract a hostname from a Host header without trusting user-supplied port text. */
function hostnameOf(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const value = header.trim().toLowerCase();
  if (!value) return undefined;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(0, end + 1) : undefined;
  }
  return value.split(':', 1)[0];
}

function samePath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Reject encoded path-traversal attempts outright instead of normalizing them into a fallback. */
function isUnsafeStaticPath(urlPath: string): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return true; }
  if (decoded.includes('\0') || decoded.includes('\\')) return true;
  return decoded.split('/').some(segment => segment === '..');
}

/** Resolve a URL path under a static root; encoded traversal never escapes the root. */
function candidateFor(root: string, urlPath: string): string | undefined {
  if (isUnsafeStaticPath(urlPath)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return undefined; }
  if (!decoded.startsWith('/')) return undefined;
  // Normalize POSIX-style; request URLs always use forward slashes. Clamp traversal at the root.
  const normalized = decoded.split('/').reduce<string[]>((segments, segment) => {
    if (segment === '' || segment === '.') return segments;
    if (segment === '..') { segments.pop(); return segments; }
    segments.push(segment);
    return segments;
  }, []).join('/');
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, normalized);
  if (!samePath(resolvedRoot, candidate)) return undefined;
  // Symlinks are resolved before the confinement check so a link inside the build directory
  // cannot point at an arbitrary file outside it.
  try {
    const realRoot = realpathSync(resolvedRoot);
    if (existsSync(candidate)) {
      const realCandidate = realpathSync(candidate);
      if (!samePath(realRoot, realCandidate)) return undefined;
    }
  } catch { return undefined; }
  return candidate;
}

const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function contentType(path: string) { const dot = path.lastIndexOf('.'); const ext = (dot >= 0 ? path.slice(dot) : '').toLowerCase(); return contentTypes[ext] ?? 'application/octet-stream'; }

export function createControlServer(runtimeOrControl: RuntimeAssembly | ControlService, options: ControlServerOptions = {}): FastifyInstance {
  const runtime = 'control' in runtimeOrControl && 'store' in runtimeOrControl ? runtimeOrControl as RuntimeAssembly : undefined;
  const control = runtime?.control ?? runtimeOrControl as ControlService;
  const app = Fastify({ logger: false, bodyLimit: options.maxBodyBytes ?? 1024 * 1024, exposeHeadRoutes: false });
  void app.register(fastifyCookie);
  const now = options.now ?? (() => Date.now());
  const pairing: PairingState | undefined = options.pairing ? {
    codeHash: hash(options.pairingCode ?? randomBytes(4).toString('hex')).toString('hex'),
    expiresAt: now() + (options.pairingTtlMs ?? 5 * 60_000),
    used: false,
    sessions: new Map(),
  } : undefined;
  const sessionTtlMs = options.sessionTtlMs ?? 12 * 3600_000;
  const loopbackHosts = new Set([...LOOPBACK_HOSTS, ...(options.host ?? '127.0.0.1').toLowerCase()]);
  if (options.allowedOrigin) {
    try { const parsed = new URL(options.allowedOrigin); loopbackHosts.add(parsed.hostname.toLowerCase()); } catch { /* invalid origin is rejected by originOk */ }
  }
  for (const host of options.allowedHosts ?? []) loopbackHosts.add(host.toLowerCase());

  // Exposed for tests and diagnostics; no credential material is ever attached.
  const serverState = { activeSseConnections: 0 };
  Object.defineProperty(app, 'activeSseConnections', { get: () => serverState.activeSseConnections, enumerable: true });

  const isLoopback = (request: FastifyRequest) => {
    // Decide from the TCP peer, never from client-settable forwarding headers. request.ip can be
    // rewritten by a future trustProxy setting, so the raw socket address is the authority.
    const source = request.socket.remoteAddress;
    return source === '127.0.0.1' || source === '::1' || source === '::ffff:127.0.0.1';
  };
  const hasBearer = (request: FastifyRequest) => {
    const auth = request.headers.authorization;
    return Boolean(auth && options.cliBearer && safeEqual(auth.replace(/^Bearer /, ''), options.cliBearer));
  };
  const hostOk = (request: FastifyRequest) => {
    const hostname = hostnameOf(request.headers.host);
    return Boolean(hostname && loopbackHosts.has(hostname));
  };
  const originOk = (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    if (!origin || origin === 'null') { void reply.code(403).send({ error: { code: 'origin-not-allowed' } }); return false; }
    const host = request.headers.host ?? '';
    const expected = [`http://${host}`, `https://${host}`];
    if (!expected.includes(origin) && origin !== options.allowedOrigin) { void reply.code(403).send({ error: { code: 'origin-not-allowed' } }); return false; }
    return true;
  };
  const sweepSessions = () => {
    if (!pairing) return;
    const at = now();
    for (const [id, entry] of pairing.sessions) if (entry.expiresAt <= at) pairing.sessions.delete(id);
  };
  const sessionOf = (request: FastifyRequest) => {
    const cookie = request.cookies[SESSION_COOKIE];
    if (!pairing || !cookie) return undefined;
    sweepSessions();
    return pairing.sessions.get(cookie);
  };
  /**
   * Local HTTP surface policy:
   * - loopback TCP peer + loopback Host only (DNS-rebinding and cross-site proxies stay out);
   * - a supplied Origin must be the same origin (or an explicit development origin);
   * - a valid CLI bearer is always accepted, including requests without Origin;
   * - pairing, when enabled, requires a live HttpOnly session for every API read and write;
   * - a configured CLI bearer without pairing is token mode: no request, Origin or not, is open.
   */
  const authorizeRequest = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!isLoopback(request)) { void reply.code(403).send({ error: { code: 'non-loopback-denied' } }); return false; }
    if (!hostOk(request)) { void reply.code(403).send({ error: { code: 'host-not-allowed' } }); return false; }
    if (!originOk(request, reply)) return false;
    if (hasBearer(request)) return true;
    if (pairing) {
      if (!sessionOf(request)) { void reply.code(401).send({ error: { code: 'pairing-session-required' } }); return false; }
      return true;
    }
    // Token mode must not be bypassed by omitting Origin: a CLI/browser request without the
    // bearer is rejected instead of falling through to the legacy open local surface.
    if (options.cliBearer) { void reply.code(401).send({ error: { code: 'bearer-required' } }); return false; }
    return true;
  };
  const authorizeWrite = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!authorizeRequest(request, reply)) return false;
    if (hasBearer(request)) return true;
    if (!pairing) return true;
    // Browser writes additionally require a same-origin Origin header and a CSRF token bound to
    // the session. Non-browser callers that omit Origin must use the CLI bearer instead.
    if (!request.headers.origin) { void reply.code(401).send({ error: { code: 'origin-required' } }); return false; }
    const session = sessionOf(request);
    if (!session) { void reply.code(401).send({ error: { code: 'pairing-session-required' } }); return false; }
    const csrf = request.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !safeEqualHashes(Buffer.from(session.csrfHash, 'hex'), hash(csrf).toString('hex'))) {
      void reply.code(403).send({ error: { code: 'csrf-failed' } }); return false;
    }
    return true;
  };

  app.get('/api/v1/status', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return control.status(); });
  app.get('/api/v1/capabilities', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return control.capabilities(); });
  app.get('/api/v1/goals', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return control.goals(); });
  app.get('/api/v1/tasks', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return control.goals(); });
  app.get('/api/v1/executions', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return control.executions(); });
  app.get('/api/v1/effects', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return control.effects((request.query as { executionId?: string }).executionId); });
  app.get('/api/v1/places', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return control.places(); });
  app.get('/api/v1/memories', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return { places: control.places(), episodes: runtime?.store.listEpisodes() ?? [] }; });
  app.get('/api/v1/provider', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return control.provider(); });
  app.get('/api/v1/config', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return redact({ provider: control.provider(), profile: control.capabilities().profile, pairing: Boolean(pairing), cliAccess: options.cliBearer ? 'configured' : 'not-configured' }); });
  app.get('/api/v1/events', async (request, reply) => {
    if (!authorizeRequest(request, reply)) return reply;
    const query = request.query as { cursor?: string; limit?: string; filter?: string };
    try { return control.events(query.cursor ?? '0', Number(query.limit ?? 100), query.filter); }
    catch { return reply.code(400).send({ error: { code: 'invalid-event-cursor' } }); }
  });

  app.post('/api/v1/pair', async (request, reply) => {
    if (!pairing) return reply.code(404).send({ error: { code: 'pairing-disabled' } });
    if (!isLoopback(request)) return reply.code(403).send({ error: { code: 'non-loopback-denied' } });
    if (!hostOk(request)) return reply.code(403).send({ error: { code: 'host-not-allowed' } });
    if (!originOk(request, reply)) return reply;
    if (now() > pairing.expiresAt) return reply.code(410).send({ error: { code: 'pairing-expired' } });
    if (pairing.used) return reply.code(409).send({ error: { code: 'pairing-used' } });
    const body = (request.body ?? {}) as { code?: string };
    if (typeof body.code !== 'string' || !safeEqualHashes(Buffer.from(pairing.codeHash, 'hex'), hash(body.code).toString('hex'))) return reply.code(401).send({ error: { code: 'pairing-code-invalid' } });
    pairing.used = true;
    const session = randomBytes(32).toString('hex');
    const csrf = randomBytes(24).toString('hex');
    pairing.sessions.set(session, { expiresAt: now() + sessionTtlMs, csrfHash: hash(csrf).toString('hex') });
    void reply.setCookie(SESSION_COOKIE, session, { httpOnly: true, sameSite: 'strict', path: '/' });
    return { paired: true, csrfToken: csrf, expiresInMs: sessionTtlMs };
  });

  app.post('/api/v1/commands', async (request, reply) => {
    if (!authorizeWrite(request, reply)) return reply;
    const parsed = CommandRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      const requestId = typeof (request.body as { requestId?: unknown })?.requestId === 'string' ? (request.body as { requestId: string }).requestId : 'invalid';
      return reply.code(400).send({ requestId, command: 'invalid', state: 'rejected', code: 'invalid-command' });
    }
    try {
      const result = await control.command(parsed.data);
      if (result.state === 'conflict') return reply.code(409).send(result);
      if (result.state === 'rejected') return reply.code(400).send(result);
      return result;
    } catch (error) {
      // A bad payload must not take down the control plane or leak internals.
      return reply.code(400).send({ requestId: parsed.data.requestId, command: parsed.data.command, state: 'rejected', code: redact(error instanceof Error ? error.message : String(error)) });
    }
  });

  app.get('/api/v1/events/stream', streamHandler);
  app.get('/events', streamHandler);
  const closeSseConnections = new Set<() => void>();
  function streamHandler(request: FastifyRequest, reply: FastifyReply) {
    if (!authorizeRequest(request, reply)) return reply;
    const header = request.headers['last-event-id'];
    const query = request.query as { cursor?: string };
    const requestedFrame = Array.isArray(header) ? header[0] : header ?? query.cursor ?? '0';
    const cursorText = String(requestedFrame);
    if (!/^\d+$/.test(cursorText)) return reply.code(400).send({ error: { code: 'invalid-event-cursor' } });
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    let position = cursorText; let closed = false; let sent = 0; let bytes = 0;
    const maxEvents = Math.max(4, options.maxSseEvents ?? 256); const maxBytes = Math.max(4096, options.maxSseBytes ?? 1024 * 1024);
    serverState.activeSseConnections += 1;
    options.onSseConnection?.('open');
    let poll: ReturnType<typeof setInterval> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      if (poll) clearInterval(poll);
      if (heartbeat) clearInterval(heartbeat);
      closeSseConnections.delete(finish);
      serverState.activeSseConnections = Math.max(0, serverState.activeSseConnections - 1);
      options.onSseConnection?.('closed');
      try { raw.end(); } catch { /* peer already gone */ }
    };
    closeSseConnections.add(finish);
    const frameOf = (event: string, payload: unknown, id?: string) => `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(redact(payload))}\n\n`;
    const emit = (event: string, payload: unknown, id?: string): boolean => {
      if (closed) return false;
      const frame = frameOf(event, payload, id);
      const size = Buffer.byteLength(frame);
      if (sent >= maxEvents || bytes + size > maxBytes) return false;
      raw.write(frame); sent += 1; bytes += size; return true;
    };
    const head = () => control.eventsHead();
    const snapshot = (cursor: string, gap: boolean, windowed: boolean) => {
      try {
        return { ...control.status(), capabilities: control.capabilities(), goals: control.goals(), executions: control.executions(), effects: control.effects(), places: control.places(), provider: control.provider(), cursor, gap, ...(windowed ? { windowed: true } : {}) };
      } catch (error) {
        // A closed store during shutdown must end as an explicit gap/unknown snapshot, not a
        // half-written SSE session.
        return { state: 'closed', paused: true, stopping: true, cursor, gap: true, error: redact(error instanceof Error ? error.message : String(error)), goals: [], executions: [], effects: [], places: [] };
      }
    };
    const overflow = (reason: string) => {
      // Reserve a final frame even when the event budget is exhausted, so a truncation is
      // explicit instead of looking like a clean end-of-stream. The client reconnects at head.
      try {
        raw.write(frameOf('gap', { gap: true, reason, cursor: position, head: head(), availableFrom: availableFrom }, head()));
      } catch { /* ignore */ }
      finish();
    };
    let availableFrom: string;
    try { availableFrom = String(control.events('0', 1).availableFrom); } catch { availableFrom = '0'; }
    const requested = Number(cursorText);
    const headValue = Number(head());
    let initialGap: string | undefined;
    if (requested > headValue) initialGap = 'cursor-ahead';
    else if (requested + 1 < Number(availableFrom)) initialGap = 'cursor-expired';
    if (initialGap) {
      emit('gap', { gap: true, reason: initialGap, cursor: cursorText, head: String(headValue), availableFrom }, String(headValue));
      position = String(headValue);
    }
    const snapshotCursor = String(headValue);
    // Decide up front whether the unseen backlog fits this connection's budget. An overflow is
    // announced before the snapshot so the snapshot can carry gap=true and the client knows the
    // full state is authoritative rather than a partial replay.
    const backlog = Math.max(0, Number(snapshotCursor) - Number(position));
    const replayBudget = maxEvents - sent;
    const replayOverflow = backlog > 0 && (backlog > replayBudget || backlog > 10000);
    if (replayOverflow) {
      emit('gap', { gap: true, reason: 'replay-overflow', cursor: position, head: snapshotCursor, availableFrom }, snapshotCursor);
      position = snapshotCursor;
    }
    if (!emit('snapshot', snapshot(snapshotCursor, Boolean(initialGap) || replayOverflow, false), snapshotCursor)) { overflow('stream-budget'); return reply; }
    // Replay durable events the client has not seen. If an event cannot fit, close with an
    // explicit gap; the snapshot cursor is the reconnect point.
    if (!replayOverflow && backlog > 0) {
      const read = control.events(position, backlog);
      for (const event of read.events) {
        if (!emit(event.kind, event.payload, event.seq)) { overflow('stream-budget'); return reply; }
        position = event.seq;
      }
      if (Number(position) < Number(snapshotCursor)) {
        emit('gap', { gap: true, reason: 'replay-incomplete', cursor: position, head: snapshotCursor, availableFrom }, snapshotCursor);
        position = snapshotCursor;
      }
    }
    poll = setInterval(() => {
      if (closed) return;
      try {
        const read = control.events(position, Math.max(1, Math.min(256, maxEvents - sent)));
        if (read.gap) {
          // A retained-window gap: announce it, then resend the complete snapshot at the new
          // cursor so the subscriber never resumes from a partial status document.
          emit('gap', { gap: true, reason: 'retention-gap', availableFrom: read.availableFrom, cursor: read.scannedCursor }, read.scannedCursor);
          const nextHead = head();
          if (!emit('snapshot', snapshot(nextHead, true, false), nextHead)) { overflow('stream-budget'); return; }
          position = nextHead;
          return;
        }
        for (const event of read.events) {
          if (!emit(event.kind, event.payload, event.seq)) { overflow('stream-budget'); return; }
          position = event.seq;
        }
      } catch { finish(); }
    }, options.pollMs ?? 250);
    heartbeat = setInterval(() => { if (closed || raw.writableNeedDrain) return; try { raw.write(': heartbeat\n\n'); } catch { finish(); } }, options.heartbeatMs ?? 15_000);
    poll.unref?.(); heartbeat.unref?.();
    request.raw.on('close', finish);
    request.raw.on('error', finish);
    raw.on('close', finish);
    raw.on('error', finish);
    if (closed) { clearInterval(poll); clearInterval(heartbeat); }
    return reply;
  }

  // Serve real files under /assets (and the SPA entry); SPA fallback only for extensionless
  // paths so a missing script is a 404, not an HTML body served as JS.
  const serveFile = (request: FastifyRequest, reply: FastifyReply, allowSpaFallback: boolean) => {
    const root = options.webRoot ?? './dist/web';
    const path = (request.url ?? '/').split('?')[0]!;
    if (isUnsafeStaticPath(path)) return reply.code(404).send({ error: { code: 'not-found' } });
    const candidate = candidateFor(root, path === '/' ? '/index.html' : path);
    if (candidate && existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return reply.type(contentType(candidate)).send(readFileSync(candidate));
      } catch { return reply.code(404).send({ error: { code: 'not-found' } }); }
    }
    if (!allowSpaFallback) return reply.code(404).send({ error: { code: 'not-found' } });
    if (/\.[a-z0-9]+$/i.test(path) && path !== '/') return reply.code(404).send({ error: { code: 'not-found' } });
    const index = candidateFor(root, '/index.html');
    if (index && existsSync(index)) return reply.type('text/html; charset=utf-8').send(readFileSync(index));
    return reply.code(404).send({ error: { code: 'not-found' } });
  };
  app.get('/assets/*', (request, reply) => serveFile(request, reply, false));
  app.get('/', (request, reply) => serveFile(request, reply, true));
  const isApiPath = (url: string) => url === '/api' || url.startsWith('/api/') || url === '/events' || url.startsWith('/events?');
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0]!;
    if (request.method === 'GET' && !isApiPath(path) && path !== '/' && !path.startsWith('/assets') && !/\.[a-z0-9]+$/i.test(path)) return serveFile(request, reply, true);
    return reply.code(404).send({ error: { code: 'not-found' } });
  });

  app.addHook('onClose', async () => { for (const close of closeSseConnections) close(); closeSseConnections.clear(); });
  return app;
}

export default createControlServer;
