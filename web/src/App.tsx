import { displayCount, sessionPresentation, toneForStatus } from './presentation';
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
    if (entries.length === 0) { ctx.fillStyle = '#5e7187'; ctx.font = '12px Inter, system-ui'; ctx.fillText('No local cells observed (unknown)', 12, 24); return; }
    const size = Math.max(6, Math.floor(Math.min(canvas.width, canvas.height) / 24));
    entries.slice(0, 24 * 24).forEach(([key, value]) => {
      const [x, y] = key.split(',').map(Number) as [number, number];
      ctx.fillStyle = value === 'blocked' ? '#0b2142' : value === 'free' ? '#2bbd79' : '#f1b743';
      ctx.fillRect((x % 24) * size, (y % 24) * size, size - 1, size - 1);
    });
  });
  return <canvas ref={ref} width={288} height={288} aria-label="Top-down local world view" role="img" />;
}

const value = (input: unknown) => (input === undefined || input === null || input === '' ? '—' : String(input));
const time = (iso?: string) => (iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleTimeString() : '—');
const jsonSnippet = (input: unknown, length = 160) => {
  if (input === undefined || input === null) return '—';
  try { return JSON.stringify(input).slice(0, length); } catch { return String(input).slice(0, length); }
};

function Dot({ tone }: { tone: 'ok' | 'warn' | 'bad' | 'idle' }) { return <span className={`dot ${tone}`} aria-hidden="true" />; }

const Tag = ({ status }: { status?: string }) => <span className={`tag ${toneForStatus(status)}`}>{value(status)}</span>;

function Metric({ label, count, hint }: { label: string; count: number | undefined; hint: string }) {
  return (
    <div className="panel metric">
      <span className="metric-value">{count === undefined ? '—' : count}</span>
      <span className="metric-label">{label}</span>
      <span className="metric-hint">{hint}</span>
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
            <div className="kv-row"><span className="kv-key">Body contract</span><span className="kv-value">{body ? <Tag status={body.threeDimensional ? 'current' : 'stale'} /> : '—'} {value(body?.mode)}</span></div>
            {body?.threeDimensional ? (
              <>
                <div className="kv-row"><span className="kv-key">World pose x / y / z</span><span className="kv-value">{value(body.x)}, {value(body.y)}, {value(body.z)}</span></div>
                <div className="kv-row"><span className="kv-key">Yaw / pitch</span><span className="kv-value">{value(body.yaw)} / {value(body.pitch)}</span></div>
                <div className="kv-row"><span className="kv-key">Dimension</span><span className="kv-value">{value(body.dimension)}</span></div>
              </>
            ) : (
              <div className="kv-row"><span className="kv-key">Legacy planar position</span><span className="kv-value">{status?.position ? `${value(status.position.x)}, ${value(status.position.y)} (2D, no z)` : '—'}</span></div>
            )}
            <div className="kv-row"><span className="kv-key">Gap</span><span className="kv-value">{observation.gap === undefined ? '—' : observation.gap ? 'gap reported' : 'none'}</span></div>
            <div className="kv-row"><span className="kv-key">Revision</span><span className="kv-value">{value(body?.revision ?? observation.revision)}</span></div>
            <div className="kv-row"><span className="kv-key">Unknown cells</span><span className="kv-value">{value(observation.unknownCells)}</span></div>
            <div className="kv-row"><span className="kv-key">UI / inventory</span><span className="kv-value">{value(status?.ui)} / {value(status?.inventory)}</span></div>
          </div>
          {observation.error && <p className="notice">Observation could not be read.</p>}
          {observation.reason && <p className="notice">Some observation fields are unavailable. Check Diagnostics for status.</p>}
          <details className="evidence-details"><summary>Field evidence · {fields.length} fields</summary><div className="table-wrap">
            <table>
              <thead><tr><th>Field</th><th>Source</th><th>Freshness</th><th>Available</th></tr></thead>
              <tbody>
                {fields.length === 0 ? <tr><td colSpan={4} className="muted">Field evidence not reported (unknown).</td></tr> : fields.map(([name, field]) => (
                  <tr key={name}>
                    <td>{name}</td><td>{value(field.source)}</td><td><Tag status={field.freshness} /></td>
                    <td>{field.available === undefined ? '—' : field.available ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div></details>
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
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const [loaded, setLoaded] = useState({ goals: false, executions: false, effects: false, places: false });
  const [confirmStop, setConfirmStop] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview'|'conversation'|'tasks'|'world'|'settings'>('overview');
  const [conversation, setConversation] = useState<Array<{ role: string; text: string; state?: string }>>([]);
  const [lastUpdated, setLastUpdated] = useState<string>();
  const [goalId, setGoalId] = useState('goal-main');
  const [goalText, setGoalText] = useState('');
  const [message, setMessage] = useState('');
  const [selectedExecution, setSelectedExecution] = useState('');
  const [pairingRequired, setPairingRequired] = useState(false);
  const [pairCode, setPairCode] = useState('');
  const [pairError, setPairError] = useState<string>();
  const [streamEpoch, setStreamEpoch] = useState(0);
  const cursor = useRef('0');
  const worldCells = (status?.context as { cells?: Record<string, string> } | undefined)?.cells ?? {};

  /** SSE frames may arrive out of order after a replay/reset; the client cursor never rewinds. */
  const advanceCursor = useCallback((next?: string) => {
    if (!next || !/^\d+$/.test(next)) return;
    const current = cursor.current;
    if (!/^\d+$/.test(current)) { cursor.current = next; return; }
    try { if (BigInt(next) >= BigInt(current)) cursor.current = next; } catch { /* keep current */ }
  }, []);

  const applySnapshot = useCallback((snapshot: Snapshot) => {
    const { capabilities: nextCapabilities, goals: nextGoals, executions: nextExecutions, effects: nextEffects, places: nextPlaces, provider: nextProvider, cursor: nextCursor, ...rest } = snapshot;
    setStatus(rest as Status);
    if (nextCapabilities) setCapabilities(nextCapabilities);
    if (nextGoals) setGoals(nextGoals);
    if (nextExecutions) setExecutions(nextExecutions);
    if (nextEffects) setEffects(nextEffects);
    if (nextPlaces) setPlaces(nextPlaces);
    if (nextProvider) setProvider(nextProvider);
    setLoaded(previous => ({ goals: previous.goals || nextGoals !== undefined, executions: previous.executions || nextExecutions !== undefined, effects: previous.effects || nextEffects !== undefined, places: previous.places || nextPlaces !== undefined }));
    advanceCursor(nextCursor);
    setLastUpdated(new Date().toLocaleTimeString());
  }, [advanceCursor]);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true; setRefreshing(true);
    try {
      const [nextStatus, nextGoals, nextExecutions, nextEffectsPage, nextPlaces, nextCapabilities, nextProvider, nextConfig] = await Promise.all([
        api.status(), api.goals(), api.executions(), api.effects(undefined, 100), api.places(), api.capabilities(), api.provider(), api.config(),
      ]);
      setLoaded({ goals: true, executions: true, effects: true, places: true });
      setStatus(nextStatus); setGoals(nextGoals); setExecutions(nextExecutions); setEffects(nextEffectsPage.items); setPlaces(nextPlaces);
      setCapabilities(nextCapabilities); setProvider(nextProvider); setConfig(nextConfig);
      setError(undefined); setPairingRequired(false); setLastUpdated(new Date().toLocaleTimeString());
    } catch (cause) {
      if (isAuthError(cause)) { setPairingRequired(true); setError(undefined); }
      else setError('The latest data could not be read. Previously loaded values may be out of date.');
    } finally { refreshingRef.current = false; setRefreshing(false); }
  }, []);

  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 2500); return () => clearInterval(timer); }, [refresh]);

  useEffect(() => {
    const stop = subscribeEvents({
      onEvent: event => {
        advanceCursor(event.seq);
        setEvents(previous => [event, ...previous].slice(0, 80));
        // Control/runtime events are followed by a state read; the UI never derives transitions.
        if (event.kind.startsWith('control.') || event.kind.startsWith('runtime.')) void refresh();
      },
      onState: state => setStream(state),
      onSnapshot: snapshot => { applySnapshot(snapshot); setStream('open'); setGap(previous => snapshot.gap ? previous ?? 'snapshot resync after gap' : undefined); },
      onGap: next => { setGap(next.reason ?? 'event gap'); advanceCursor(next.cursor ?? next.head); void refresh(); },
    }, cursor.current);
    return stop;
  }, [advanceCursor, applySnapshot, refresh, streamEpoch]);

  const submitPair = async () => {
    setPairError(undefined);
    try {
      await pair(pairCode.trim());
      setPairingRequired(false); setPairCode(''); setStreamEpoch(previous => previous + 1); await refresh();
    } catch (cause) { setPairError('Pairing could not be completed'); }
  };

  const run = useCallback(async (command: string, payload: Record<string, unknown>, expectedRevision?: number) => {
    setBusy(true); setFeedback(undefined);
    try {
      const result = await api.command(command, payload, expectedRevision);
      const state = String((result.body as { state?: string }).state ?? (result.status >= 400 ? 'rejected' : 'unknown'));
      if (command === 'message' || command === 'chat') setConversation(previous => [...previous.slice(-40), { role: 'you', text: String(payload.text ?? ''), state }]);
      if (result.status === 401) { setPairingRequired(true); setError('Pairing session required or expired.'); }
      else if (result.status >= 400) setError('This action could not be completed. Check the current state and try again.');
      else { setError(undefined); setFeedback(`${command}: ${state}`); }
      await refresh();
    } catch (cause) {
      if (isAuthError(cause)) setPairingRequired(true);
      else setError('The action could not be completed. Check your connection and try again.');
    } finally { setBusy(false); }
  }, [refresh]);

  const activeGoal = useMemo(() => goals.find(goal => goal.status === 'active' || goal.status === 'paused') ?? goals[0], [goals]);
  const sessionState = status?.session?.state;
  const sessionRecoverable = sessionState === 'recoverable-failure' || sessionState === 'suspended';
  const { headline, tone } = sessionPresentation({ available: status !== undefined, pairingRequired, readFailed: Boolean(error), closed: status?.closed, stopping: status?.stopping, paused: status?.paused, sessionState, state: status?.state });
  const pendingEffects = effects.filter(effect => !['confirmed', 'partial'].includes(effect.status)).length;
  const selected = executions.find(execution => execution.execution_id === selectedExecution);
  const visibleEffects = selectedExecution ? effects.filter(effect => effect.execution_id === selectedExecution) : effects;
  const terminalStatuses = ['succeeded', 'failed', 'canceled'];

  const blocked = pairingRequired ? 'Pair this browser first' : !status || error ? 'Current status is unavailable' : status?.closed ? 'Runtime is closed' : status?.stopping ? 'Runtime is stopping' : undefined;
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

  const sectionCopy = {
    overview: ['Player overview', 'Goals, activity and observations in one place.'],
    conversation: ['Goals & conversation', 'Set a direction and stay in touch with your player.'],
    tasks: ['Tasks & effects', 'Follow execution progress and inspect the recorded results.'],
    world: ['World & places', 'Review observed surroundings and remembered locations.'],
    settings: ['Settings & capabilities', 'Check configured services and available capabilities.'],
  }[activeTab];
  return (
    <div className="app">
      <a className="skip-link" href="#workspace">Skip to workspace</a>
      <header className="app-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">F</span>
          <span className="brand-lockup"><span className="brand-name">FUREVERCRAFT</span><span className="brand-caption">PLAYER CONTROL</span></span>
        </div>
        <div className="app-bar-actions">
          <Dot tone={stream === 'open' ? 'ok' : stream === 'error' ? 'bad' : 'idle'} />
          <span className="row-meta">{stream === 'open' ? 'live' : stream === 'error' ? 'stream unavailable' : stream}</span>
          <span className="row-meta stream-cursor">cursor {value(cursor.current)}</span>
          <button className="refresh-button" aria-label="Refresh" aria-busy={refreshing} onClick={() => void refresh()} disabled={busy || refreshing}><span className={refreshing ? "refresh-icon spinning" : "refresh-icon"} aria-hidden="true">↻</span>Refresh</button>
        </div>
      </header>

      <div className="workspace-heading">
        <div><p className="eyebrow">WORKSPACE</p><h1>{sectionCopy[0]}</h1><p className="page-description">{sectionCopy[1]}</p></div>
        <span className="workspace-context"><span className="context-dot" />{value(capabilities?.profile)}<span className="context-divider">/</span>{value(provider?.provider)}</span>
      </div>

      {gap && <div className="panel notice" role="status">Event stream gap ({gap}); full state was reloaded. The cursor is {value(cursor.current)}.</div>}
      {error && <div className="panel error" role="alert">Command or read failed: {error}. Unavailable values are shown as —.</div>}
      {feedback && <div className="panel notice" role="status">{feedback}. The state below was re-read from the service.</div>}

      {pairingRequired && (
        <section className="panel primary pairing" role="dialog" aria-modal="false" aria-labelledby="pair-title">
          <h2 id="pair-title">Pair this browser</h2>
          <p className="hero-explain">Enter the one-time code shown in the running service’s terminal to connect this browser.</p>
          <div className="form pairing-form">
            <label>Pairing code<input type="password" autoFocus aria-invalid={Boolean(pairError)} value={pairCode} onChange={event => setPairCode(event.target.value)} autoComplete="off" /></label>
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

      <main id="workspace" tabIndex={-1}>
      {activeTab === 'overview' && (
        <>
          <div className="grid two overview-grid">
            <section className="panel primary hero-panel">
              <div className="section-heading"><h2>Runtime status</h2><span className="tag">{status ? "Latest snapshot" : "No data yet"}</span></div>
              <div className="hero-status" role="status"><Dot tone={tone} /> {headline}</div>
              <p className="hero-explain">{activeGoal?.spec?.text ?? activeGoal?.text ?? (status ? 'No active goal. Set one in Conversation when you are ready.' : 'Waiting for a current snapshot from the service.')}</p>
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
            <Metric label="Active goal revision" count={activeGoal?.revision} hint="Current goal version" />
            <Metric label="Executions" count={displayCount(loaded.executions, executions.length)} hint="Recorded skill runs" />
            <Metric label="Non-confirmed effects" count={displayCount(loaded.effects, pendingEffects)} hint="Results awaiting confirmation" />
            <Metric label="Places" count={displayCount(loaded.places, places.length)} hint="Locations in this world" />
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
                <button className="danger-quiet" disabled={Boolean(actionReasons.stop)} title={actionReasons.stop ?? 'Stop runtime'} onClick={() => setConfirmStop(true)}>Stop</button>
              </div>
              {confirmStop && <div className="confirmation" role="group" aria-label="Confirm stop">
                <p>Stop autonomous work? Actions already sent to the game cannot be undone.</p>
                <div className="actions"><button className="danger" disabled={busy} onClick={() => { setConfirmStop(false); void run('stop', {}); }}>Confirm stop</button><button onClick={() => setConfirmStop(false)}>Keep working</button></div>
              </div>}
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
              {goals.length === 0 ? <div className="empty">{loaded.goals ? 'No goals stored.' : 'Waiting for goal records.'}</div> : goals.map(goal => (
                <div className="row" key={`${goal.goal_id}-${goal.revision}`}>
                  <div className="row-main">
                    <span className="row-id">{goal.goal_id}</span>
                    <span className="row-meta">revision {goal.revision} · {goal.spec?.text ?? goal.text ?? '—'}</span>
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
              {executions.length === 0 ? <div className="empty">{loaded.executions ? 'No executions yet.' : 'Waiting for execution records.'}</div> : executions.slice(0, 20).map(execution => (
                <div className={`row selectable ${execution.execution_id === selectedExecution ? 'selected' : ''}`} role="button" tabIndex={0} aria-pressed={execution.execution_id === selectedExecution} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedExecution(execution.execution_id); } }} key={execution.execution_id} onClick={() => setSelectedExecution(execution.execution_id)}>
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
              {visibleEffects.length === 0 ? <div className="empty">{loaded.effects ? 'No effects recorded. Absence is not confirmation.' : 'Waiting for effect records.'}</div> : visibleEffects.slice(0, 20).map(effect => (
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
              {places.length === 0 ? <div className="empty">{loaded.places ? 'No places remembered in this scope.' : 'Waiting for remembered places.'}</div> : places.slice(0, 20).map(place => (
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
              <div className="kv-row"><span className="kv-key">Network</span><span className="kv-value">{provider?.networkEnabled === undefined ? '—' : provider.networkEnabled ? 'enabled' : 'disabled'}</span></div>
              <div className="kv-row"><span className="kv-key">Configured</span><span className="kv-value">{provider?.configured === undefined ? '—' : provider.configured ? 'yes' : 'no'}</span></div>
              <div className="kv-row"><span className="kv-key">Transport</span><span className="kv-value">{value(provider?.transport)}</span></div>
              <div className="kv-row"><span className="kv-key">Profile</span><span className="kv-value">{value(config?.profile ?? capabilities?.profile)}</span></div>
              <div className="kv-row"><span className="kv-key">Browser pairing</span><span className="kv-value">{config?.pairing === undefined ? '—' : config.pairing ? 'required' : 'loopback-open'}</span></div>
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
              <div className="kv-row"><span className="kv-key">Inputs enabled</span><span className="kv-value">{capabilities?.inputsEnabled === undefined ? '—' : capabilities.inputsEnabled ? 'yes' : 'no'}</span></div>
              <div className="kv-row"><span className="kv-key">Limitations</span><span className="kv-value">{capabilities?.limitations === undefined ? '—' : capabilities.limitations.length ? capabilities.limitations.join(', ') : 'none reported'}</span></div>
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

      </main>
      <footer className="footer">
        FurEverCraft · Local player workspace. — means unavailable. Accepted actions are not confirmed game results.
      </footer>
    </div>
  );
}
