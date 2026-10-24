import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RuntimeAssembly } from '../execution/factory.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import { redact } from '../diagnostics/redaction.js';
import { bodyStateView, legacyBodyStateView, type BodyStateView } from '../motor/contracts.js';
import {
  CancelPayloadSchema, ChatPayloadSchema, CommandRequestSchema, GoalRevisePayloadSchema, GoalSetPayloadSchema,
  MessagePayloadSchema, type CommandRequest, type CommandResult, type ProviderMetadata,
} from './dto.js';

const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]))
    : value;

export function canonicalPayloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

const terminal = new Set(['succeeded', 'failed', 'canceled']);
/** Operator lifecycle commands must take effect even while paused; a replay after stop must not unpause. */
const lifecycleCommands = new Set<CommandRequest['command']>(['pause', 'resume', 'stop', 'quit']);

export class ControlService {
  private paused = false;
  private pausing = false;
  private stopping = false;
  private quitting = false;
  private attached?: RuntimeAssembly;
  private readonly inflight = new Set<string>();
  /** AgentLoop runs admitted by non-lifecycle commands; lifecycle commands wait on these only. */
  private readonly activeRuns = new Map<string, Promise<unknown>>();
  private closed = false;
  /** Receipt committer for the command currently executing; only the quit case needs it. */
  private commitFor?: { requestId: string; commit: (result: CommandResult) => CommandResult };
  private committedRequestId?: string;
  /** Aborts every AgentLoop run admitted through this service; replaced after each pause/stop. */
  private abortController = new AbortController();
  constructor(runtime?: RuntimeAssembly, private readonly providerMetadata: ProviderMetadata = { provider: 'unknown', configured: true, transport: 'unknown' }) { this.attached = runtime; }
  attach(runtime: RuntimeAssembly) { this.attached = runtime; }
  private get runtime(): RuntimeAssembly { if (!this.attached) throw new Error('control-not-attached'); return this.attached; }
  get pausedValue() { return this.paused; }
  get stoppingValue() { return this.stopping; }
  get quittingValue() { return this.quitting; }
  get closedValue() { return this.closed; }
  get abortSignal(): AbortSignal { return this.abortController.signal; }

  /** Abort the current run generation; later admitted runs use a fresh, unaborted signal. */
  private abortActive() { if (!this.abortController.signal.aborted) this.abortController.abort(); this.abortController = new AbortController(); }

  /** Abort in-flight AgentLoops and wait (bounded) for their commands to reach a terminal receipt. */
  private async interruptAgentLoops(): Promise<void> { this.abortActive(); await this.settled([...this.activeRuns.values()]); }
  /** Cancel active executions and wait (bounded) for commands that are still canceling them. */
  private async interruptExecutions(): Promise<void> { await this.cancelActiveExecutions(); await this.settled([...this.activeRuns.values()], 1000); }

  private async settled(promises: Promise<unknown>[], timeoutMs = 2000): Promise<void> {
    if (!promises.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled(promises), new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    if (timer) clearTimeout(timer);
  }

  private closeRuntime(): boolean {
    if (this.closed) return true;
    try {
      // runtime.close() performs its synchronous cleanup (unsubscribe, scheduler, store close)
      // and launches async bridge shutdown; the quit receipt is committed on the next microtask,
      // before that shutdown can observe the closed flag.
      const result = this.runtime.close() as unknown;
      if (result && typeof (result as Promise<unknown>).then === 'function') void (result as Promise<unknown>).catch(() => undefined);
      return true;
    } catch { return false; }
  }

  /**
   * Public body state. An attached 3D adapter is authoritative; without one the
   * state is explicitly legacy-2d and planar x/y is never promoted to a 3D pose.
   */
  private bodyState(snapshot?: ReturnType<ClientBridgeCapabilities['snapshot']>): BodyStateView | undefined {
    const adapter = this.runtime.bodyAdapter;
    if (adapter) {
      const observed = bodyStateView(adapter);
      if (observed) return observed;
      // Attached but no synchronous view: report the boundary rather than a legacy fallback.
      return {
        mode: '3d', threeDimensional: true, legacy2d: false,
        dimension: adapter.context.dimension, revision: 'unknown', freshness: 'unknown',
        source: adapter.source, gap: true, context: { ...adapter.context },
      };
    }
    try { return legacyBodyStateView(snapshot ?? this.runtime.bridge.snapshot()); }
    catch { return undefined; }
  }

  status() {
    // After a quit the store is closed; the control surface must still report the stopped state
    // instead of throwing on every status read until the caller shuts the server down.
    if (this.closed) return { state: 'closed', paused: this.paused, stopping: true, closed: true, goal: null, executions: 0, context: { ...this.runtime.bridge.context }, body: this.bodyState(), observation: { source: 'unknown', freshness: 'unknown', gap: true, reason: 'runtime-closed' }, session: { state: 'closed', recoveryAttempts: 0, recoveryBudget: 0 }, position: undefined, inventory: undefined, ui: undefined };
    const goal = this.runtime.store.listGoals().find(item => item.status === 'active' || item.status === 'paused');
    const base = {
      paused: this.paused,
      stopping: this.stopping,
      goal,
      executions: this.runtime.store.listExecutions().length,
      context: { ...this.runtime.bridge.context },
      session: { state: this.runtime.session.state, recoveryAttempts: this.runtime.session.recoveryAttempts, recoveryBudget: this.runtime.session.recoveryBudget },
    };
    let snapshot: ReturnType<typeof this.runtime.bridge.snapshot> | undefined;
    let observationError: string | undefined;
    try { snapshot = this.runtime.bridge.snapshot(); }
    catch (error) { observationError = error instanceof Error ? error.message : String(error); }
    const body = this.bodyState(snapshot);
    if (!snapshot) {
      // A failed observation is unknown, not an empty world. Never turn a read error into cells={}.
      // An attached 3D body is still reported from its own observation, not from the 2D bridge.
      return { ...base, body, state: this.stopping ? 'closing' : this.paused ? 'paused' : this.runtime.session.state, observation: { source: 'unknown', freshness: 'unknown', gap: true, ...(observationError ? { error: redact(observationError) } : {}) }, position: undefined, inventory: undefined, ui: undefined };
    }
    // Expose the observed cells so the top-down view reads real state instead of an absent field.
    return {
      ...base,
      body,
      state: this.stopping ? 'closing' : this.paused ? 'paused' : this.runtime.session.state,
      context: { ...this.runtime.bridge.context, cells: snapshot.cells },
      // Legacy planar position is explicit 2D data; a 3D body reports its pose in `body`.
      position: this.runtime.bodyAdapter ? undefined : snapshot.position,
      inventory: snapshot.inventory,
      ui: snapshot.ui,
      observation: {
        source: snapshot.source,
        freshness: snapshot.freshness,
        gap: snapshot.gap,
        revision: snapshot.revision,
        unknownCells: Object.values(snapshot.cells).filter(cell => cell === 'unknown').length,
        fields: snapshot.fields,
        threeDimensional: Boolean(this.runtime.bodyAdapter),
        mode: this.runtime.bodyAdapter ? '3d' : 'legacy-2d',
      },
    };
  }
  capabilities() {
    const bridge = this.runtime.bridge as { capabilities?: unknown };
    const body = this.bodyState();
    return {
      profile: this.runtime.bridge.context.serverProfileId,
      provider: this.providerMetadata,
      bridge: redact(bridge.capabilities ?? {}),
      skills: this.runtime.router.availableSkills?.() ?? [],
      inputsEnabled: this.runtime.inputsEnabled,
      body: body ? { threeDimensional: body.threeDimensional, mode: body.mode, source: body.source, dimension: body.dimension } : { threeDimensional: false, mode: 'unknown', source: 'unknown', dimension: this.runtime.bridge.context.dimension },
      limitations: [
        ...(this.providerMetadata.transport === 'unavailable' ? ['provider-unavailable'] : []),
        ...(this.runtime.bodyAdapter ? [] : ['legacy-2d-body']),
        ...(this.runtime.bridge.lookAt ? [] : ['look-at-unavailable']),
        ...(this.runtime.bridge.dig ? [] : ['dig-unavailable']),
        ...(this.runtime.bridge.findPlace || this.runtime.bodyAdapter ? [] : ['place-navigation-unavailable']),
      ],
    };
  }
  goals() { return this.runtime.store.listGoals(); }
  executions() { return this.runtime.store.listExecutions(); }
  effects(executionId?: string) { return this.runtime.store.listEffects(executionId); }
  /** Scoped memory query (P20), not an unscoped table dump. */
  places() { return this.runtime.memory.queryPlaces({ scope: this.runtime.memoryScope }).items; }
  events(cursor = '0', limit = 100, filter?: string) { return this.runtime.session.events.read(cursor, limit, filter); }
  /** Current event sequence head; SSE snapshots are labelled with it so snapshot and cursor agree. */
  eventsHead() { return this.runtime.session.events.head(); }
  provider() { return redact(this.providerMetadata); }

  async command(input: unknown): Promise<CommandResult> {
    const parsed = CommandRequestSchema.safeParse(input);
    if (!parsed.success) return { requestId: typeof (input as any)?.requestId === 'string' ? (input as any).requestId : 'invalid', command: 'message', state: 'rejected', code: 'invalid-command', payloadHash: canonicalPayloadHash(input) };
    const request = parsed.data;
    const payloadHash = canonicalPayloadHash({ command: request.command, payload: request.payload, expectedRevision: request.expectedRevision });
    // Once closed the store is gone; refuse every command rather than touching a closed DB.
    if (this.closed) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'runtime-closed', payloadHash };
    const scope = `control:${this.runtime.bridge.context.serverProfileId}`;
    // Atomic claim: a concurrent identical request must not execute twice. The in-flight set
    // closes the read-then-insert race that separate processes/SQLite statements leave open.
    const claimKey = `${scope}:${request.requestId}`;
    if (this.inflight.has(claimKey)) return { requestId: request.requestId, command: request.command, state: 'accepted', code: 'in-flight', payloadHash };
    this.inflight.add(claimKey);
    // Everything between the claim and the durable receipt is synchronous, so a concurrent caller
    // either sees the pending receipt or the in-flight claim, never a second execution.
    const old = this.runtime.store.getActionReceipt(scope, request.requestId);
    if (old) {
      this.inflight.delete(claimKey);
      if (old.payloadHash !== payloadHash) return { requestId: request.requestId, command: request.command, state: 'conflict', code: 'command-payload-conflict', payloadHash };
      const replayState = old.status === 'pending' ? 'accepted' : old.status === 'completed' ? 'terminal' : old.status === 'conflict' ? 'conflict' : old.status === 'rejected' ? 'rejected' : 'unknown';
      // While stopping, a durable non-terminal command must not replay as accepted: nothing will
      // progress it and accepted would imply work is still happening.
      if (this.stopping && !lifecycleCommands.has(request.command) && replayState !== 'terminal') return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'stopping', payloadHash };
      return { requestId: request.requestId, command: request.command, state: replayState, result: old.result, payloadHash };
    }
    try { this.runtime.store.addActionReceipt({ receiptId: request.requestId, scope, commandId: request.requestId, status: 'pending', payloadHash }); }
    catch { this.inflight.delete(claimKey); return { requestId: request.requestId, command: request.command, state: 'accepted', code: 'in-flight', payloadHash }; }
    const execution = this.execute(request);
    const settledRun = execution.then(() => undefined, () => undefined);
    this.activeRuns.set(request.requestId, settledRun);
    const commit = (result: CommandResult) => {
      const state = result.state;
      // Conflict/rejected are decisions, not terminal success: persisting them as completed would replay a false terminal.
      const receiptStatus = state === 'accepted' ? 'pending' : state === 'unknown' ? 'unknown' : state === 'terminal' ? 'completed' : state === 'conflict' ? 'conflict' : 'rejected';
      const bare = { ...result, requestId: request.requestId, command: request.command, payloadHash };
      // A quit commits its own receipt before closing the runtime (see the quit case), so the
      // store is only closed here when that commit already happened.
      if (this.committedRequestId === request.requestId) return bare;
      try { this.runtime.store.updateActionReceipt(scope, request.requestId, receiptStatus, result.result); }
      catch { return bare; /* runtime already closed: the close is the acknowledgement */ }
      this.runtime.session.events.publish(`control.${request.command}`, { requestId: request.requestId, state, result: result.result }, true);
      return bare;
    };
    this.commitFor = { requestId: request.requestId, commit };
    try {
      const result = await execution;
      return commit(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An abort is the operator's pause/stop taking effect, not a client error.
      const code = (this.stopping || this.pausing) && message === 'The operation was aborted' ? 'stopping' : message;
      return commit({ requestId: request.requestId, command: request.command, state: code.startsWith('goal-revision-conflict') ? 'conflict' : 'rejected', code, payloadHash });
    } finally {
      if (this.commitFor?.requestId === request.requestId) this.commitFor = undefined;
      // Delete only this run's entry: a newer run for the same requestId may already be registered.
      if (this.activeRuns.get(request.requestId) === settledRun) this.activeRuns.delete(request.requestId);
      this.inflight.delete(claimKey);
    }
  }

  private async execute(request: CommandRequest): Promise<CommandResult> {
    const payload = request.payload;
    switch (request.command) {
      case 'goal.set': { const p = GoalSetPayloadSchema.parse(payload); const current = this.runtime.store.getGoal(p.goalId); const revision = current ? current.revision + 1 : 1; if (request.expectedRevision !== undefined && (current?.revision ?? 0) !== request.expectedRevision) throw new Error(`goal-revision-conflict:${current?.revision ?? 0}`); this.runtime.store.saveGoal({ goalId: p.goalId, revision, status: p.status ?? 'active', text: p.text, context: this.runtime.bridge.context }); return { requestId: request.requestId, command: request.command, state: 'terminal', result: this.runtime.store.getGoal(p.goalId), payloadHash: '' }; }
      case 'goal.revise': { const p = GoalRevisePayloadSchema.parse(payload); const result = this.runtime.store.reviseGoal(p.goalId, p.expectedRevision ?? request.expectedRevision ?? 0, p.change); return { requestId: request.requestId, command: request.command, state: 'terminal', result, payloadHash: '' }; }
      case 'message': { const p = MessagePayloadSchema.parse(payload); if (this.paused) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'paused', result: { queued: false }, payloadHash: '' }; const run = await this.runtime.loop.run([{ role: 'user', content: p.text }], undefined, this.abortSignal, { goalId: p.goalId, goalRevision: p.goalRevision, store: this.runtime.store, owner: this.runtime.ownerId }); if (this.stopping) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'stopping', result: { queued: false }, payloadHash: '' }; if (run.response.stopReason === 'goal-revision-conflict') return { requestId: request.requestId, command: request.command, state: 'conflict', code: 'goal-revision-conflict', result: run, payloadHash: '' }; return { requestId: request.requestId, command: request.command, state: 'terminal', result: run, payloadHash: '' }; }
      case 'chat': { const p = ChatPayloadSchema.parse(payload); if (this.paused) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'paused', payloadHash: '' }; const result = await this.runtime.router.invoke({ id: request.requestId, name: 'send_chat', arguments: JSON.stringify({ text: p.text }) }, { signal: this.abortSignal, owner: this.runtime.ownerId }); if (this.stopping) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'stopping', result, payloadHash: '' }; return { requestId: request.requestId, command: request.command, state: result.ok ? 'terminal' : 'unknown', result, payloadHash: '' }; }
      case 'pause': {
        // Abort first so the pausing event precedes any command receipt that reflects the abort.
        this.abortActive(); this.paused = true; this.stopping = false; this.pausing = true;
        // Pause reaches the real scheduler and skill lifecycle, not just a control flag.
        try { this.runtime.scheduler.pause(); } catch { /* scheduler already stopped */ }
        try { this.runtime.lifecycle.humanControl('pause'); } catch { /* lifecycle already terminal */ }
        try {
          // Abort the runs that already started and cancel their executions so paused means every
          // in-flight write has stopped, not merely that new ones are refused.
          await this.settled([...this.activeRuns.values()]); await this.interruptExecutions();
        } finally { this.pausing = false; }
        this.runtime.session.events.publish('runtime.pausing', {}, true); return { requestId: request.requestId, command: request.command, state: 'terminal', result: { paused: true }, payloadHash: '' };
      }
      case 'resume': {
        // A stop/quit that already landed wins: resume must not clear the paused/stopping state.
        if (this.closed || this.stopping || this.quitting) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'stopping', result: { paused: true, stopping: true }, payloadHash: '' };
        // Resume is a fresh admission decision. If the previous session failed, re-verify it
        // through the session recovery path rather than claiming the runtime is healthy.
        if (this.runtime.session.state === 'recoverable-failure' || this.runtime.session.state === 'suspended') {
          try { this.runtime.session.recover(); }
          catch (error) { return { requestId: request.requestId, command: request.command, state: 'rejected', code: error instanceof Error ? error.message : String(error), result: { paused: true, session: this.runtime.session.state }, payloadHash: '' }; }
        }
        this.runtime.scheduler.resume();
        this.paused = false; this.pausing = false;
        return { requestId: request.requestId, command: request.command, state: 'terminal', result: { paused: false, session: this.runtime.session.state, schedulerPaused: this.runtime.scheduler.pausedValue }, payloadHash: '' };
      }
      case 'recover': {
        if (this.closed || this.stopping || this.quitting) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'stopping', payloadHash: '' };
        // Recovery is deliberately explicit: it re-observes the body and reconciles pending
        // effects through the session's bounded budget. It never fabricates a successful state.
        try {
          const result = this.runtime.session.recover();
          return { requestId: request.requestId, command: request.command, state: 'terminal', result, payloadHash: '' };
        } catch (error) {
          return { requestId: request.requestId, command: request.command, state: 'rejected', code: error instanceof Error ? error.message : String(error), result: { session: this.runtime.session.state, attempts: this.runtime.session.recoveryAttempts, budget: this.runtime.session.recoveryBudget }, payloadHash: '' };
        }
      }
      case 'stop': {
        if (this.stopping) { const canceled = await this.cancelActiveExecutions(); const body = await this.releaseBody(); return { requestId: request.requestId, command: request.command, state: 'accepted', result: { stopping: true, canceled, body }, payloadHash: '' }; }
        this.abortActive(); this.stopping = true; this.paused = true; this.runtime.scheduler.close(); this.runtime.lifecycle.humanControl('stop');
        // Capture what was in flight: the aborted message receipt settles before the stop event is published.
        await this.settled([...this.activeRuns.values()]);
        const canceled = await this.cancelActiveExecutions(); const body = await this.releaseBody();
        this.runtime.session.events.publish('runtime.stopping', { reason: 'stop', canceled, body }, true); return { requestId: request.requestId, command: request.command, state: 'accepted', result: { stopping: true, canceled, body }, payloadHash: '' };
      }
      case 'cancel': { const p = CancelPayloadSchema.parse(payload); const execution = this.runtime.store.getExecution(p.executionId); if (!execution) return { requestId: request.requestId, command: request.command, state: 'unknown', code: 'execution-not-found', payloadHash: '' }; const invoke = await this.runtime.router.invoke({ id: request.requestId, name: 'cancel_execution', arguments: JSON.stringify(p) }); const after = this.runtime.store.getExecution(p.executionId); return { requestId: request.requestId, command: request.command, state: terminal.has(after?.status ?? '') ? 'terminal' : invoke.ok ? 'accepted' : 'unknown', code: invoke.ok ? undefined : invoke.error, result: after, payloadHash: '' }; }
      case 'save': { const checkpoint = { checkpointId: `runtime-${this.runtime.clock.now()}`, executionId: 'runtime', revision: (this.runtime.store.getLatestCheckpoint('runtime')?.revision ?? 0) + 1, payload: this.status() }; this.runtime.store.saveCheckpoint(checkpoint); return { requestId: request.requestId, command: request.command, state: 'terminal', result: checkpoint, payloadHash: '' }; }
      case 'quit': {
        this.abortActive(); this.quitting = true; this.stopping = true; this.paused = true; this.runtime.scheduler.close(); this.runtime.lifecycle.humanControl('quit');
        await this.settled([...this.activeRuns.values()]);
        const canceled = await this.cancelActiveExecutions(); const body = await this.releaseBody();
        this.runtime.session.events.publish('runtime.shutdown-requested', { canceled, body }, true);
        // The quit decision is committed before close() so its receipt and control event stay
        // durable; command() returns this same result without committing again.
        const result: CommandResult = { requestId: request.requestId, command: request.command, state: 'accepted', result: { stopping: true, canceled, body, closed: true }, payloadHash: '' };
        // The quit decision and its control event are durable before close so a replayed read
        // after restart sees a terminal receipt, not a pending one.
        const scope = `control:${this.runtime.bridge.context.serverProfileId}`;
        try { this.runtime.store.updateActionReceipt(scope, request.requestId, 'completed', result.result); } catch { /* store may already be unavailable */ }
        this.runtime.session.events.publish('control.quit', { requestId: request.requestId, state: 'accepted', result: result.result }, true);
        this.committedRequestId = request.requestId;
        const closed = this.closeRuntime(); this.closed = true;
        return { ...result, result: { stopping: true, canceled, body, closed } };
      }
    }
  }

  /** Best-effort release of held body inputs; failures are reported, not thrown. */
  private async releaseBody(): Promise<{ released: boolean; error?: string }> {
    const bridge = this.runtime.bridge as { releaseOwnedInputs?: () => Promise<unknown> | unknown; stopBody?: () => Promise<unknown> | unknown };
    try {
      if (typeof bridge.releaseOwnedInputs === 'function') await bridge.releaseOwnedInputs();
      else if (typeof bridge.stopBody === 'function') await bridge.stopBody();
      return { released: true };
    } catch (error) { return { released: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  /** Best-effort stop of every non-terminal execution; failures are reported, not thrown. */
  private async cancelActiveExecutions(): Promise<string[]> {
    const canceled: string[] = [];
    for (const execution of this.runtime.store.listExecutions()) {
      if (terminal.has(execution.status)) continue;
      try { await this.runtime.router.invoke({ id: `stop-${execution.executionId}`, name: 'cancel_execution', arguments: JSON.stringify({ executionId: execution.executionId }) }); canceled.push(execution.executionId); }
      catch { /* best-effort: continue stopping the remaining executions */ }
    }
    return canceled;
  }
}

export type { CommandRequest };
export { CommandRequestSchema };
