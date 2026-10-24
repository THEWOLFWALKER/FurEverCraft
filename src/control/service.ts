import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RuntimeAssembly } from '../execution/factory.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import { redact } from '../diagnostics/redaction.js';
import { collectDoctorReport, type DoctorOptions, type DoctorReport } from '../diagnostics/doctor.js';
import { bodyStateView, legacyBodyStateView, type BodyStateView } from '../motor/contracts.js';
import { sameStableScope, stableScopeKey, stableScopeOf, type StableScope } from '../persistence/store.js';
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

/**
 * Receipt scope for command idempotency. World generation and dimension are part of the stable
 * identity, so reusing a requestId after a world/dimension change executes the command again
 * against the new scope instead of replaying the old terminal receipt. Connection/body epochs
 * are intentionally excluded: a reconnect to the same world must still replay the receipt.
 */
export function commandScopeOf(context: unknown): string {
  const scope = stableScopeOf(context) ?? ({ serverProfileId: 'unknown' } satisfies StableScope);
  return `control:${stableScopeKey(scope)}`;
}

const terminal = new Set(['succeeded', 'failed', 'canceled']);
/** Operator lifecycle commands must take effect even while paused; a replay after stop must not unpause. */
const lifecycleCommands = new Set<CommandRequest['command']>(['pause', 'resume', 'stop', 'quit']);
/** Provider stop reasons that represent a complete, successful answer. */
const providerSuccessStops = new Set(['stop', 'end_turn', 'stop_sequence']);
type ProviderStopFailure = { state: 'unknown' | 'rejected'; code: string };
/** Map a non-success stop reason to an explicit uncertain/rejected receipt instead of terminal. */
function providerStopFailure(stopReason: unknown): ProviderStopFailure | undefined {
  if (typeof stopReason !== 'string' || providerSuccessStops.has(stopReason)) return undefined;
  if (stopReason === 'unavailable') return { state: 'unknown', code: 'provider-unavailable' };
  if (stopReason === 'cancel' || stopReason === 'canceled' || stopReason === 'cancelled' || stopReason === 'aborted') return { state: 'rejected', code: 'provider-canceled' };
  if (stopReason === 'length' || stopReason === 'max_tokens') return { state: 'rejected', code: 'provider-response-truncated' };
  if (stopReason === 'max_turns') return { state: 'rejected', code: 'provider-max-turns' };
  return { state: 'rejected', code: `provider-unexpected-stop:${stopReason}` };
}
type CancelFailure = { executionId: string; error: string };
type CancelReport = {
  /** Executions observed in a terminal canceled state after the cancel request. */
  canceled: string[];
  /** Cancel requests that errored or settled in another terminal state. */
  failed: CancelFailure[];
  /** Non-terminal executions whose cancellation is still in progress or unconfirmed. */
  cancelRequested: CancelFailure[];
  /** Every execution id a release attempt should cover (internal, not part of the receipt). */
  attempted: string[];
};

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
      const unknownView = (): BodyStateView => ({
        mode: '3d', threeDimensional: true, legacy2d: false,
        dimension: adapter.context.dimension, revision: 'unknown', freshness: 'unknown',
        source: adapter.source, gap: true, context: { ...adapter.context },
      });
      try {
        const observed = bodyStateView(adapter);
        if (observed) return observed;
      } catch {
        // A throwing peek is an unknown body, not a failed control-plane read.
        return unknownView();
      }
      // Attached but no synchronous view: report the boundary rather than a legacy fallback.
      return unknownView();
    }
    try { return legacyBodyStateView(snapshot ?? this.runtime.bridge.snapshot()); }
    catch { return undefined; }
  }

  status() {
    // After a quit the store is closed; the control surface must still report the stopped state
    // instead of throwing on every status read until the caller shuts the server down.
    if (this.closed) return { state: 'closed', paused: this.paused, stopping: true, closed: true, goal: null, executions: 0, context: { ...this.runtime.bridge.context }, body: this.bodyState(), observation: { source: 'unknown', freshness: 'unknown', gap: true, reason: 'runtime-closed' }, session: { state: 'closed', recoveryAttempts: 0, recoveryBudget: 0 }, position: undefined, inventory: undefined, ui: undefined };
    const goal = this.runtime.store.findGoalForScope(this.runtime.memoryScope, ['active', 'paused']);
    const base = {
      paused: this.paused,
      stopping: this.stopping,
      goal,
      executions: this.runtime.store.countExecutionsForScope(this.runtime.memoryScope),
      context: { ...this.runtime.bridge.context },
      session: { state: this.runtime.session.state, recoveryAttempts: this.runtime.session.recoveryAttempts, recoveryBudget: this.runtime.session.recoveryBudget },
    };
    const adapter = this.runtime.bodyAdapter;
    let snapshot: ReturnType<typeof this.runtime.bridge.snapshot> | undefined;
    let observationError: string | undefined;
    // A 3D body must not depend on the legacy bridge snapshot. Reading it in parallel
    // could fail the whole status or leak a second (planar) world into the UI.
    if (!adapter) {
      try { snapshot = this.runtime.bridge.snapshot(); }
      catch (error) { observationError = error instanceof Error ? error.message : String(error); }
    }
    const body = this.bodyState(snapshot);
    if (adapter) {
      let observed;
      try { observed = adapter.peek?.(); } catch { observed = undefined; }
      const cells = observed?.cells;
      return {
        ...base,
        body,
        state: this.stopping ? 'closing' : this.paused ? 'paused' : this.runtime.session.state,
        // 3D cells have their own x/y/z contract; they are not relabelled into the
        // legacy planar map. The web shows an explicit empty/unknown map instead.
        context: { ...this.runtime.bridge.context },
        position: undefined,
        inventory: typeof adapter.inventory === 'number' && Number.isInteger(adapter.inventory) && adapter.inventory >= 0 ? adapter.inventory : undefined,
        ui: undefined,
        observation: {
          source: adapter.source,
          freshness: observed?.freshness ?? 'unknown',
          gap: observed?.gap ?? true,
          revision: observed?.revision ?? 'unknown',
          unknownCells: cells ? [...cells.values()].filter(cell => cell.cell === 'unknown' || cell.cell === 'unsupported').length : undefined,
          threeDimensional: true,
          mode: '3d',
        },
      };
    }
    if (!snapshot) {
      // A failed observation is unknown, not an empty world. Never turn a read error into cells={}.
      return { ...base, body, state: this.stopping ? 'closing' : this.paused ? 'paused' : this.runtime.session.state, observation: { source: 'unknown', freshness: 'unknown', gap: true, ...(observationError ? { error: redact(observationError) } : {}) }, position: undefined, inventory: undefined, ui: undefined };
    }
    // Expose the observed cells so the top-down view reads real state instead of an absent field.
    return {
      ...base,
      body,
      state: this.stopping ? 'closing' : this.paused ? 'paused' : this.runtime.session.state,
      context: { ...this.runtime.bridge.context, cells: snapshot.cells },
      position: snapshot.position,
      inventory: snapshot.inventory,
      ui: snapshot.ui,
      observation: {
        source: snapshot.source,
        freshness: snapshot.freshness,
        gap: snapshot.gap,
        revision: snapshot.revision,
        unknownCells: Object.values(snapshot.cells).filter(cell => cell === 'unknown').length,
        fields: snapshot.fields,
        threeDimensional: false,
        mode: 'legacy-2d',
      },
    };
  }
  /** Goal reads outside the attached stable scope are invisible; a goal id is not a global handle. */
  private scopedGoal(goalId: string) {
    const goal = this.runtime.store.getGoal(goalId);
    return goal && sameStableScope(goal.context, this.runtime.memoryScope) ? goal : undefined;
  }

  /** Body/server identity is reported separately from the assembled runtime profile. */
  capabilities() {
    const bridge = this.runtime.bridge as { capabilities?: unknown };
    const body = this.bodyState();
    const controlOpen = this.runtime.controlOpen();
    const inputsEnabled = this.runtime.inputsEnabled;
    const effectiveInputsEnabled = inputsEnabled && controlOpen;
    const serverProfileId = this.runtime.bridge.context.serverProfileId;
    return {
      // `profile` is the legacy alias for the attached body/server profile; new callers should
      // read `serverProfileId`. `runtimeProfile` is the profile string this runtime was built from.
      profile: serverProfileId,
      serverProfileId,
      runtimeProfile: this.runtime.runtimeProfile,
      provider: this.providerMetadata,
      bridge: redact(bridge.capabilities ?? {}),
      skills: this.runtime.router.availableSkills?.() ?? [],
      // Keep the raw configured gate visible, but never present it as usable while the
      // attached bridge service has admission closed.
      inputsEnabled,
      effectiveInputsEnabled,
      inputControl: effectiveInputsEnabled
        ? { open: controlOpen, state: 'available' as const }
        : {
            open: controlOpen,
            state: 'disabled' as const,
            reason: inputsEnabled ? 'control-revoked' : 'input-gate-disabled',
          },
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
  goals(options: { limit?: number; cursor?: string } = {}) { return this.runtime.store.listGoalsForScope(this.runtime.memoryScope, options).items; }
  executions(options: { limit?: number; cursor?: string } = {}) { return this.runtime.store.listExecutionsForScope(this.runtime.memoryScope, options).items; }
  effects(executionId?: string, options: { limit?: number; cursor?: string } = {}) { return this.runtime.store.listEffectsForScope(this.runtime.memoryScope, { executionId, ...options }).items; }
  /** Scoped memory query with explicit pagination; never a silently sliced table dump. */
  placesPage(options: { limit?: number; cursor?: string; status?: string } = {}) { return this.runtime.memory.queryPlaces({ ...options, scope: this.runtime.memoryScope }); }
  places(options: { limit?: number; cursor?: string; status?: string } = {}) { return this.placesPage(options).items; }
  episodesPage(options: { limit?: number; cursor?: string } = {}) { return this.runtime.memory.queryEpisodic({ ...options, scope: this.runtime.memoryScope }); }
  /** Scoped memories route: places and episodes are both paginated and scope-filtered. */
  memories(options: { limit?: number; cursor?: string; status?: string } = {}) {
    return { places: this.placesPage(options), episodes: this.episodesPage({ limit: options.limit, cursor: options.cursor }) };
  }
  events(cursor = '0', limit = 100, filter?: string) { return this.runtime.session.events.read(cursor, limit, filter, this.runtime.memoryScope); }
  /** Current event sequence head; SSE snapshots are labelled with it so snapshot and cursor agree. */
  eventsHead() { return this.runtime.session.events.head(); }
  provider() { return redact(this.providerMetadata); }
  /** Read-only capability report over the same attached Runtime (no start/dispatch). */
  diagnostics(options?: DoctorOptions): DoctorReport { return collectDoctorReport(this.runtime, options); }
  doctor(options?: DoctorOptions): DoctorReport { return this.diagnostics(options); }

  /** Command receipts are scoped by the full stable identity (server, account, world, dimension). */
  private commandScope(): string {
    return commandScopeOf(this.runtime.bridge.context);
  }

  async command(input: unknown): Promise<CommandResult> {
    const parsed = CommandRequestSchema.safeParse(input);
    if (!parsed.success) return { requestId: typeof (input as any)?.requestId === 'string' ? (input as any).requestId : 'invalid', command: 'message', state: 'rejected', code: 'invalid-command', payloadHash: canonicalPayloadHash(input) };
    const request = parsed.data;
    const payloadHash = canonicalPayloadHash({ command: request.command, payload: request.payload, expectedRevision: request.expectedRevision });
    // Once closed the store is gone; refuse every command rather than touching a closed DB.
    if (this.closed) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'runtime-closed', payloadHash };
    const scope = this.commandScope();
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
    try {
      // The receipt row is keyed by receipt_id. The same requestId may legitimately execute
      // again in a different world/dimension, so the durable receipt id is derived from both
      // the receipt scope and the command id; commandId stays the caller's requestId.
      const receiptId = `receipt:${canonicalPayloadHash({ scope, requestId: request.requestId })}`;
      this.runtime.store.addActionReceipt({ receiptId, scope, commandId: request.requestId, status: 'pending', payloadHash });
    } catch {
      // The command has not started. Reporting "accepted/in-flight" here would claim
      // work that no durable receipt or execution exists for.
      this.inflight.delete(claimKey);
      return { requestId: request.requestId, command: request.command, state: 'unknown', code: 'receipt-unavailable', payloadHash };
    }
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
      catch {
        // The command may already have taken effect, but the durable receipt did not
        // commit. Report uncertainty instead of a terminal success the store cannot replay.
        return { ...bare, state: 'unknown' as const, code: result.code ?? 'receipt-write-failed' };
      }
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
      case 'goal.set': {
        const p = GoalSetPayloadSchema.parse(payload);
        // A goal id is only writable inside the scope that already owns it. Reusing an id from
        // another world must not overwrite its body_context (or its CAS chain) from here.
        const existing = this.runtime.store.getGoal(p.goalId);
        if (existing && !sameStableScope(existing.context, this.runtime.memoryScope)) throw new Error(`goal-scope-mismatch:${p.goalId}`);
        const revision = existing ? existing.revision + 1 : 1;
        if (request.expectedRevision !== undefined && (existing?.revision ?? 0) !== request.expectedRevision) throw new Error(`goal-revision-conflict:${existing?.revision ?? 0}`);
        this.runtime.store.saveGoal({ goalId: p.goalId, revision, status: p.status ?? 'active', text: p.text, context: this.runtime.bridge.context });
        return { requestId: request.requestId, command: request.command, state: 'terminal', result: this.scopedGoal(p.goalId), payloadHash: '' };
      }
      case 'goal.revise': {
        const p = GoalRevisePayloadSchema.parse(payload);
        // Reject a foreign-scope goal instead of revising a row this body cannot own.
        if (!this.scopedGoal(p.goalId)) throw new Error(this.runtime.store.getGoal(p.goalId) ? `goal-scope-mismatch:${p.goalId}` : 'goal-not-found');
        const result = this.runtime.store.reviseGoal(p.goalId, p.expectedRevision ?? request.expectedRevision ?? 0, p.change);
        return { requestId: request.requestId, command: request.command, state: 'terminal', result, payloadHash: '' };
      }
      case 'message': {
        const p = MessagePayloadSchema.parse(payload);
        if (this.paused) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'paused', result: { queued: false }, payloadHash: '' };
        const run = await this.runtime.loop.run([{ role: 'user', content: p.text }], undefined, this.abortSignal, { goalId: p.goalId, goalRevision: p.goalRevision, store: this.runtime.store, owner: this.runtime.ownerId });
        if (this.stopping) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'stopping', result: { queued: false }, payloadHash: '' };
        if (run.response.stopReason === 'goal-revision-conflict') return { requestId: request.requestId, command: request.command, state: 'conflict', code: 'goal-revision-conflict', result: run, payloadHash: '' };
        // A completed provider call is not always a successful answer: an unavailable provider,
        // truncation, cancellation or turn-budget exhaustion must not be labelled terminal.
        const failure = providerStopFailure(run.response.stopReason);
        if (failure) return { requestId: request.requestId, command: request.command, ...failure, result: run, payloadHash: '' };
        return { requestId: request.requestId, command: request.command, state: 'terminal', result: run, payloadHash: '' };
      }
      case 'chat': { const p = ChatPayloadSchema.parse(payload); if (this.paused) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'paused', payloadHash: '' }; const result = await this.runtime.router.invoke({ id: request.requestId, name: 'send_chat', arguments: JSON.stringify({ text: p.text }) }, { signal: this.abortSignal, owner: this.runtime.ownerId }); if (this.stopping) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'stopping', result, payloadHash: '' }; return { requestId: request.requestId, command: request.command, state: result.ok ? 'terminal' : 'unknown', result, payloadHash: '' }; }
      case 'pause': {
        // Abort first so the pausing event precedes any command receipt that reflects the abort.
        // Stop/quit is terminal: a later pause must not clear `stopping`, or a replay of resume
        // could reopen a runtime whose scheduler and body were already shut down.
        this.abortActive(); this.paused = true; this.pausing = true;
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
        if (this.stopping) {
          const cancellation = await this.cancelActiveExecutions();
          const body = await this.releaseBody(cancellation.attempted);
          return { requestId: request.requestId, command: request.command, state: 'accepted', result: { stopping: true, canceled: cancellation.canceled, failed: cancellation.failed, cancelRequested: cancellation.cancelRequested, body }, payloadHash: '' };
        }
        this.abortActive(); this.stopping = true; this.paused = true; this.runtime.scheduler.close(); this.runtime.lifecycle.humanControl('stop');
        // Capture what was in flight: the aborted message receipt settles before the stop event is published.
        await this.settled([...this.activeRuns.values()]);
        const cancellation = await this.cancelActiveExecutions(); const body = await this.releaseBody(cancellation.attempted);
        this.runtime.session.events.publish('runtime.stopping', { reason: 'stop', canceled: cancellation.canceled, failed: cancellation.failed, cancelRequested: cancellation.cancelRequested, body }, true);
        return { requestId: request.requestId, command: request.command, state: 'accepted', result: { stopping: true, canceled: cancellation.canceled, failed: cancellation.failed, cancelRequested: cancellation.cancelRequested, body }, payloadHash: '' };
      }
      case 'cancel': {
        const p = CancelPayloadSchema.parse(payload);
        const execution = this.runtime.store.getExecution(p.executionId);
        // A foreign-scope execution is not addressable through this body's control surface.
        if (!execution || !sameStableScope(execution.context, this.runtime.memoryScope)) return { requestId: request.requestId, command: request.command, state: 'unknown', code: 'execution-not-found', payloadHash: '' };
        const invoke = await this.runtime.router.invoke({ id: request.requestId, name: 'cancel_execution', arguments: JSON.stringify(p) });
        const after = this.runtime.store.getExecution(p.executionId);
        return { requestId: request.requestId, command: request.command, state: terminal.has(after?.status ?? '') ? 'terminal' : invoke.ok ? 'accepted' : 'unknown', code: invoke.ok ? undefined : invoke.error, result: after, payloadHash: '' };
      }
      case 'save': { const checkpoint = { checkpointId: `runtime-${this.runtime.clock.now()}`, executionId: 'runtime', revision: (this.runtime.store.getLatestCheckpoint('runtime')?.revision ?? 0) + 1, payload: this.status() }; this.runtime.store.saveCheckpoint(checkpoint); return { requestId: request.requestId, command: request.command, state: 'terminal', result: checkpoint, payloadHash: '' }; }
      case 'quit': {
        this.abortActive(); this.quitting = true; this.stopping = true; this.paused = true; this.runtime.scheduler.close(); this.runtime.lifecycle.humanControl('quit');
        await this.settled([...this.activeRuns.values()]);
        const cancellation = await this.cancelActiveExecutions(); const body = await this.releaseBody(cancellation.attempted);
        this.runtime.session.events.publish('runtime.shutdown-requested', { canceled: cancellation.canceled, failed: cancellation.failed, cancelRequested: cancellation.cancelRequested, body }, true);
        // The shutdown decision is performed regardless of whether its receipt can be persisted,
        // but `accepted` is only claimed after the durable write succeeds. The quit result is
        // returned directly by command() so it is not committed a second time.
        const shutdown = { stopping: true, canceled: cancellation.canceled, failed: cancellation.failed, cancelRequested: cancellation.cancelRequested, body };
        const scope = this.commandScope();
        let state: CommandResult['state'] = 'accepted';
        let code: string | undefined;
        try {
          this.runtime.store.updateActionReceipt(scope, request.requestId, 'completed', shutdown);
          this.runtime.session.events.publish('control.quit', { requestId: request.requestId, state: 'accepted', result: shutdown }, true);
          this.committedRequestId = request.requestId;
        } catch (error) {
          // The command already decided to shut down, but the durable receipt (or its control
          // event) did not commit: report unknown with the write error, never accepted.
          state = 'unknown';
          code = error instanceof Error && error.message ? error.message : 'quit-receipt-write-failed';
        }
        const closed = this.closeRuntime(); this.closed = true;
        return { requestId: request.requestId, command: request.command, state, ...(code ? { code } : {}), result: { ...shutdown, closed }, payloadHash: '' };
      }
    }
  }

  /**
   * Release held body input through every real channel that exists. The attached BodyAdapter is
   * the authoritative owner of 3D input and is released with the lease owner tokens the Motor
   * controller used; the bridge helper methods are the legacy/OS channel. With neither channel,
   * release is explicitly unavailable instead of being reported as success.
   */
  private async releaseBody(ownerTokens: readonly string[] = []): Promise<{ released: boolean; error?: string }> {
    const adapter = this.runtime.bodyAdapter;
    const bridge = this.runtime.bridge as { releaseOwnedInputs?: () => Promise<unknown> | unknown; stopBody?: () => Promise<unknown> | unknown };
    const errors: string[] = [];
    let channels = 0;
    if (adapter) {
      channels += 1;
      // Execution ids are the lease owner tokens submitted by the Motor controller; the runtime
      // owner id is the process-level token. Release both so a held input cannot survive because
      // the controller and the runtime name the same owner differently.
      const tokens = [...new Set([...ownerTokens, this.runtime.ownerId])];
      for (const token of tokens) {
        try { await adapter.release(token); }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
    }
    if (typeof bridge.releaseOwnedInputs === 'function') {
      channels += 1;
      try { await bridge.releaseOwnedInputs(); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    } else if (typeof bridge.stopBody === 'function') {
      channels += 1;
      try { await bridge.stopBody(); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    if (channels === 0) return { released: false, error: 'release-channel-unavailable' };
    return errors.length ? { released: false, error: errors.join('; ') } : { released: true };
  }

  /** Best-effort stop of every non-terminal execution this body scope owns; foreign rows stay untouched. */
  private async cancelActiveExecutions(): Promise<CancelReport> {
    const canceled: string[] = [];
    const failed: CancelFailure[] = [];
    const cancelRequested: CancelFailure[] = [];
    const attempted: string[] = [];
    for (const execution of this.runtime.store.listExecutionsForScope(this.runtime.memoryScope).items) {
      if (terminal.has(execution.status)) continue;
      attempted.push(execution.executionId);
      let error: string | undefined;
      try {
        const outcome = await this.runtime.router.invoke({ id: `stop-${execution.executionId}`, name: 'cancel_execution', arguments: JSON.stringify({ executionId: execution.executionId }) });
        if (!outcome.ok) error = outcome.error ?? 'cancel-invoke-failed';
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      // Re-read the durable row: only an observed terminal state is reported as settled.
      const status = this.runtime.store.getExecution(execution.executionId)?.status;
      if (status === 'canceled') { canceled.push(execution.executionId); continue; }
      if (error !== undefined) { failed.push({ executionId: execution.executionId, error }); continue; }
      if (status && terminal.has(status)) { failed.push({ executionId: execution.executionId, error: `terminal:${status}` }); continue; }
      // Still stopping/running/queued: a request was accepted but cancellation is not confirmed.
      cancelRequested.push({ executionId: execution.executionId, error: status ? `status:${status}` : 'status-unknown' });
    }
    return { canceled, failed, cancelRequested, attempted };
  }
}

export type { CommandRequest };
export { CommandRequestSchema };
