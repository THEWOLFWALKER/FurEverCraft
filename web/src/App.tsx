import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, isAuthError, pair, subscribeEvents,
  type Capabilities, type Config, type Effect, type EventRecord, type Execution, type Goal, type Place,
  type Provider, type Snapshot, type Status, type StreamState,
} from './api';

function WorldCanvas({ cells }: { cells: Record<string, string> }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  React.useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#f8fbff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const entries = Object.entries(cells);
    if (entries.length === 0) { ctx.fillStyle = '#8195aa'; ctx.font = '12px Inter, system-ui'; ctx.fillText('No local cells observed (unknown)', 12, 24); return; }
    const size = Math.max(6, Math.floor(Math.min(canvas.width, canvas.height) / 24));
    entries.slice(0, 24 * 24).forEach(([key, value]) => {
      const [x, y] = key.split(',').map(Number) as [number, number];
      ctx.fillStyle = value === 'blocked' ? '#0b2142' : value === 'free' ? '#2bbd79' : '#f1b743';
      ctx.fillRect((x % 24) * size, (y % 24) * size, size - 1, size - 1);
    });
  });
  return <canvas ref={ref} width={288} height={288} aria-label="Top-down local world view" role="img" />;
}

const value = (input: unknown) => (input === undefined || input === null || input === '' ? '--' : String(input));
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString() : '--');
const jsonSnippet = (input: unknown, length = 160) => {
  if (input === undefined || input === null) return '--';
  try { return JSON.stringify(input).slice(0, length); } catch { return String(input).slice(0, length); }
};

function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) { return <span className={`dot ${tone}`} aria-hidden="true" />; }

function tagTone(status?: string): 'ok' | 'warn' | 'bad' | 'idle' {
  if (!status) return 'idle';
  if (['succeeded', 'running', 'active', 'terminal', 'confirmed', 'current', 'enabled'].includes(status)) return 'ok';
  if (['suspended', 'ambiguous', 'partial', 'accepted', 'unknown', 'pausing', 'stopping', 'idle', 'stale', 'prepared', 'may-have-dispatched', 'verifying', 'recoverable-failure', 'canceling'].includes(status)) return 'warn';
  if (['failed', 'canceled', 'disabled', 'closed'].includes(status)) return 'bad';
  return 'idle';
}
const Tag = ({ status }: { status?: string }) => <span className={`tag ${tagTone(status)}`}>{value(status)}</span>;

function Metric({ label, count, hint }: { label: string; count: number | undefined; hint: string }) {
  return (
    <div className="panel metric">
      <span className="metric-value">{count === undefined ? '--' : count}</span>
      <span className="metric-label">{label}</span>
      <span className="sr-only">{hint}</span>
    </div>
  );
}

function ObservationPanel({ status }: { status?: Status }) {
  const observation = status?.observation;
  const body = status?.body;
  const fields = Object.entries(observation?.fields ?? {});
  return (
    <section className="panel">
      <h2>Observation evidence</h2>
      {!observation ? <p className="empty">No observation. Values are unknown, not zero.</p> : (
        <>
          <div className="kv">
            <div className="kv-row"><span className="kv-key">Source</span><span className="kv-value">{value(observation.source)}</span></div>
            <div className="kv-row"><span className="kv-key">Freshness</span><span className="kv-value"><Tag status={observation.freshness} /></span></div>
            <div className="kv-row"><span className="kv-key">Body contract</span><span className="kv-value">{body ? <Tag status={body.threeDimensional ? 'current' : 'stale'} /> : '--'} {value(body?.mode)}</span></div>
            {body?.threeDimensional ? (
              <>
                <div className="kv-row"><span className="kv-key">World pose x / y / z</span><span className="kv-value">{value(body.x)}, {value(body.y)}, {value(body.z)}</span></div>
                <div className="kv-row"><span className="kv-key">Yaw / pitch</span><span className="kv-value">{value(body.yaw)} / {value(body.pitch)}</span></div>
                <div className="kv-row"><span className="kv-key">Dimension</span><span className="kv-value">{value(body.dimension)}</span></div>
              </>
            ) : (
              <div className="kv-row"><span className="kv-key">Legacy planar position</span><span className="kv-value">{status?.position ? `${value(status.position.x)}, ${value(status.position.y)} (2D, no z)` : '--'}</span></div>
            )}
            <div className="kv-row"><span className="kv-key">Gap</span><span className="kv-value">{observation.gap === undefined ? '--' : observation.gap ? 'gap reported' : 'none'}</span></div>
            <div className="kv-row"><span className="kv-key">Revision</span><span className="kv-value">{value(body?.revision ?? observation.revision)}</span></div>
            <div className="kv-row"><span className="kv-key">Unknown cells</span><span className="kv-value">{value(observation.unknownCells)}</span></div>
            <div className="kv-row"><span className="kv-key">UI / inventory</span><span className="kv-value">{value(status?.ui)} / {value(status?.inventory)}</span></div>
          </div>
          {observation.error && <p className="notice">Observation unavailable: {value(observation.error)}</p>}
          {observation.reason && <p className="notice">Observation reason: {value(observation.reason)}</p>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Field</th><th>Source</th><th>Freshness</th><th>Available</th></tr></thead>
              <tbody>
                {fields.length === 0 ? <tr><td colSpan={4} className="muted">Field evidence not reported (unknown).</td></tr> : fields.map(([name, field]) => (
                  <tr key={name}>
                    <td>{name}</td><td>{value(field.source)}</td><td><Tag status={field.freshness} /></td>
                    <td>{field.available === undefined ? '--' : field.available ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
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
  const [config, setConfig] = useState<Config>();
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [stream, setStream] = useState<StreamState>('connecting');
  const [gap, setGap] = useState<string>();
  const [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview'|'conversation'|'tasks'|'world'|'settings'>('overview');
  const [conversation, setConversation] = useState<Array<{ role: string; text: string; state?: string }>>([]);
  const [lastUpdated, setLastUpdated] = useState<string>();
  const [goalId, setGoalId] = useState('goal-main');
  const [goalText, setGoalText] = useState('Explore the local area and return');
  const [message, setMessage] = useState('Check the surroundings and report status');
  const [selectedExecution, setSelectedExecution] = useState('');
  const [pairingRequired, setPairingRequired] = useState(false);
  const [pairCode, setPairCode] = useState('');
  const [pairError, setPairError] = useState<string>();
  const [streamEpoch, setStreamEpoch] = useState(0);
  const cursor = useRef('0');
  const worldCells = (status?.context as { cells?: Record<string, string> } | undefined)?.cells ?? {};

  const applySnapshot = useCallback((snapshot: Snapshot) => {
    const { capabilities: nextCapabilities, goals: nextGoals, executions: nextExecutions, effects: nextEffects, places: nextPlaces, provider: nextProvider, cursor: nextCursor, ...rest } = snapshot;
    setStatus(rest as Status);
    if (nextCapabilities) setCapabilities(nextCapabilities);
    if (nextGoals) setGoals(nextGoals);
    if (nextExecutions) setExecutions(nextExecutions);
    if (nextEffects) setEffects(nextEffects);
    if (nextPlaces) setPlaces(nextPlaces);
    if (nextProvider) setProvider(nextProvider);
    if (nextCursor) cursor.current = nextCursor;
    setLastUpdated(new Date().toLocaleTimeString());
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextGoals, nextExecutions, nextEffects, nextPlaces, nextCapabilities, nextProvider, nextConfig] = await Promise.all([
        api.status(), api.goals(), api.executions(), api.effects(), api.places(), api.capabilities(), api.provider(), api.config(),
      ]);
      setStatus(nextStatus); setGoals(nextGoals); setExecutions(nextExecutions); setEffects(nextEffects); setPlaces(nextPlaces);
      setCapabilities(nextCapabilities); setProvider(nextProvider); setConfig(nextConfig);
      setError(undefined); setPairingRequired(false); setLastUpdated(new Date().toLocaleTimeString());
    } catch (cause) {
      if (isAuthError(cause)) { setPairingRequired(true); setError(undefined); }
      else setError(cause instanceof Error ? cause.message : 'request failed');
    }
  }, []);

  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 2500); return () => clearInterval(timer); }, [refresh]);

  useEffect(() => {
    const stop = subscribeEvents({
      onEvent: event => {
        cursor.current = event.seq;
        setEvents(previous => [event, ...previous].slice(0, 80));
        // Control/runtime events are followed by a state read; the UI never derives transitions.
        if (event.kind.startsWith('control.') || event.kind.startsWith('runtime.')) void refresh();
      },
      onState: state => setStream(state),
      onSnapshot: snapshot => { applySnapshot(snapshot); setStream('open'); setGap(previous => snapshot.gap ? previous ?? 'snapshot resync after gap' : undefined); },
      onGap: next => { setGap(next.reason ?? 'event gap'); if (next.cursor) cursor.current = next.cursor; void refresh(); },
    }, cursor.current);
    return stop;
  }, [applySnapshot, refresh, streamEpoch]);

  const submitPair = async () => {
    setPairError(undefined);
    try {
      await pair(pairCode.trim());
      setPairingRequired(false); setPairCode(''); setStreamEpoch(previous => previous + 1); await refresh();
    } catch (cause) { setPairError(cause instanceof Error ? cause.message : 'pairing failed'); }
  };

  const run = useCallback(async (command: string, payload: Record<string, unknown>, expectedRevision?: number) => {
    setBusy(true); setFeedback(undefined);
    try {
      const result = await api.command(command, payload, expectedRevision);
      const state = String((result.body as { state?: string }).state ?? (result.status >= 400 ? 'rejected' : 'unknown'));
      if (command === 'message' || command === 'chat') setConversation(previous => [...previous.slice(-40), { role: 'you', text: String(payload.text ?? ''), state }]);
      if (result.status === 401) { setPairingRequired(true); setError('Pairing session required or expired.'); }
      else if (result.status >= 400) setError(String((result.body as { code?: string }).code ?? `http-${result.status}`));
      else { setError(undefined); setFeedback(`${command}: ${state}`); }
      await refresh();
    } catch (cause) {
      if (isAuthError(cause)) setPairingRequired(true);
      else setError(cause instanceof Error ? cause.message : 'command failed');
    } finally { setBusy(false); }
  }, [refresh]);

  const activeGoal = useMemo(() => goals.find(goal => goal.status === 'active' || goal.status === 'paused') ?? goals[0], [goals]);
  const sessionState = status?.session?.state;
  const sessionRecoverable = sessionState === 'recoverable-failure' || sessionState === 'suspended';
  const headline = status?.closed ? 'Closed' : status?.stopping ? 'Stopping' : status?.paused ? 'Paused' : sessionState === 'recoverable-failure' ? 'Recovery required' : status?.state === 'running' ? 'Running' : 'Idle';
  const tone: 'ok' | 'warn' | 'bad' | 'idle' = status?.closed || sessionState === 'recoverable-failure' ? 'bad' : status?.stopping || status?.paused ? 'warn' : status?.state === 'running' ? 'ok' : 'idle';
  const pendingEffects = effects.filter(effect => !['confirmed', 'partial'].includes(effect.status)).length;
  const selected = executions.find(execution => execution.execution_id === selectedExecution);
  const visibleEffects = selectedExecution ? effects.filter(effect => effect.execution_id === selectedExecution) : effects;
  const terminalStatuses = ['succeeded', 'failed', 'canceled'];

  const blocked = status?.closed ? 'Runtime is closed' : status?.stopping ? 'Runtime is stopping' : undefined;
  const actionReasons = {
    goal: busy ? 'A command is in flight' : blocked ?? (!goalId.trim() || !goalText.trim() ? 'Goal id and text are required' : undefined),
    revise: busy ? 'A command is in flight' : blocked ?? (!activeGoal ? 'No active goal to revise' : undefined),
    pause: busy ? 'A command is in flight' : blocked ?? (status?.paused ? 'Runtime is already paused' : undefined),
    resume: busy ? 'A command is in flight' : blocked ?? (!status?.paused && !sessionRecoverable ? 'Runtime is not paused and has no recoverable failure' : undefined),
    recover: busy ? 'A command is in flight' : blocked ?? (!sessionRecoverable ? `No recoverable failure (session: ${value(sessionState)})` : undefined),
    stop: busy ? 'A command is in flight' : blocked,
    save: busy ? 'A command is in flight' : blocked,
    cancel: busy ? 'A command is in flight' : blocked ?? (!selected ? 'Select an execution first' : terminalStatuses.includes(selected.status) ? `Selected execution is already ${selected.status}` : undefined),
    message: busy ? 'A command is in flight' : blocked ?? (!message.trim() ? 'Message text is required' : undefined),
  };
  const unavailable = Object.entries(actionReasons).filter(([, reason]) => reason).map(([action, reason]) => `${action}: ${reason}`);

  return (
    <div className="app">
      <header className="app-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span className="brand-name">FUREVERCRAFT CONTROL</span>
        </div>
        <div className="app-bar-actions">
          <Dot tone={stream === 'open' ? 'ok' : stream === 'error' ? 'bad' : 'idle'} />
          <span className="row-meta">{stream === 'open' ? 'live' : stream === 'error' ? 'stream unavailable' : stream}</span>
          <span className="row-meta">cursor {value(cursor.current)}</span>
          <button onClick={() => void refresh()} disabled={busy}>Refresh</button>
        </div>
      </header>

      {gap && <div className="panel notice" role="status">Event stream gap ({gap}); full state was reloaded. The cursor is {value(cursor.current)}.</div>}
      {error && <div className="panel error" role="alert">Command or read failed: {error}. Values shown as -- are unavailable.</div>}
      {feedback && <div className="panel notice" role="status">{feedback}. The state below was re-read from the service.</div>}

      {pairingRequired && (
        <section className="panel primary pairing" role="dialog" aria-modal="true" aria-labelledby="pair-title">
          <h2 id="pair-title">Pair this browser</h2>
          <p className="hero-explain">The serving Runtime requires a local pairing session. Enter the one-time code printed in its terminal. The session cookie is HttpOnly; the CSRF token is kept in sessionStorage and is never used as a bearer substitute.</p>
          <div className="form pairing-form">
            <label>Pairing code<input value={pairCode} onChange={event => setPairCode(event.target.value)} autoComplete="off" /></label>
            <button className="primary" disabled={!pairCode.trim()} onClick={() => void submitPair()}>Pair</button>
            {pairError && <p className="error" role="alert">{pairError}. Codes are single-use and expire; restart the service to issue a new one.</p>}
          </div>
        </section>
      )}

      <nav className="app-tabs" aria-label="Sections">
        {(['overview','conversation','tasks','world','settings'] as const).map(tab => (
          <button key={tab} className={tab === activeTab ? 'primary' : ''} onClick={() => setActiveTab(tab)} aria-pressed={tab === activeTab}>{tab[0]!.toUpperCase() + tab.slice(1)}</button>
        ))}
      </nav>

      {activeTab === 'overview' && (
        <>
          <div className="grid two">
            <section className="panel primary">
              <h2>Runtime status</h2>
              <div className="hero-status"><Dot tone={tone} /> {headline}</div>
              <p className="hero-explain">{activeGoal?.spec?.text ?? activeGoal?.text ?? 'No active goal. Set one to start autonomous work.'}</p>
              <div className="hero-meta">
                <span>profile {value(capabilities?.profile)}</span>
                <span>provider {value(provider?.provider)}</span>
                <span>session {value(sessionState)} ({value(status?.session?.recoveryAttempts)}/{value(status?.session?.recoveryBudget)})</span>
                <span>updated {value(lastUpdated)}</span>
              </div>
              {sessionRecoverable && <p className="notice">Session needs recovery. Open Conversation and use Recover; normal writes stay refused until it succeeds.</p>}
            </section>
            <ObservationPanel status={status} />
          </div>
          <div className="grid metrics" style={{ marginTop: 16 }}>
            <Metric label="Active goal revision" count={activeGoal?.revision} hint="Current goal revision or unknown" />
            <Metric label="Executions" count={executions.length} hint="Persisted executions or unknown" />
            <Metric label="Non-confirmed effects" count={pendingEffects} hint="Effects not confirmed or partial; ambiguous stays ambiguous" />
            <Metric label="Places" count={places.length} hint="Remembered places in the current scope or unknown" />
          </div>
        </>
      )}

      {activeTab === 'conversation' && (
        <div className="grid two">
          <section className="panel">
            <h2>Goal and control</h2>
            <div className="form">
              <label>Goal id<input value={goalId} onChange={event => setGoalId(event.target.value)} /></label>
              <label>Goal text<textarea rows={2} value={goalText} onChange={event => setGoalText(event.target.value)} /></label>
              <div className="actions">
                <button className="primary" disabled={Boolean(actionReasons.goal)} title={actionReasons.goal ?? 'Set goal'} onClick={() => void run('goal.set', { goalId, text: goalText }, activeGoal && activeGoal.goal_id === goalId ? activeGoal.revision : undefined)}>Set goal</button>
                <button disabled={Boolean(actionReasons.revise)} title={actionReasons.revise ?? 'Revise active goal'} onClick={() => void run('goal.revise', { goalId: activeGoal!.goal_id, expectedRevision: activeGoal!.revision, change: goalText })}>Revise goal</button>
              </div>
              <label>Message to agent<textarea rows={2} value={message} onChange={event => setMessage(event.target.value)} /></label>
              <div className="actions">
                <button disabled={Boolean(actionReasons.message)} title={actionReasons.message ?? 'Send message'} onClick={() => void run('message', { text: message })}>Send message</button>
                <button disabled={Boolean(actionReasons.message)} title={actionReasons.message ?? 'Send game chat'} onClick={() => void run('chat', { text: message })}>Send game chat</button>
              </div>
              <div className="actions">
                <button disabled={Boolean(actionReasons.pause)} title={actionReasons.pause ?? 'Pause'} onClick={() => void run('pause', {})}>Pause</button>
                <button disabled={Boolean(actionReasons.resume)} title={actionReasons.resume ?? 'Resume'} onClick={() => void run('resume', {})}>Resume</button>
                <button disabled={Boolean(actionReasons.recover)} title={actionReasons.recover ?? 'Recover session'} onClick={() => void run('recover', {})}>Recover</button>
                <button disabled={Boolean(actionReasons.save)} title={actionReasons.save ?? 'Save checkpoint'} onClick={() => void run('save', {})}>Save checkpoint</button>
                <button disabled={Boolean(actionReasons.stop)} title={actionReasons.stop ?? 'Stop runtime'} onClick={() => void run('stop', {})}>Stop</button>
              </div>
              {unavailable.length > 0 && <p className="notice">Disabled: {unavailable.join(' · ')}</p>}
            </div>
          </section>
          <section className="panel">
            <h2>Conversation</h2>
            <div className="list">
              {conversation.length === 0 ? <div className="empty">No messages exchanged yet.</div> : conversation.map((entry, index) => (
                <div className="row" key={`${index}-${entry.role}`}>
                  <div className="row-main"><span className="row-id">{entry.role}</span><span className="row-meta">{entry.text}</span></div>
                  <Tag status={entry.state} />
                </div>
              ))}
            </div>
            <h2 style={{ marginTop: 16 }}>Goals</h2>
            <div className="list">
              {goals.length === 0 ? <div className="empty">No goals stored.</div> : goals.map(goal => (
                <div className="row" key={`${goal.goal_id}-${goal.revision}`}>
                  <div className="row-main">
                    <span className="row-id">{goal.goal_id}</span>
                    <span className="row-meta">revision {goal.revision} · {goal.spec?.text ?? goal.text ?? '--'}</span>
                  </div>
                  <Tag status={goal.status} />
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {activeTab === 'tasks' && (
        <div className="grid two">
          <section className="panel">
            <h2>Executions</h2>
            <div className="actions" style={{ marginBottom: 8 }}>
              <label className="inline">Inspect effects<select value={selectedExecution} onChange={event => setSelectedExecution(event.target.value)}>
                <option value="">All effects</option>
                {executions.map(execution => <option key={execution.execution_id} value={execution.execution_id}>{execution.execution_id} ({execution.status})</option>)}
              </select></label>
              <button disabled={Boolean(actionReasons.cancel)} title={actionReasons.cancel ?? 'Cancel selected execution'} onClick={() => void run('cancel', { executionId: selectedExecution })}>Cancel execution</button>
            </div>
            {actionReasons.cancel && selectedExecution && <p className="notice">Cancel unavailable: {actionReasons.cancel}</p>}
            <div className="list">
              {executions.length === 0 ? <div className="empty">No executions yet.</div> : executions.slice(0, 20).map(execution => (
                <div className={`row selectable ${execution.execution_id === selectedExecution ? 'selected' : ''}`} key={execution.execution_id} onClick={() => setSelectedExecution(execution.execution_id)}>
                  <div className="row-main">
                    <span className="row-id">{execution.execution_id}</span>
                    <span className="row-meta">{execution.skill_id} · goal {value(execution.goal_id)} · outcome {value(execution.outcome)}</span>
                    {execution.reason && <span className="row-meta">reason {execution.reason}</span>}
                  </div>
                  <Tag status={execution.status} />
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <h2>Effects</h2>
            <div className="list">
              {visibleEffects.length === 0 ? <div className="empty">No effects recorded. Absence is not confirmation.</div> : visibleEffects.slice(0, 20).map(effect => (
                <div className="row" key={effect.effect_id}>
                  <div className="row-main">
                    <span className="row-id">{effect.effect_id}</span>
                    <span className="row-meta">execution {value(effect.execution_id)} · intent {jsonSnippet(effect.intent)}</span>
                    <span className="row-meta">evidence {jsonSnippet(effect.evidence, 120)}</span>
                  </div>
                  <Tag status={effect.status} />
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {activeTab === 'world' && (
        <div className="grid two">
          <section className="panel">
            <h2>World and observation</h2>
            <WorldCanvas cells={worldCells} />
            <div className="kv" style={{ marginTop: 12 }}>
              <div className="kv-row"><span className="kv-key">Server profile</span><span className="kv-value">{value(status?.context?.serverProfileId)}</span></div>
              <div className="kv-row"><span className="kv-key">Dimension</span><span className="kv-value">{value(status?.context?.dimension)}</span></div>
              <div className="kv-row"><span className="kv-key">World generation</span><span className="kv-value">{value(status?.context?.worldGenerationId)}</span></div>
              <div className="kv-row"><span className="kv-key">Connection / body epoch</span><span className="kv-value">{value(status?.context?.connectionEpoch)} / {value(status?.context?.bodyEpoch)}</span></div>
              <div className="kv-row"><span className="kv-key">Observation source / freshness</span><span className="kv-value">{value(status?.observation?.source)} / {value(status?.observation?.freshness)}</span></div>
            </div>
          </section>
          <section className="panel">
            <h2>Places</h2>
            <div className="list">
              {places.length === 0 ? <div className="empty">No places remembered in this scope. Locations are not inferred.</div> : places.slice(0, 20).map(place => (
                <div className="row" key={`${place.placeId ?? place.place_id}-${String(place.context ?? '')}`}>
                  <div className="row-main">
                    <span className="row-id">{value(place.placeId ?? place.place_id)}</span>
                    <span className="row-meta">freshness {value(place.freshness)} · verified {place.lastVerifiedAt ?? place.last_verified_at ? time(place.lastVerifiedAt ?? place.last_verified_at) : 'never (unknown)'} · payload {jsonSnippet(place.payload, 80)}</span>
                  </div>
                  <Tag status={place.freshness ?? place.status} />
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {activeTab === 'settings' && (
        <div className="grid two">
          <section className="panel">
            <h2>Provider and config</h2>
            <div className="kv">
              <div className="kv-row"><span className="kv-key">Provider</span><span className="kv-value">{value(provider?.provider)}</span></div>
              <div className="kv-row"><span className="kv-key">Model</span><span className="kv-value">{value(provider?.model)}</span></div>
              <div className="kv-row"><span className="kv-key">Network</span><span className="kv-value">{provider?.networkEnabled ? 'enabled' : 'disabled'}</span></div>
              <div className="kv-row"><span className="kv-key">Configured</span><span className="kv-value">{provider?.configured === undefined ? '--' : provider.configured ? 'yes' : 'no'}</span></div>
              <div className="kv-row"><span className="kv-key">Transport</span><span className="kv-value">{value(provider?.transport)}</span></div>
              <div className="kv-row"><span className="kv-key">Profile</span><span className="kv-value">{value(config?.profile ?? capabilities?.profile)}</span></div>
              <div className="kv-row"><span className="kv-key">Browser pairing</span><span className="kv-value">{config?.pairing === undefined ? '--' : config.pairing ? 'required' : 'loopback-open'}</span></div>
              <div className="kv-row"><span className="kv-key">CLI token</span><span className="kv-value">{value(config?.cliAccess)}</span></div>
            </div>
          </section>
          <section className="panel">
            <h2>Capabilities</h2>
            <div className="kv">
              {Object.entries(capabilities?.bridge ?? {}).filter(([key]) => !['limitations', 'source'].includes(key)).map(([key, entry]) => (
                <div className="kv-row" key={key}>
                  <span className="kv-key">{key}</span>
                  <span className="kv-value">{typeof entry === 'boolean' ? <Tag status={entry ? 'enabled' : 'disabled'} /> : value(jsonSnippet(entry, 60))}</span>
                </div>
              ))}
              <div className="kv-row"><span className="kv-key">Skills</span><span className="kv-value">{Array.isArray(capabilities?.skills) ? capabilities.skills.join(', ') || 'none' : value(capabilities?.skills)}</span></div>
              <div className="kv-row"><span className="kv-key">Inputs enabled</span><span className="kv-value">{capabilities?.inputsEnabled === undefined ? '--' : capabilities.inputsEnabled ? 'yes' : 'no'}</span></div>
              <div className="kv-row"><span className="kv-key">Limitations</span><span className="kv-value">{capabilities?.limitations?.length ? capabilities.limitations.join(', ') : 'none reported'}</span></div>
            </div>
          </section>
          <section className="panel">
            <h2>Diagnostics</h2>
            <div className="kv">
              <div className="kv-row"><span className="kv-key">SSE</span><span className="kv-value"><Tag status={stream === 'open' ? 'enabled' : stream === 'error' ? 'failed' : stream} /></span></div>
              <div className="kv-row"><span className="kv-key">Snapshot cursor</span><span className="kv-value">{value(cursor.current)}</span></div>
              <div className="kv-row"><span className="kv-key">Last event gap</span><span className="kv-value">{value(gap)}</span></div>
              <div className="kv-row"><span className="kv-key">Last refresh</span><span className="kv-value">{value(lastUpdated)}</span></div>
            </div>
            <button onClick={() => { setStreamEpoch(previous => previous + 1); setGap(undefined); }}>Reconnect stream</button>
          </section>
        </div>
      )}

      <section className="panel" style={{ marginTop: 16 }}>
        <h2>Event stream {gap ? <span className="tag warn">gap: {gap}</span> : null}</h2>
        <div className="list">
          {events.length === 0 ? <div className="empty">No events received yet.</div> : events.slice(0, 20).map(event => (
            <div className="row" key={`${event.seq}-${event.kind}`}>
              <div className="row-main"><span className="row-id">{event.kind}</span><span className="row-meta">{jsonSnippet(event.payload)}</span></div>
              <span className="row-time">#{event.seq}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className="footer">
        Offline control surface. Values marked -- are unavailable, not zero. Accepted actions are not world-confirmed effects, and ambiguous effects stay ambiguous.
      </footer>
    </div>
  );
}
