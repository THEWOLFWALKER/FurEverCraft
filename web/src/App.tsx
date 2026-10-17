import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribeEvents, type Capabilities, type Effect, type EventRecord, type Execution, type Goal, type Place, type Provider, type Status } from './api';

const value = (input: unknown) => (input === undefined || input === null || input === '' ? '--' : String(input));
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString() : '--');

function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) { return <span className={`dot ${tone}`} aria-hidden="true" />; }

function stateTone(status?: string): 'ok' | 'warn' | 'bad' | 'idle' {
  if (!status) return 'idle';
  if (['succeeded', 'running', 'active', 'terminal'].includes(status)) return 'ok';
  if (['suspended', 'ambiguous', 'partial', 'accepted', 'unknown', 'pausing', 'stopping', 'idle'].includes(status)) return 'warn';
  if (['failed', 'canceled'].includes(status)) return 'bad';
  return 'idle';
}

function Metric({ label, value: number, hint }: { label: string; value: number | undefined; hint: string }) {
  return (
    <div className="panel metric">
      <span className="metric-value">{value === undefined ? '--' : value}</span>
      <span className="metric-label">{label}</span>
      <span className="sr-only">{hint}</span>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [effects, setEffects] = useState<Effect[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [provider, setProvider] = useState<Provider>();
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [stream, setStream] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>();
  const [goalId, setGoalId] = useState('goal-main');
  const [goalText, setGoalText] = useState('Explore the local area and return');
  const [message, setMessage] = useState('Check the surroundings and report status');
  const [cancelId, setCancelId] = useState('');
  const cursor = useRef('0');

  const refresh = useCallback(async () => {
    try {
      const [s, g, e, f, p, c, pr] = await Promise.all([api.status(), api.goals(), api.executions(), api.effects(), api.places(), api.capabilities(), api.provider()]);
      setStatus(s); setGoals(g); setExecutions(e); setEffects(f); setPlaces(p); setCapabilities(c); setProvider(pr);
      setError(undefined); setLastUpdated(new Date().toLocaleTimeString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'request failed');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const stop = subscribeEvents(
      event => { cursor.current = event.seq; setEvents(previous => [event, ...previous].slice(0, 80)); },
      state => setStream(state),
      cursor.current,
    );
    return stop;
  }, []);

  const run = useCallback(async (command: string, payload: Record<string, unknown>, expectedRevision?: number) => {
    setBusy(true);
    try {
      const result = await api.command(command, payload, expectedRevision);
      if (result.status >= 400) setError(String((result.body as { code?: string }).code ?? `http-${result.status}`));
      else setError(undefined);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'command failed');
    } finally { setBusy(false); }
  }, [refresh]);

  const activeGoal = useMemo(() => goals.find(goal => goal.status === 'active' || goal.status === 'paused') ?? goals[0], [goals]);
  const headline = status?.stopping ? 'Stopping' : status?.paused ? 'Paused' : status?.state === 'running' ? 'Running' : 'Idle';
  const tone: 'ok' | 'warn' | 'bad' | 'idle' = status?.state === 'recoverable-failure' ? 'bad' : status?.stopping || status?.paused ? 'warn' : status?.state === 'running' ? 'ok' : 'idle';
  const pendingEffects = effects.filter(effect => !['confirmed', 'partial'].includes(effect.status)).length;

  return (
    <div className="app">
      <header className="app-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span className="brand-name">FUREVERCRAFT CONTROL</span>
        </div>
        <div className="app-bar-actions">
          <Dot tone={stream === 'open' ? 'ok' : stream === 'error' ? 'bad' : 'idle'} />
          <span className="row-meta">{stream === 'open' ? 'live' : stream === 'error' ? 'stream unavailable' : 'connecting'}</span>
          <button onClick={() => void refresh()} disabled={busy}>Refresh</button>
        </div>
      </header>

      {error && <div className="panel error" role="alert">Command or read failed: {error}. Values shown as -- are unavailable.</div>}

      <div className="grid two">
        <section className="panel primary">
          <h2>Runtime status</h2>
          <div className="hero-status"><Dot tone={tone} /> {headline}</div>
          <p className="hero-explain">
            {activeGoal?.spec?.text ?? 'No active goal. Set one below to start autonomous work.'}
          </p>
          <div className="hero-meta">
            <span>profile {value(capabilities?.profile)}</span>
            <span>provider {value(provider?.provider)}</span>
            <span>updated {value(lastUpdated)}</span>
          </div>
        </section>
        <section className="panel">
          <h2>Capabilities</h2>
          <div className="kv">
            <div className="kv-row"><span className="kv-key">Network</span><span className="kv-value">{provider?.networkEnabled ? 'enabled' : 'disabled'}</span></div>
            <div className="kv-row"><span className="kv-key">Model configured</span><span className="kv-value">{provider?.configured === undefined ? '--' : provider.configured ? 'yes' : 'no'}</span></div>
            <div className="kv-row"><span className="kv-key">Transport</span><span className="kv-value">{value(provider?.transport)}</span></div>
            <div className="kv-row"><span className="kv-key">Limitations</span><span className="kv-value">{capabilities?.limitations?.length ? capabilities.limitations.join(', ') : 'none reported'}</span></div>
          </div>
        </section>
      </div>

      <div className="grid metrics" style={{ marginTop: 16 }}>
        <Metric label="Active goal revision" value={activeGoal?.revision} hint="Current goal revision or unknown" />
        <Metric label="Executions" value={executions.length} hint="Persisted executions or unknown" />
        <Metric label="Pending effects" value={pendingEffects} hint="Effects not yet confirmed or partial" />
        <Metric label="Places" value={places.length} hint="Remembered places or unknown" />
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <section className="panel">
          <h2>Command</h2>
          <div className="form">
            <label>Goal id<input value={goalId} onChange={event => setGoalId(event.target.value)} /></label>
            <label>Goal text<textarea rows={2} value={goalText} onChange={event => setGoalText(event.target.value)} /></label>
            <div className="actions">
              <button className="primary" disabled={busy || !goalText.trim()} onClick={() => void run('goal.set', { goalId, text: goalText }, activeGoal && activeGoal.goal_id === goalId ? activeGoal.revision : undefined)}>Set goal</button>
              <button disabled={busy || !activeGoal} onClick={() => void run('goal.revise', { goalId: activeGoal!.goal_id, expectedRevision: activeGoal!.revision, change: goalText })}>Revise goal</button>
            </div>
            <label>Message to agent<textarea rows={2} value={message} onChange={event => setMessage(event.target.value)} /></label>
            <div className="actions">
              <button disabled={busy || !message.trim()} onClick={() => void run('message', { text: message })}>Send message</button>
              <button disabled={busy || !message.trim()} onClick={() => void run('chat', { text: message })}>Send game chat</button>
            </div>
            <div className="actions">
              <button disabled={busy} onClick={() => void run('pause', {})}>Pause</button>
              <button disabled={busy} onClick={() => void run('resume', {})}>Resume</button>
              <button disabled={busy} onClick={() => void run('save', {})}>Save checkpoint</button>
              <button disabled={busy} onClick={() => void run('stop', {})}>Stop</button>
            </div>
            <label>Cancel execution<input placeholder="execution id" value={cancelId} onChange={event => setCancelId(event.target.value)} /></label>
            <div className="actions">
              <button disabled={busy || !cancelId.trim()} onClick={() => void run('cancel', { executionId: cancelId.trim() })}>Cancel execution</button>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>Executions</h2>
          <div className="list">
            {executions.length === 0 ? <div className="empty">No executions yet.</div> : executions.slice(0, 8).map(execution => (
              <div className="row" key={execution.execution_id}>
                <div className="row-main">
                  <span className="row-id">{execution.execution_id}</span>
                  <span className="row-meta">{execution.skill_id} · outcome {value(execution.outcome)}</span>
                </div>
                <span className={`tag ${stateTone(execution.status)}`}>{execution.status}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <section className="panel">
          <h2>Effects</h2>
          <div className="list">
            {effects.length === 0 ? <div className="empty">No effects recorded.</div> : effects.slice(0, 8).map(effect => (
              <div className="row" key={effect.effect_id}>
                <div className="row-main">
                  <span className="row-id">{effect.effect_id}</span>
                  <span className="row-meta">{effect.execution_id}</span>
                </div>
                <span className={`tag ${stateTone(effect.status)}`}>{effect.status}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="panel">
          <h2>Places</h2>
          <div className="list">
            {places.length === 0 ? <div className="empty">No places remembered.</div> : places.slice(0, 8).map(place => (
              <div className="row" key={place.place_id}>
                <div className="row-main">
                  <span className="row-id">{place.place_id}</span>
                  <span className="row-meta">verified {value(place.last_verified_at)}</span>
                </div>
                <span className={`tag ${stateTone(place.status)}`}>{place.status}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2>Event stream</h2>
        <div className="list">
          {events.length === 0 ? <div className="empty">No events received yet.</div> : events.slice(0, 20).map(event => (
            <div className="row" key={`${event.seq}-${event.kind}`}>
              <div className="row-main">
                <span className="row-id">{event.kind}</span>
                <span className="row-meta">{JSON.stringify(event.payload ?? {}).slice(0, 160)}</span>
              </div>
              <span className="row-time">#{event.seq}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="footer">
        Offline control surface. Values marked -- are unavailable, not zero. Accepted actions are not world-confirmed effects.
      </footer>
    </div>
  );
}
