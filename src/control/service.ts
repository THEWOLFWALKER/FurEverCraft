import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RuntimeAssembly } from '../execution/factory.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import type { BodyContext } from '../contracts/index.js';
import { canonicalScopeKey, resolveStableScope } from '../contracts/context.js';
import { redact } from '../diagnostics/redaction.js';
import { collectDoctorReport, type DoctorOptions, type DoctorReport } from '../diagnostics/doctor.js';
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

/**
 * Command receipts are scoped by the full stable body identity whenever it can be resolved,
 * so two accounts/worlds/dimensions cannot collide on the same client requestId. An
 * incomplete context keeps the historical readable prefix and appends whatever world and
 * dimension identity is available.
 */
export function commandScopeFor(context: Partial<BodyContext> | undefined): string {
  const resolved = resolveStableScope(context);
  if (resolved.status === 'resolved') return `control:${canonicalScopeKey(resolved.scope)}`;
  const parts = [`control:${context?.serverProfileId ?? 'unknown'}`];
  if (context?.accountId) parts.push(`account=${context.accountId}`);
  if (context?.worldGenerationId) parts.push(`world=${context.worldGenerationId}`);
  if (context?.dimension) parts.push(`dimension=${context.dimension}`);
  return parts.join(':');
}

/** Pre-v0.3 scope, kept read-only for receipts written by an earlier build. */
const legacyCommandScopeFor = (context: Partial<BodyContext> | undefined) => `control:${context?.serverProfileId ?? 'unknown'}${context?.accountId ? `:${context.accountId}` : ''}`;

const terminal = new Set(['succeeded', 'failed', 'canceled']);
/** Operator lifecycle commands must take effect even while paused; a replay after stop must not unpause. */
const lifecycleCommands = new Set<CommandRequest['command']>(['pause', 'resume', 'stop', 'quit']);

export class ControlService {
  private paused = false;
  private pausing = false;
  private stopping = false;
  private quitting = false;
  private attached?: RuntimeAssembly;
  /**
   * In-flight requestId claims. The value is the payload hash, so a concurrent reuse of the
   * same requestId can only be reported accepted/in-flight when it is truly the same command
   * (FEC-29); a different payload is a conflict even before a durable receipt exists.
   */
  private readonly inflight = new Map<string, string>();
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

  /** Used by Runtime.close too, so direct shutdown cannot leave the control API writable. */
  beginShutdown(): void {
    this.abortActive(); this.closed = true; this.quitting = true; this.stopping = true; this.paused = true;
  }

  private async closeRuntime(): Promise<boolean> {
    try { return (await this.runtime.close()).complete; }
    catch { return false; }
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
    const goal = this.goals().find(item => item.status === 'active' || item.status === 'paused');
    const base = {
      paused: this.paused,
      stopping: this.stopping,
      goal,
      executions: this.executions().length,
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
  goals(options: { limit?: number; cursor?: string } = {}) {
    const read = this.stableScopeRead();
    return read ? this.runtime.store.listGoalsPageForScope(read, options).items : [];
  }
  executions(options: { limit?: number; cursor?: string } = {}) {
    const read = this.stableScopeRead();
    return read ? this.runtime.store.listExecutionsPageForScope(read, options).items : [];
  }
  effects(executionId?: string, options: { limit?: number; cursor?: string } = {}) {
    const read = this.stableScopeRead();
    return read ? this.runtime.store.listEffectsPageForScope(read, { executionId, ...options }).items : [];
  }
  /**
   * Scoped memory page (G7), not an unscoped table dump. Pagination metadata is preserved so a
   * caller can page past the first window instead of mistaking a slice for the whole table.
   */
  placesPage(options: { limit?: number; cursor?: string; status?: string } = {}) { return this.runtime.memory.queryPlaces({ ...options, scope: this.runtime.memoryScope }); }
  places(options: { limit?: number; cursor?: string; status?: string } = {}) { return this.placesPage(options).items; }
  /**
   * Scoped episodic memory page (FEC-46). Episodes are filtered by the runtime's own attached
   * account/world/dimension scope, so a foreign scope's episodes are never returned. The old
   * unscoped `store.listEpisodes()` read leaked every world's episodes.
   */
  episodicPage(options: { limit?: number; cursor?: string } = {}) { return this.runtime.memory.queryEpisodic({ ...options, scope: this.runtime.memoryScope }); }
  episodes(options: { limit?: number; cursor?: string } = {}) { return this.episodicPage(options).items; }
  /** Scoped places + episodes in one control read; both are filtered by the attached scope. */
  memories(options: { limit?: number; cursor?: string } = {}) {
    const places = this.placesPage(options);
    const episodes = this.episodicPage(options);
    return { places: places.items, episodes: episodes.items };
  }
  events(cursor = '0', limit = 100, filter?: string) { return this.runtime.session.events.read(cursor, limit, filter); }
  /** Current event sequence head; SSE snapshots are labelled with it so snapshot and cursor agree. */
  eventsHead() { return this.runtime.session.events.head(); }
  provider() { return redact(this.providerMetadata); }
  /** Read-only capability report over the same attached Runtime (no start/dispatch). */
  diagnostics(options?: DoctorOptions): DoctorReport { return collectDoctorReport(this.runtime, options); }
  doctor(options?: DoctorOptions): DoctorReport { return this.diagnostics(options); }

  /**
   * The attached stable identity, resolved through the runtime's single internal scope
   * (`runtime.runtimeScopeKey`). That value is derived once at assembly from the same
   * `resolveStableScope` rule a durable write uses (tolerating a body that does not expose
   * account identity), so a read and the write it must find can never disagree. A body that
   * changes account/world/dimension still moves the scope with it.
   */
  private stableScopeRead(): { scopeKey: string; scope: import('../contracts/context.js').StableScope } | undefined {
    const resolved = resolveStableScope(this.runtime.bridge.context);
    const scopeKey = this.runtime.runtimeScopeKey();
    return resolved.status === 'resolved'
      ? { scopeKey, scope: resolved.scope }
      : { scopeKey, scope: this.runtimeStableScopeFallback() };
  }

  /** The same profile-scoped sentinel the factory uses when the body omits account identity. */
  private runtimeStableScopeFallback(): import('../contracts/context.js').StableScope {
    const context = this.runtime.bridge.context;
    return {
      serverProfileId: context.serverProfileId ?? 'simulated',
      accountId: context.accountId ?? 'local',
      worldGenerationId: context.worldGenerationId ?? 'local',
      dimensionId: context.dimension ?? 'overworld',
    };
  }

  /** Goal reads outside the attached stable scope are invisible; a goal id is not a global handle. */
  private scopedGoal(goalId: string) {
    const goal = this.runtime.store.getGoal(goalId);
    if (!goal) return undefined;
    const read = this.stableScopeRead();
    return read && this.runtime.store.getGoalScoped(goalId, read.scopeKey) ? goal : undefined;
  }

  /** Command receipts are scoped by the full stable body identity when it is available. */
  private commandScope(): string { return commandScopeFor(this.runtime.bridge.context); }

  /** Read a receipt from the current scope, falling back to the pre-v0.3 scope for replay. */
  private findReceipt(scope: string, requestId: string, context: Partial<BodyContext>) {
    const current = this.runtime.store.getActionReceipt(scope, requestId);
    if (current) return current;
    const legacy = legacyCommandScopeFor(context);
    return legacy === scope ? undefined : this.runtime.store.getActionReceipt(legacy, requestId);
  }

  /** Delete a claim only when it is still this caller's claim (another run may have replaced it). */
  private releaseClaim(claimKey: string, payloadHash: string) {
    if (this.inflight.get(claimKey) === payloadHash) this.inflight.delete(claimKey);
  }

  async command(input: unknown): Promise<CommandResult> {
    const parsed = CommandRequestSchema.safeParse(input);
    if (!parsed.success) return { requestId: typeof (input as any)?.requestId === 'string' ? (input as any).requestId : 'invalid', command: 'message', state: 'rejected', code: 'invalid-command', payloadHash: canonicalPayloadHash(input) };
    const request = parsed.data;
    const payloadHash = canonicalPayloadHash({ command: request.command, payload: request.payload, expectedRevision: request.expectedRevision });
    // Once closed the store is gone; refuse every command rather than touching a closed DB.
    if (this.closed) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'runtime-closed', payloadHash };
    const context = { ...this.runtime.bridge.context };
    const scope = this.commandScope();
    const requestJsonHash = canonicalPayloadHash(request);
    const contextStatus = resolveStableScope(context).status === 'resolved' ? 'resolved' : 'unresolved';
    // Atomic claim: a concurrent identical request must not execute twice. Comparing the
    // stored payload hash closes the read-then-insert race and distinguishes a true replay
    // from a different payload reusing the same requestId (FEC-29).
    const claimKey = `${scope}:${request.requestId}`;
    const claimed = this.inflight.get(claimKey);
    if (claimed !== undefined) {
      if (claimed === payloadHash) return { requestId: request.requestId, command: request.command, state: 'accepted', code: 'in-flight', payloadHash };
      return { requestId: request.requestId, command: request.command, state: 'conflict', code: 'command-payload-conflict', payloadHash };
    }
    this.inflight.set(claimKey, payloadHash);
    // Everything between the claim and the durable receipt is synchronous, so a concurrent caller
    // either sees the pending receipt or the in-flight claim, never a second execution.
    const old = this.findReceipt(scope, request.requestId, context);
    if (old) {
      this.releaseClaim(claimKey, payloadHash);
      // A legacy receipt predating payload_hash is still replayed rather than treated as a conflict.
      if (old.payloadHash && old.payloadHash !== payloadHash) return { requestId: request.requestId, command: request.command, state: 'conflict', code: 'command-payload-conflict', payloadHash };
      const replayState = old.status === 'pending' ? 'accepted' : old.status === 'completed' ? 'terminal' : old.status === 'conflict' ? 'conflict' : old.status === 'rejected' ? 'rejected' : 'unknown';
      // While stopping, a durable non-terminal command must not replay as accepted: nothing will
      // progress it and accepted would imply work is still happening.
      if (this.stopping && !lifecycleCommands.has(request.command) && replayState !== 'terminal') return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'stopping', payloadHash };
      // FEC-30: return the exact stored envelope and original failure code. Reconstructing
      // from result_json alone loses the state/code a client needs to replay deterministically.
      if (old.fullResult && typeof old.fullResult === 'object') return old.fullResult as CommandResult;
      return { requestId: request.requestId, command: request.command, state: replayState, ...(old.code ? { code: old.code } : {}), ...(old.result !== undefined ? { result: old.result } : {}), payloadHash };
    }
    try { this.runtime.store.addActionReceipt({ receiptId: request.requestId, scope, commandId: request.requestId, status: 'pending', payloadHash, context, requestJsonHash }); }
    catch {
      // The command has not started. Reporting "accepted/in-flight" here would claim
      // work that no durable receipt or execution exists for.
      this.releaseClaim(claimKey, payloadHash);
      return { requestId: request.requestId, command: request.command, state: 'unknown', code: 'receipt-unavailable', payloadHash };
    }
    const execution = this.execute(request, { scope, context, requestJsonHash, contextStatus });
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
      try {
        this.runtime.store.updateActionReceipt(scope, request.requestId, receiptStatus, result.result, context, {
          code: result.code,
          fullResult: bare,
          requestJsonHash,
          contextStatus,
        });
      } catch {
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
      this.releaseClaim(claimKey, payloadHash);
    }
  }

  private async execute(request: CommandRequest, receipt: { scope: string; context: BodyContext; requestJsonHash: string; contextStatus: string }): Promise<CommandResult> {
    const payload = request.payload;
    switch (request.command) {
      case 'goal.set': {
        const p = GoalSetPayloadSchema.parse(payload);
        // A goal id is only writable inside the scope that already owns it. Reusing an id from
        // another world must not overwrite its body_context (or its CAS chain) from here (G7).
        const read = this.stableScopeRead();
        const existing = this.runtime.store.getGoal(p.goalId);
        if (existing && (!read || !this.runtime.store.getGoalScoped(p.goalId, read.scopeKey))) throw new Error(`goal-scope-mismatch:${p.goalId}`);
        const revision = existing ? existing.revision + 1 : 1; if (request.expectedRevision !== undefined && (existing?.revision ?? 0) !== request.expectedRevision) throw new Error(`goal-revision-conflict:${existing?.revision ?? 0}`);
        // Write the goal's body context as the runtime's *resolved* scope, so the scope_key a
        // later read computes from `runtimeScopeKey()` is the one written here. Passing the raw
        // bridge.context would leave an account-less fixture runtime unresolved on write while
        // the read resolves, and the goal would be invisible to its own writer.
        this.runtime.store.saveGoal({ goalId: p.goalId, revision, status: p.status ?? 'active', text: p.text, context: read?.scope ?? this.runtime.bridge.context });
        return { requestId: request.requestId, command: request.command, state: 'terminal', result: this.scopedGoal(p.goalId), payloadHash: '' };
      }
      case 'goal.revise': {
        const p = GoalRevisePayloadSchema.parse(payload);
        // A foreign-scope goal id is not addressable through this body's control surface (G7).
        const scoped = this.scopedGoal(p.goalId);
        if (!scoped) return { requestId: request.requestId, command: request.command, state: 'rejected', code: `goal-scope-mismatch:${p.goalId}`, payloadHash: '' };
        const result = this.runtime.store.reviseGoal(p.goalId, p.expectedRevision ?? request.expectedRevision ?? 0, p.change); return { requestId: request.requestId, command: request.command, state: 'terminal', result, payloadHash: '' };
      }
      case 'message': { const p = MessagePayloadSchema.parse(payload); if (this.paused) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'paused', result: { queued: false }, payloadHash: '' }; const run = await this.runtime.loop.run([{ role: 'user', content: p.text }], undefined, this.abortSignal, { goalId: p.goalId, goalRevision: p.goalRevision, store: this.runtime.store, owner: this.runtime.ownerId }); if (this.stopping) return { requestId: request.requestId, command: request.command, state: 'rejected', code: 'stopping', result: { queued: false }, payloadHash: '' }; if (run.response.stopReason === 'goal-revision-conflict') return { requestId: request.requestId, command: request.command, state: 'conflict', code: 'goal-revision-conflict', result: run, payloadHash: '' }; return { requestId: request.requestId, command: request.command, state: 'terminal', result: run, payloadHash: '' }; }
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
        if (this.stopping) { const canceled = await this.cancelActiveExecutions(); const body = await this.releaseBody(); return { requestId: request.requestId, command: request.command, state: 'accepted', result: { stopping: true, canceled, body }, payloadHash: '' }; }
        this.abortActive(); this.stopping = true; this.paused = true; this.runtime.scheduler.close(); this.runtime.lifecycle.humanControl('stop');
        // Capture what was in flight: the aborted message receipt settles before the stop event is published.
        await this.settled([...this.activeRuns.values()]);
        const canceled = await this.cancelActiveExecutions(); const body = await this.releaseBody();
        this.runtime.session.events.publish('runtime.stopping', { reason: 'stop', canceled, body }, true); return { requestId: request.requestId, command: request.command, state: 'accepted', result: { stopping: true, canceled, body }, payloadHash: '' };
      }
      case 'cancel': { const p = CancelPayloadSchema.parse(payload); const execution = this.executions().find(item => item.execution_id === p.executionId); if (!execution) return { requestId: request.requestId, command: request.command, state: 'unknown', code: 'execution-not-found', payloadHash: '' }; const invoke = await this.runtime.router.invoke({ id: request.requestId, name: 'cancel_execution', arguments: JSON.stringify(p) }); const after = this.runtime.store.getExecution(p.executionId); return { requestId: request.requestId, command: request.command, state: terminal.has(after?.status ?? '') ? 'terminal' : invoke.ok ? 'accepted' : 'unknown', code: invoke.ok ? undefined : invoke.error, result: after, payloadHash: '' }; }
      case 'save': { const checkpoint = { checkpointId: `runtime-${this.runtime.clock.now()}`, executionId: 'runtime', revision: (this.runtime.store.getLatestCheckpoint('runtime')?.revision ?? 0) + 1, payload: this.status() }; this.runtime.store.saveCheckpoint(checkpoint); return { requestId: request.requestId, command: request.command, state: 'terminal', result: checkpoint, payloadHash: '' }; }
      case 'quit': {
        this.abortActive(); this.quitting = true; this.stopping = true; this.paused = true; this.runtime.scheduler.close(); this.runtime.lifecycle.humanControl('quit');
        await this.settled([...this.activeRuns.values()]);
        const canceled = await this.cancelActiveExecutions(); const body = await this.releaseBody();
        this.runtime.session.events.publish('runtime.shutdown-requested', { canceled, body }, true);
        // The quit decision is committed before close() so its receipt and control event stay
        // durable; command() returns this same result without committing again.
        const result: CommandResult = { requestId: request.requestId, command: request.command, state: 'accepted', result: { stopping: true, canceled, body, closed: true }, payloadHash: canonicalPayloadHash({ command: request.command, payload: request.payload, expectedRevision: request.expectedRevision }) };
        // The quit decision and its control event are durable before close so a replayed read
        // after restart sees a terminal receipt, not a pending one. The full envelope and its
        // request hash are stored before the store closes (FEC-30). Use the scope/receipt
        // context captured when the command was admitted: the bridge may change while quitting.
        try {
          this.runtime.store.updateActionReceipt(receipt.scope, request.requestId, 'completed', result.result, receipt.context, {
            code: result.code,
            fullResult: result,
            requestJsonHash: receipt.requestJsonHash,
            contextStatus: receipt.contextStatus,
          });
        } catch { /* store may already be unavailable */ }
        this.runtime.session.events.publish('control.quit', { requestId: request.requestId, state: 'accepted', result: result.result }, true);
        this.committedRequestId = request.requestId;
        const closed = await this.closeRuntime(); this.closed = true;
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

  /**
   * Best-effort stop of every non-terminal execution in the attached stable scope. Only a
   * durable `canceled` status is reported as canceled: an invoke that succeeded but left the
   * row running is unconfirmed, not a cancellation, and a foreign row stays untouched.
   */
  private async cancelActiveExecutions(): Promise<string[]> {
    const canceled: string[] = [];
    for (const execution of this.executions()) {
      if (terminal.has(execution.status)) continue;
      try {
        await this.runtime.router.invoke({ id: `stop-${execution.executionId}`, name: 'cancel_execution', arguments: JSON.stringify({ executionId: execution.executionId }) });
        // Re-read the durable row: only an observed terminal canceled state is reported.
        if (this.runtime.store.getExecution(execution.executionId)?.status === 'canceled') canceled.push(execution.executionId);
      } catch { /* best-effort: continue stopping the remaining executions */ }
    }
    return canceled;
  }
}

export type { CommandRequest };
export { CommandRequestSchema };
