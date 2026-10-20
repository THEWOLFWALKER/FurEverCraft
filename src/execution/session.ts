import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import type { BodyContext, WorldSnapshot } from '../contracts/index.js';
import type { SQLiteStore } from '../persistence/store.js';
import { EventHub } from '../diagnostics/events.js';

const sameContext = (left: BodyContext, right: BodyContext) =>
  left.serverProfileId === right.serverProfileId &&
  left.worldGenerationId === right.worldGenerationId &&
  left.connectionEpoch === right.connectionEpoch &&
  left.bodyEpoch === right.bodyEpoch &&
  left.dimension === right.dimension;

/**
 * World/account identity that survives a reconnect. Connection and body epochs are allowed to
 * change during recovery; server profile, world generation and dimension are not.
 */
const sameWorldScope = (left: BodyContext, right: BodyContext) =>
  left.serverProfileId === right.serverProfileId &&
  left.worldGenerationId === right.worldGenerationId &&
  left.dimension === right.dimension;

/** Observe the bridge once. A throwable snapshot is reported, never treated as evidence. */
const observe = (bridge: ClientBridgeCapabilities): { snapshot: WorldSnapshot } | { error: string } => {
  try {
    return { snapshot: bridge.snapshot() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

export type SessionState = 'idle' | 'starting' | 'running' | 'recoverable-failure' | 'suspended';
export type RecoveryResult = {
  recovered: boolean;
  context: BodyContext;
  reconciled: Array<{ effectId: string; status: string }>;
  attempts: number;
  budget: number;
};
export type SessionRuntimeOptions = {
  eventCapacity?: number;
  /** Injected event hub so the runtime assembly owns one shared event stream. */
  events?: EventHub;
  /** Consecutive failed recovery attempts allowed before the session stays suspended. */
  maxRecoveryAttempts?: number;
};

export class SessionRuntime {
  readonly events: EventHub;
  readonly ownerId: string;
  private started = false;
  private _state: SessionState = 'idle';
  private _attempts = 0;
  private readonly maxRecoveryAttempts: number;
  constructor(readonly bridge: ClientBridgeCapabilities, readonly store: SQLiteStore, options: SessionRuntimeOptions = {}) {
    this.events = options.events ?? new EventHub(options.eventCapacity ?? 1024, store, bridge.context);
    this.ownerId = this.events.bootEpoch;
    this.maxRecoveryAttempts = Math.max(1, options.maxRecoveryAttempts ?? 3);
  }
  get state(): SessionState { return this._state; }
  get recoveryAttempts(): number { return this._attempts; }
  get recoveryBudget(): number { return this.maxRecoveryAttempts; }

  /** Idempotent start. A recoverable failure consumes one attempt; callers may call `recover()`. */
  start(): RecoveryResult {
    if (this.started) return { recovered: true, context: this.bridge.context, reconciled: [], attempts: this._attempts, budget: this.maxRecoveryAttempts };
    if (this._state === 'suspended' || this._attempts >= this.maxRecoveryAttempts) {
      this._state = 'suspended';
      throw new Error('recovery-budget-exhausted');
    }
    this._attempts += 1;
    this._state = 'starting';
    const reconciled = [] as Array<{ effectId: string; status: string }>;
    try {
      // Only effects belonging to the body we are attached to may be reconciled. Records of
      // other worlds/accounts are left untouched for their own session to resolve.
      const stable = { ...this.bridge.context };
      const foreign: Array<{ effectId: string; status: string }> = [];
      for (const effect of this.store.pendingEffects()) {
        const effectId = effect.effect_id ?? effect.effectId;
        const effectContext = effect.context as BodyContext;
        if (!sameWorldScope(effectContext, stable)) {
          foreign.push({ effectId, status: String(effect.status) });
          continue;
        }
        // A reconnect changes connection/body epoch but not the world. Those effects are
        // re-checked against the new session's evidence; they are never re-attributed blindly.
        const crossEpoch = !sameContext(effectContext, stable);
        let status = 'ambiguous';
        // Re-observe for every effect so a transient failure can never be carried over as evidence.
        const observed = observe(this.bridge);
        if ('snapshot' in observed) {
          const snapshot = observed.snapshot;
          const snapshotScope = sameWorldScope(effectContext, snapshot.context) && sameWorldScope(stable, snapshot.context);
          const contextMatches = sameContext(effectContext, snapshot.context);
          const intent = effect.intent as { kind?: string; x?: number; y?: number };
          const fieldEvidence = Object.values(snapshot.fields ?? {});
          // Only a fresh, complete snapshot can confirm anything: a gap, a missing cell field or a
          // field the observer marks unavailable/stale/unknown means the local snapshot is not evidence.
          const evidenceRefused = !snapshotScope
            || snapshot.gap === true
            || fieldEvidence.length === 0
            || fieldEvidence.some(field => !field.available || field.freshness !== 'current');
          if (!crossEpoch && contextMatches && !evidenceRefused && intent.kind === 'place' && Number.isInteger(intent.x) && Number.isInteger(intent.y)) {
            const cell = snapshot.cells[`${intent.x},${intent.y}`];
            // A blocked target may have been satisfied by someone else. Only a dispatch that was
            // actually sent (may-have-dispatched or later) can be attributed as our effect; a
            // merely prepared intent stays ambiguous.
            const dispatched = effect.status === 'may-have-dispatched' || effect.status === 'verifying';
            status = dispatched && cell === 'blocked' ? 'confirmed' : 'ambiguous';
          }
          const unavailableField = Object.entries(snapshot.fields ?? {}).find(([, field]) => !field.available || field.freshness !== 'current')?.[0];
          const evidence: Record<string, unknown> = { source: 'recovery-observation', revision: snapshot.revision, contextMatched: contextMatches, crossEpoch, intent, dispatched: effect.status };
          if (crossEpoch) evidence.reason = 'cross-epoch-reobservation';
          if (evidenceRefused) Object.assign(evidence, { error: !snapshotScope ? 'snapshot-world-mismatch' : snapshot.gap === true ? 'snapshot-gap' : unavailableField ? 'snapshot-stale' : 'snapshot-unverified', ...(unavailableField ? { unavailableField } : {}) });
          this.store.updateEffect(effectId, status, evidence);
        } else {
          this.store.updateEffect(effectId, status, { source: 'recovery-observation', error: observed.error, message: observed.error, intent: effect.intent, dispatched: effect.status, crossEpoch });
        }
        reconciled.push({ effectId, status });
      }
      this.started = true;
      this._state = 'running';
      const attempts = this._attempts;
      // A completed recovery clears the consecutive-failure budget.
      this._attempts = 0;
      this.events.publish('runtime.recovered', { executions: this.store.listExecutions().length, effects: reconciled.length, foreignEffects: foreign.length, ownerId: this.ownerId, recoveryAttempts: attempts }, true);
      return { recovered: true, context: this.bridge.context, reconciled, attempts, budget: this.maxRecoveryAttempts };
    } catch (error) {
      this.started = false;
      this._state = this._attempts >= this.maxRecoveryAttempts ? 'suspended' : 'recoverable-failure';
      this.events.publish('runtime.recovery_failed', { error: error instanceof Error ? error.message : String(error), ownerId: this.ownerId, attempts: this._attempts, budget: this.maxRecoveryAttempts, suspended: this._state === 'suspended' }, true);
      throw error;
    }
  }

  /** Retry a recoverable failure. The attempt budget is enforced across consecutive failures. */
  recover(): RecoveryResult { this.started = false; return this.start(); }
}
