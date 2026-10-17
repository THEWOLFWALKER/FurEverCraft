export type Status = {
  state?: string; paused?: boolean; stopping?: boolean;
  goal?: { goal_id?: string; text?: string; revision?: number; status?: string } | null;
  executions?: number; context?: Record<string, unknown>;
};
export type Goal = { goal_id: string; revision: number; status: string; spec?: { text?: string }; updated_at?: string };
export type Execution = { execution_id: string; skill_id: string; status: string; outcome?: string; reason?: string; goal_id?: string };
export type Effect = { effect_id: string; execution_id: string; status: string; intent?: unknown };
export type Place = { place_id: string; status: string; last_verified_at?: string };
export type Provider = { provider?: string; configured?: boolean; model?: string; networkEnabled?: boolean; transport?: string };
export type Capabilities = { profile?: string; provider?: Provider; skills?: boolean | unknown[]; limitations?: string[] };
export type EventRecord = { seq: string; eventId: string; kind: string; payload?: unknown };
export type EventRead = { events: EventRecord[]; gap: boolean; next: string; scannedCursor: string; availableFrom: string };

const json = async <T>(response: Response): Promise<T> => {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { error?: { code?: string } })?.error?.code ?? `http-${response.status}`);
  return body as T;
};

export const api = {
  status: () => fetch('/api/v1/status').then(r => json<Status>(r)),
  goals: () => fetch('/api/v1/goals').then(r => json<Goal[]>(r)),
  executions: () => fetch('/api/v1/executions').then(r => json<Execution[]>(r)),
  effects: () => fetch('/api/v1/effects').then(r => json<Effect[]>(r)),
  places: () => fetch('/api/v1/places').then(r => json<Place[]>(r)),
  capabilities: () => fetch('/api/v1/capabilities').then(r => json<Capabilities>(r)),
  provider: () => fetch('/api/v1/provider').then(r => json<Provider>(r)),
  events: (cursor = '0', limit = 50) => fetch(`/api/v1/events?cursor=${encodeURIComponent(cursor)}&limit=${limit}`).then(r => json<EventRead>(r)),
  command: async (command: string, payload: Record<string, unknown>, expectedRevision?: number) => {
    const requestId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await fetch('/api/v1/commands', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, command, payload, ...(expectedRevision === undefined ? {} : { expectedRevision }) }),
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body: body as Record<string, unknown> };
  },
};

export function subscribeEvents(onEvent: (event: EventRecord) => void, onState: (state: 'open' | 'error') => void, cursor = '0'): () => void {
  const source = new EventSource(`/api/v1/events/stream?cursor=${encodeURIComponent(cursor)}`);
  source.onopen = () => onState('open');
  source.onerror = () => onState('error');
  const push = (message: MessageEvent) => {
    if (message.lastEventId && message.type !== 'snapshot' && message.type !== 'gap') {
      try { onEvent({ seq: message.lastEventId, eventId: message.lastEventId, kind: message.type, payload: JSON.parse(message.data) }); } catch { /* ignore malformed */ }
    }
  };
  // Any named SSE event carries a kind; listen broadly via a catch-all dispatch on the source
  // using the EventSource message handler plus the known event names used by the control surface.
  source.onmessage = push as (message: MessageEvent) => void;
  for (const kind of [
    'control.goal.set', 'control.goal.revise', 'control.message', 'control.chat', 'control.pause', 'control.resume',
    'control.stop', 'control.cancel', 'control.save', 'control.quit',
    'runtime.pausing', 'runtime.stopping', 'runtime.shutdown-requested', 'runtime.recovered', 'runtime.recovery_failed',
    'tool.start_skill', 'tool.send_chat', 'tool.cancel_execution',
  ]) source.addEventListener(kind, push as EventListener);
  return () => source.close();
}
