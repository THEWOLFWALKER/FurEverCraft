import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { RuntimeAssembly } from '../execution/factory.js';
import type { ControlService } from '../control/service.js';
import { redact } from '../diagnostics/redaction.js';

export type ControlServerOptions = {
  host?: string;
  port?: number;
  heartbeatMs?: number;
  pollMs?: number;
  maxSseEvents?: number;
  maxSseBytes?: number;
  maxBodyBytes?: number;
  bearerToken?: string;
  csrfToken?: string;
  allowedOrigin?: string;
};

export type ControlServer = Server;
type Control = Pick<ControlService, 'status' | 'capabilities' | 'goals' | 'executions' | 'effects' | 'places' | 'events' | 'provider' | 'command'>;
type RuntimeOrControl = RuntimeAssembly | ControlService | Control;
type ServerContext = { control: Control; runtime?: RuntimeAssembly };

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const text = (value: unknown) => JSON.stringify(redact(value));
const asContext = (value: RuntimeOrControl): ServerContext => 'control' in value ? { control: value.control, runtime: value } : { control: value };
const numberParam = (url: URL, key: string, fallback: number, min: number, max: number) => {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, jsonHeaders);
  response.end(text(body));
}

function errorResponse(response: ServerResponse, status: number, code: string, message?: string) {
  send(response, status, { error: { code, ...(message ? { message } : {}) } });
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request-too-large');
    chunks.push(buffer);
  }
  if (!size) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('invalid-json'); }
}

function routeQuery(control: Control, pathname: string, url: URL, runtime?: RuntimeAssembly) {
  const limit = numberParam(url, 'limit', 100, 1, 10000);
  const cursor = url.searchParams.get('cursor') ?? '0';
  switch (pathname) {
    case '/api/v1/status': return control.status();
    case '/api/v1/capabilities': return control.capabilities();
    case '/api/v1/goals':
    case '/api/v1/tasks': return control.goals();
    case '/api/v1/executions': return control.executions();
    case '/api/v1/effects': return control.effects(url.searchParams.get('executionId') ?? undefined);
    case '/api/v1/places': return control.places();
    case '/api/v1/memories': return runtime?.store.listEpisodes() ?? [];
    case '/api/v1/provider':
    case '/api/v1/config': return control.provider();
    case '/api/v1/events': return control.events(cursor, limit, url.searchParams.get('filter') ?? undefined);
    default: {
      const match = pathname.match(/^\/api\/v1\/commands\/([^/]+)$/);
      if (match && runtime) {
        const receipt = runtime.store.getActionReceipt(`control:${runtime.bridge.context.serverProfileId}`, decodeURIComponent(match[1]!));
        return receipt ?? { requestId: decodeURIComponent(match[1]!), state: 'unknown', code: 'command-not-found' };
      }
      return undefined;
    }
  }
}

function writeSse(response: ServerResponse, event: string, payload: unknown, id?: string): boolean {
  const data = text(payload);
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\ndata: ${data}\n\n`);
  return true;
}

function startEvents(control: Control, request: IncomingMessage, response: ServerResponse, options: Required<Pick<ControlServerOptions, 'heartbeatMs' | 'pollMs' | 'maxSseEvents' | 'maxSseBytes'>>) {
  const url = new URL(request.url ?? '/events', 'http://localhost');
  const headerCursor = request.headers['last-event-id'];
  let cursor: string = (Array.isArray(headerCursor) ? (headerCursor[0] ?? '0') : (headerCursor ?? url.searchParams.get('cursor') ?? '0')) as string;
  if (!/^\d+$/.test(cursor)) { errorResponse(response, 400, 'invalid-event-cursor'); return; }
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let sent = 0;
  let bytes = 0;
  let closed = false;
  let poll: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const finish = () => { if (closed) return; closed = true; if (poll) clearInterval(poll); if (heartbeat) clearInterval(heartbeat); response.end(); };
  const emit = (event: string, payload: unknown, id?: string) => {
    if (closed) return false;
    const encoded = text(payload);
    const frameBytes = Buffer.byteLength(`${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${encoded}\n\n`);
    if (sent >= options.maxSseEvents || bytes + frameBytes > options.maxSseBytes) { finish(); return false; }
    writeSse(response, event, payload, id); sent += 1; bytes += frameBytes; return true;
  };

  const initial = control.events(cursor, options.maxSseEvents);
  if (initial.gap) emit('gap', { gap: true, availableFrom: initial.availableFrom, cursor: initial.scannedCursor }, initial.scannedCursor);
  // The snapshot reflects everything already consumed up to `cursor`; replay follows strictly ascending ids.
  const snapshot = { ...control.status(), capabilities: control.capabilities(), goals: control.goals(), executions: control.executions(), effects: control.effects(), places: control.places(), provider: control.provider(), cursor, gap: initial.gap };
  emit('snapshot', snapshot, cursor);
  for (const event of initial.events) { if (!emit(event.kind, event.payload, event.seq)) break; cursor = event.seq; }
  if (initial.events.length) cursor = initial.next;

  poll = setInterval(() => {
    if (closed) return;
    try {
      const read = control.events(cursor, Math.min(256, options.maxSseEvents - sent));
      if (read.gap) { emit('gap', { gap: true, availableFrom: read.availableFrom, cursor: read.scannedCursor }, read.scannedCursor); finish(); return; }
      for (const event of read.events) { if (!emit(event.kind, event.payload, event.seq)) return; cursor = event.seq; }
    } catch { finish(); }
  }, options.pollMs);
  heartbeat = setInterval(() => {
    if (closed || response.writableNeedDrain) return;
    const frame = `: heartbeat\n\n`;
    if (bytes + Buffer.byteLength(frame) > options.maxSseBytes) { finish(); return; }
    bytes += Buffer.byteLength(frame);
    response.write(frame);
  }, options.heartbeatMs);
  request.on('aborted', finish);
  request.on('close', finish);
  response.on('close', finish);
}

export function createControlServer(runtimeOrControl: RuntimeOrControl, options: ControlServerOptions = {}): ControlServer {
  const context = asContext(runtimeOrControl);
  const control = context.control;
  const settings = {
    heartbeatMs: options.heartbeatMs ?? 15_000,
    pollMs: options.pollMs ?? 250,
    maxSseEvents: options.maxSseEvents ?? 256,
    maxSseBytes: options.maxSseBytes ?? 1024 * 1024,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    host: options.host ?? '127.0.0.1',
    bearerToken: options.bearerToken,
    csrfToken: options.csrfToken,
    allowedOrigin: options.allowedOrigin,
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      const host = (request.headers.host ?? '').split(':')[0]!.toLowerCase();
      if (settings.host === '127.0.0.1' && host && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') { errorResponse(response, 403, 'host-not-allowed'); return; }
      const origin = request.headers.origin;
      if (origin && settings.allowedOrigin && origin !== settings.allowedOrigin) { errorResponse(response, 403, 'origin-not-allowed'); return; }
      if (origin && !settings.allowedOrigin && origin !== `http://${request.headers.host ?? 'localhost'}`) { errorResponse(response, 403, 'origin-not-allowed'); return; }
      if (settings.bearerToken && request.headers.authorization !== `Bearer ${settings.bearerToken}`) { errorResponse(response, 401, 'unauthorized'); return; }
      if (request.method === 'OPTIONS') { response.writeHead(204, { 'access-control-allow-origin': settings.allowedOrigin ?? 'null', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'authorization,content-type,last-event-id,x-csrf-token' }); response.end(); return; }
      if (request.method === 'GET' && (url.pathname === '/api/v1/events/stream' || url.pathname === '/events')) { startEvents(control, request, response, settings); return; }
      if (request.method === 'GET') {
        const result = routeQuery(control, url.pathname, url, context.runtime);
        if (result === undefined) { errorResponse(response, 404, 'not-found'); return; }
        send(response, 200, result); return;
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/commands') {
        if (origin && settings.csrfToken && request.headers['x-csrf-token'] !== settings.csrfToken) { errorResponse(response, 403, 'csrf-failed'); return; }
        const input = await readJson(request, settings.maxBodyBytes);
        const result = await control.command(input);
        if (result.state === 'conflict') { send(response, 409, result); return; }
        if (result.state === 'rejected') { send(response, 400, result); return; }
        send(response, 200, result); return;
      }
      errorResponse(response, 404, 'not-found');
    } catch (error) {
      const code = error instanceof Error ? error.message : 'request-failed';
      errorResponse(response, code === 'request-too-large' ? 413 : code === 'invalid-json' ? 400 : 400, code);
    }
  });
  return server;
}

export default createControlServer;
