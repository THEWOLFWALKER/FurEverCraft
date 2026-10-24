export type FieldEvidence = { source?: string; observedAt?: number; expiresAt?: number; freshness?: string; available?: boolean; evidenceRef?: string };
export type Observation = {
  source?: string; freshness?: string; gap?: boolean; revision?: string; unknownCells?: number;
  fields?: Record<string, FieldEvidence>; error?: string; reason?: string;
};
export type SessionInfo = { state?: string; recoveryAttempts?: number; recoveryBudget?: number };
export type Status = {
  state?: string; paused?: boolean; stopping?: boolean; closed?: boolean;
  goal?: { goal_id?: string; text?: string; revision?: number; status?: string } | null;
  executions?: number;
  context?: Record<string, unknown>;
  position?: { x?: number; y?: number } | null;
  inventory?: number;
  ui?: string;
  observation?: Observation;
  session?: SessionInfo;
};
export type Goal = { goal_id: string; revision: number; status: string; text?: string; spec?: { text?: string }; updated_at?: string };
export type Execution = { execution_id: string; skill_id: string; status: string; outcome?: string; reason?: string; goal_id?: string; proposal_id?: string };
export type Effect = { effect_id: string; execution_id: string; status: string; intent?: unknown; evidence?: Record<string, unknown> };
export type Place = { place_id: string; status: string; last_verified_at?: string; payload?: unknown; context?: unknown };
export type Provider = { provider?: string; configured?: boolean; model?: string; networkEnabled?: boolean; transport?: string };
export type Capabilities = {
  profile?: string; provider?: Provider;
  bridge?: Record<string, unknown> & { limitations?: string[]; source?: string };
  skills?: string[] | boolean;
  inputsEnabled?: boolean;
  limitations?: string[];
};
export type Config = { provider?: Provider; profile?: string; pairing?: boolean; cliAccess?: string };
export type EventRecord = { seq: string; eventId: string; kind: string; payload?: unknown; durable?: boolean };
export type EventRead = { events: EventRecord[]; gap: boolean; next: string; scannedCursor: string; availableFrom: string };
export type Snapshot = Omit<Status, 'executions'> & {
  capabilities?: Capabilities; goals?: Goal[]; executions?: Execution[]; effects?: Effect[];
  places?: Place[]; provider?: Provider; cursor?: string; gap?: boolean; windowed?: boolean;
};

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, readonly body: unknown) {
    super(code);
    this.name = 'ApiError';
  }
}

let csrfToken: string | undefined;
try { csrfToken = typeof sessionStorage === 'undefined' ? undefined : sessionStorage.getItem('furevercraft.csrf') ?? undefined; } catch { csrfToken = undefined; }
export const isAuthError = (error: unknown) => error instanceof ApiError && (error.status === 401 || error.code === 'origin-required');

/** Pairing keeps the CSRF token in sessionStorage; the session itself is an HttpOnly cookie. */
export async function pair(code: string): Promise<{ expiresInMs?: number }> {
  const response = await fetch('/api/v1/pair', {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const body = await response.json().catch(() => ({})) as { csrfToken?: string; expiresInMs?: number; error?: { code?: string } };
  if (!response.ok || !body.csrfToken) throw new ApiError(body.error?.code ?? `http-${response.status}`, response.status, body);
  csrfToken = body.csrfToken;
  try { sessionStorage.setItem('furevercraft.csrf', body.csrfToken); } catch { /* storage may be disabled */ }
  return { expiresInMs: body.expiresInMs };
}

const json = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError((body as { error?: { code?: string } })?.error?.code ?? `http-${response.status}`, response.status, body);
  return body as T;
};

export const api = {
  status: () => fetch('/api/v1/status', { credentials: 'same-origin' }).then(r => json<Status>(r)),
  goals: () => fetch('/api/v1/goals', { credentials: 'same-origin' }).then(r => json<Goal[]>(r)),
  executions: () => fetch('/api/v1/executions', { credentials: 'same-origin' }).then(r => json<Execution[]>(r)),
  effects: (executionId?: string) => fetch(`/api/v1/effects${executionId ? `?executionId=${encodeURIComponent(executionId)}` : ''}`, { credentials: 'same-origin' }).then(r => json<Effect[]>(r)),
  places: () => fetch('/api/v1/places', { credentials: 'same-origin' }).then(r => json<Place[]>(r)),
  capabilities: () => fetch('/api/v1/capabilities', { credentials: 'same-origin' }).then(r => json<Capabilities>(r)),
  provider: () => fetch('/api/v1/provider', { credentials: 'same-origin' }).then(r => json<Provider>(r)),
  config: () => fetch('/api/v1/config', { credentials: 'same-origin' }).then(r => json<Config>(r)),
  events: (cursor = '0', limit = 50) => fetch(`/api/v1/events?cursor=${encodeURIComponent(cursor)}&limit=${limit}`, { credentials: 'same-origin' }).then(r => json<EventRead>(r)),
  command: async (command: string, payload: Record<string, unknown>, expectedRevision?: number) => {
    const requestId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await fetch('/api/v1/commands', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
      body: JSON.stringify({ requestId, command, payload, ...(expectedRevision === undefined ? {} : { expectedRevision }) }),
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body: body as Record<string, unknown> };
  },
};

export type StreamState = 'connecting' | 'open' | 'closed' | 'error';
export type StreamHandlers = {
  onEvent: (event: EventRecord) => void;
  onState: (state: StreamState) => void;
  onSnapshot?: (snapshot: Snapshot) => void;
  onGap?: (gap: { reason?: string; cursor?: string; head?: string; availableFrom?: string; gap?: boolean }) => void;
};

export function subscribeEvents(handlers: StreamHandlers, cursor = '0'): () => void {
  const source = new EventSource(`/api/v1/events/stream?cursor=${encodeURIComponent(cursor)}`);
  source.onopen = () => handlers.onState('open');
  source.onerror = () => handlers.onState('error');
  const push = (message: MessageEvent) => {
    if (!message.lastEventId) return;
    try {
      handlers.onEvent({ seq: message.lastEventId, eventId: message.lastEventId, kind: message.type, payload: JSON.parse(message.data), durable: true });
    } catch { /* ignore malformed frames; the next snapshot repairs state */ }
  };
  source.addEventListener('snapshot', (message: MessageEvent) => {
    try { handlers.onSnapshot?.(JSON.parse(message.data) as Snapshot); } catch { /* ignore malformed snapshot */ }
  });
  source.addEventListener('gap', (message: MessageEvent) => {
    try { handlers.onGap?.(JSON.parse(message.data) as { reason?: string; cursor?: string; head?: string; availableFrom?: string; gap?: boolean }); } catch { /* ignore */ }
  });
  source.onmessage = push as (message: MessageEvent) => void;
  for (const kind of [
    'control.goal.set', 'control.goal.revise', 'control.message', 'control.chat', 'control.pause', 'control.resume',
    'control.recover', 'control.stop', 'control.cancel', 'control.save', 'control.quit',
    'runtime.pausing', 'runtime.stopping', 'runtime.shutdown-requested', 'runtime.recovered', 'runtime.recovery_failed',
    'tool.start_skill', 'tool.send_chat', 'tool.cancel_execution',
  ]) source.addEventListener(kind, push as EventListener);
  return () => source.close();
}
