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
  /** Maximum concurrently attached SSE clients (default 8). Exceeding it returns 503 sse-capacity. */
  maxSseConnections?: number;
  /** Service-wide bytes queued to SSE sockets but not yet flushed (default 1 MiB). */
  maxSsePendingBytes?: number;
  /** A connection that cannot drain within this window gets an explicit gap and is closed. */
  sseSlowConsumerMs?: number;
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
  const serverState = { activeSseConnections: 0, pendingSseBytes: 0 };
  Object.defineProperty(app, 'activeSseConnections', { get: () => serverState.activeSseConnections, enumerable: true });
  Object.defineProperty(app, 'activeSseBytes', { get: () => serverState.pendingSseBytes, enumerable: true });

  const EFFECT_PAGE_DEFAULT = 20;
  const EFFECT_PAGE_MAX = 100;
  /**
   * Effects are read as a bounded SQL page (FEC-56). The production path never materialises the
   * whole table; a ControlService without an attached store (tests/fixtures) falls back to an
   * in-memory page with the same shape.
   */
  const effectsPage = (query: { executionId?: unknown; limit?: unknown; cursor?: unknown } = {}, defaultLimit = EFFECT_PAGE_DEFAULT) => {
    const executionId = typeof query.executionId === 'string' && query.executionId ? query.executionId : undefined;
    const requested = Number(query.limit);
    const limit = Number.isFinite(requested) && requested >= 1 ? Math.min(Math.trunc(requested), EFFECT_PAGE_MAX) : defaultLimit;
    const cursor = typeof query.cursor === 'string' && query.cursor ? query.cursor : undefined;
    if (runtime) {
      const page = runtime.store.listEffectsPage(executionId, { limit, ...(cursor === undefined ? {} : { cursor }), maxLimit: EFFECT_PAGE_MAX });
      return {
        items: page.items,
        truncated: page.truncated,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        total: runtime.store.countEffects(),
      };
    }
    const all = (control.effects(executionId) as Array<{ effectId?: string; effect_id?: string }>)
      .slice()
      .sort((left, right) => String(left.effectId ?? left.effect_id ?? '').localeCompare(String(right.effectId ?? right.effect_id ?? '')));
    const start = cursor === undefined ? 0 : all.findIndex(item => String(item.effectId ?? item.effect_id ?? '') > cursor);
    const from = start < 0 ? all.length : start;
    const items = all.slice(from, from + limit);
    const truncated = from + items.length < all.length;
    return {
      items,
      truncated,
      ...(truncated && items.length ? { nextCursor: String(items[items.length - 1]!.effectId ?? items[items.length - 1]!.effect_id ?? '') } : {}),
      limit,
      ...(cursor === undefined ? {} : { cursor }),
      total: all.length,
    };
  };

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

  // Every response below denotes runtime data that may have originated from a model, input intent
  // or durable history. Redaction happens at this HTTP boundary (FEC-57) without touching ids,
  // cursors or the pairing/CSRF response.
  app.get('/api/v1/status', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return redact(control.status()); });
  app.get('/api/v1/capabilities', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return control.capabilities(); });
  app.get('/api/v1/goals', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return redact(control.goals()); });
  app.get('/api/v1/tasks', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return redact(control.goals()); });
  app.get('/api/v1/executions', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return redact(control.executions()); });
  app.get('/api/v1/effects', async (request, reply) => {
    if (!authorizeRequest(request, reply)) return reply;
    try { return redact(effectsPage(request.query as { executionId?: unknown; limit?: unknown; cursor?: unknown })); }
    catch { return reply.code(400).send({ error: { code: 'invalid-effects-query' } }); }
  });
  app.get('/api/v1/places', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return control.places(); });
  // Both places and episodes are scope-filtered by the attached runtime identity (FEC-46);
  // the unscoped store.listEpisodes() table dump is gone.
  app.get('/api/v1/memories', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return redact(control.memories()); });
  app.get('/api/v1/provider', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return control.provider(); });
  // The P21 doctor report is a read-only view over the same attached Runtime. It goes through
  // the same pairing/bearer/Origin policy as every other read and is redacted before transmission.
  app.get('/api/v1/doctor', async (request, reply) => { if (!authorizeRequest(request, reply)) return reply; return redact(control.diagnostics()); });
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
      if (result.state === 'conflict') return reply.code(409).send(redact(result));
      if (result.state === 'rejected') return reply.code(400).send(redact(result));
      return redact(result);
    } catch (error) {
      // A bad payload must not take down the control plane or leak internals.
      return reply.code(400).send({ requestId: parsed.data.requestId, command: parsed.data.command, state: 'rejected', code: redact(error instanceof Error ? error.message : String(error)) });
    }
  });

  app.get('/api/v1/events/stream', streamHandler);
  app.get('/events', streamHandler);
  const closeSseConnections = new Set<() => void>();
  const maxSseConnections = Math.max(1, Math.trunc(options.maxSseConnections ?? 8));
  const maxSsePendingBytes = Math.max(1, Math.trunc(options.maxSsePendingBytes ?? 1024 * 1024));
  const slowConsumerMs = Math.max(1, Math.trunc(options.sseSlowConsumerMs ?? 5_000));
  function streamHandler(request: FastifyRequest, reply: FastifyReply) {
    if (!authorizeRequest(request, reply)) return reply;
    const header = request.headers['last-event-id'];
    const query = request.query as { cursor?: string };
    const requestedFrame = Array.isArray(header) ? header[0] : header ?? query.cursor ?? '0';
    const cursorText = String(requestedFrame);
    if (!/^\d+$/.test(cursorText)) return reply.code(400).send({ error: { code: 'invalid-event-cursor' } });
    if (serverState.activeSseConnections >= maxSseConnections) {
      // Capacity is checked before hijacking so a refused subscription is a normal HTTP error.
      return reply.code(503).send({ error: { code: 'sse-capacity' } });
    }
    reply.hijack();
    const raw = reply.raw;
    serverState.activeSseConnections += 1;
    try {
      raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    } catch {
      serverState.activeSseConnections = Math.max(0, serverState.activeSseConnections - 1);
      return reply;
    }
    let position = cursorText; let closed = false; let sent = 0; let bytes = 0;
    const maxEvents = Math.max(4, options.maxSseEvents ?? 256); const maxBytes = Math.max(4096, options.maxSseBytes ?? 1024 * 1024);
    let availableFrom = '0';
    let skippedFrames = 0; let blockedSince: number | undefined;
    const pendingSettles = new Set<() => void>();
    options.onSseConnection?.('open');
    let poll: ReturnType<typeof setInterval> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      if (poll) clearInterval(poll);
      if (heartbeat) clearInterval(heartbeat);
      closeSseConnections.delete(finish);
      // Write callbacks may not fire after a destroyed socket; settle local accounting once.
      for (const settle of [...pendingSettles]) settle();
      pendingSettles.clear();
      serverState.activeSseConnections = Math.max(0, serverState.activeSseConnections - 1);
      options.onSseConnection?.('closed');
      try { raw.end(); } catch { /* peer already gone */ }
    };
    closeSseConnections.add(finish);
    const frameOf = (event: string, payload: unknown, id?: string) => `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(redact(payload))}\n\n`;
    /**
     * Track bytes handed to the socket but not yet flushed. Node invokes the write callback
     * after the chunk is accepted by the kernel, so the total is a real service-wide pending
     * budget rather than a synthetic frame counter.
     */
    const trackWrite = (frame: string): boolean => {
      if (closed) return false;
      const size = Buffer.byteLength(frame);
      // Always allow one in-flight frame to make progress; otherwise the service-wide cap wins.
      if (serverState.pendingSseBytes > 0 && serverState.pendingSseBytes + size > maxSsePendingBytes) return false;
      serverState.pendingSseBytes += size;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        pendingSettles.delete(settle);
        serverState.pendingSseBytes = Math.max(0, serverState.pendingSseBytes - size);
      };
      pendingSettles.add(settle);
      try { raw.write(frame, () => settle()); } catch { settle(); return false; }
      return true;
    };
    type EmitResult = 'sent' | 'skipped' | 'budget' | 'closed';
    const emit = (event: string, payload: unknown, id?: string): EmitResult => {
      if (closed) return 'closed';
      const frame = frameOf(event, payload, id);
      const size = Buffer.byteLength(frame);
      if (sent >= maxEvents || bytes + size > maxBytes) return 'budget';
      if (!trackWrite(frame)) {
        skippedFrames += 1;
        blockedSince ??= now();
        return 'skipped';
      }
      sent += 1; bytes += size;
      skippedFrames = 0; blockedSince = undefined;
      return 'sent';
    };
    /** Explicit gap/snapshot frames are never silently dropped for budget reasons. */
    const emitCritical = (event: string, payload: unknown, id?: string): boolean => {
      if (closed) return false;
      const frame = frameOf(event, payload, id);
      if (!trackWrite(frame)) return false;
      sent += 1; bytes += Buffer.byteLength(frame);
      return true;
    };
    const slowConsumer = () => skippedFrames >= 64 || (blockedSince !== undefined && now() - blockedSince >= slowConsumerMs);
    const head = () => control.eventsHead();
    const snapshot = (cursor: string, gap: boolean, windowed: boolean) => {
      try {
        const page = effectsPage({}, EFFECT_PAGE_DEFAULT);
        return {
          ...control.status(), capabilities: control.capabilities(), goals: control.goals(), executions: control.executions(),
          effects: page.items, effectPage: { truncated: page.truncated, limit: page.limit, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) },
          places: control.places(), provider: control.provider(), cursor, gap, ...(windowed ? { windowed: true } : {}),
        };
      } catch (error) {
        // A closed store during shutdown must end as an explicit gap/unknown snapshot, not a
        // half-written SSE session.
        return { state: 'closed', paused: true, stopping: true, cursor, gap: true, error: redact(error instanceof Error ? error.message : String(error)), goals: [], executions: [], effects: [], effectPage: { truncated: false, limit: EFFECT_PAGE_DEFAULT }, places: [] };
      }
    };
    const overflow = (reason: string) => {
      // Reserve a final frame even when the event budget is exhausted, so a truncation is
      // explicit instead of looking like a clean end-of-stream.
      try { emitCritical('gap', { gap: true, reason, cursor: position, head: head(), availableFrom }, head()); } catch { /* ignore */ }
      finish();
    };
    try { availableFrom = String(control.events('0', 1).availableFrom); } catch { availableFrom = '0'; }
    const requested = Number(cursorText);
    const initialHeadValue = Number(head());
    let initialGap: string | undefined;
    if (requested > initialHeadValue) initialGap = 'cursor-ahead';
    else if (requested + 1 < Number(availableFrom)) initialGap = 'cursor-expired';
    let snapshotCursor = String(initialHeadValue);
    if (initialGap) {
      if (!emitCritical('gap', { gap: true, reason: initialGap, cursor: snapshotCursor, from: cursorText, head: snapshotCursor, availableFrom }, snapshotCursor)) { finish(); return reply; }
      position = snapshotCursor;
    }

    // Decide up front whether the unseen backlog fits. The snapshot frame is always last and
    // its event slot and serialized size are reserved before any replay frame is written.
    const backlog = Math.max(0, initialHeadValue - Number(position));
    let replayEvents: Array<{ seq: string; kind: string; payload: unknown }> = [];
    let replayFits = backlog === 0;
    let replayReason = 'replay-overflow';
    if (backlog > 0) {
      if (backlog > 10_000) replayFits = false;
      else {
        try {
          const read = control.events(position, backlog);
          replayEvents = read.events;
          const snapshotSize = Buffer.byteLength(frameOf('snapshot', snapshot(snapshotCursor, Boolean(initialGap), false), snapshotCursor));
          const replayBytes = replayEvents.reduce((total, event) => total + Buffer.byteLength(frameOf(event.kind, event.payload, event.seq)), 0);
          let monotonic = true;
          let previous = Number(position);
          for (const event of replayEvents) {
            const seq = Number(event.seq);
            if (seq <= previous || seq > initialHeadValue) { monotonic = false; break; }
            previous = seq;
          }
          replayFits = replayEvents.length === backlog && monotonic
            && sent + replayEvents.length + 1 <= maxEvents
            && bytes + replayBytes + snapshotSize <= maxBytes;
        } catch { replayFits = false; }
      }
    }

    let snapshotSent = false;
    if (backlog > 0 && !replayFits) {
      // The replay cannot fit. Emit an explicit gap at head and reset with the snapshot.
      if (!emitCritical('gap', { gap: true, reason: replayReason, cursor: snapshotCursor, from: position, head: snapshotCursor, availableFrom }, snapshotCursor)) { finish(); return reply; }
      position = snapshotCursor;
      if (!emitCritical('snapshot', snapshot(snapshotCursor, true, false), snapshotCursor)) { finish(); return reply; }
      snapshotSent = true;
    } else {
      for (const event of replayEvents) {
        const result = emit(event.kind, event.payload, event.seq);
        if (result === 'sent') { position = event.seq; continue; }
        if (result === 'closed') return reply;
        // A connection that cannot accept the remaining replay is reset at head. Slow consumers
        // get an explicit gap and are disconnected rather than left with a partial cursor.
        const reason = result === 'skipped' ? 'slow-consumer' : 'replay-overflow';
        if (!emitCritical('gap', { gap: true, reason, cursor: snapshotCursor, from: position, head: snapshotCursor, availableFrom }, snapshotCursor)) { finish(); return reply; }
        position = snapshotCursor;
        if (!emitCritical('snapshot', snapshot(snapshotCursor, true, false), snapshotCursor)) { finish(); return reply; }
        snapshotSent = true;
        if (reason === 'slow-consumer') { finish(); return reply; }
        break;
      }
      if (!closed && !snapshotSent) {
        const result = emit('snapshot', snapshot(snapshotCursor, Boolean(initialGap), false), snapshotCursor);
        if (result === 'sent') { snapshotSent = true; position = snapshotCursor; }
        else {
          // The reserved slot was still insufficient (for example a snapshot larger than
          // maxSseBytes); announce a gap so the client does not resume at a partial cursor.
          emitCritical('gap', { gap: true, reason: 'stream-budget', cursor: position, head: snapshotCursor, availableFrom }, snapshotCursor);
          finish(); return reply;
        }
      }
    }
    if (!snapshotSent) { finish(); return reply; }

    poll = setInterval(() => {
      if (closed) return;
      try {
        const read = control.events(position, Math.max(1, Math.min(256, maxEvents - sent)));
        if (read.gap) {
          // A retained-window gap: announce it, then resend the complete snapshot at the new
          // cursor so the subscriber never resumes from a partial status document.
          const nextHead = head();
          if (!emitCritical('gap', { gap: true, reason: 'retention-gap', availableFrom: read.availableFrom, cursor: read.scannedCursor }, read.scannedCursor)) { finish(); return; }
          if (!emitCritical('snapshot', snapshot(nextHead, true, false), nextHead)) { finish(); return; }
          position = nextHead;
          return;
        }
        for (const event of read.events) {
          const result = emit(event.kind, event.payload, event.seq);
          if (result === 'sent') { position = event.seq; continue; }
          if (result === 'closed') return;
          if (result === 'budget') { overflow('stream-budget'); return; }
          // Backpressure: skip this and later non-critical frames without advancing the cursor.
          if (slowConsumer()) {
            const currentHead = head();
            emitCritical('gap', { gap: true, reason: 'slow-consumer', cursor: currentHead, from: position, head: currentHead, availableFrom }, currentHead);
            finish();
          }
          return;
        }
      } catch { finish(); }
    }, options.pollMs ?? 250);
    heartbeat = setInterval(() => {
      if (closed || raw.writableNeedDrain) return;
      try { trackWrite(': heartbeat\n\n'); } catch { finish(); }
    }, options.heartbeatMs ?? 15_000);
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
