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

/** Observe the bridge once. A throwable snapshot is reported, never treated as evidence. */
const observe = (bridge: ClientBridgeCapabilities): { snapshot: WorldSnapshot } | { error: string } => {
  try {
    return { snapshot: bridge.snapshot() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

export type SessionState = 'idle' | 'starting' | 'running' | 'recoverable-failure';
export type RecoveryResult = { recovered: boolean; context: BodyContext; reconciled: Array<{ effectId: string; status: string }> };

export class SessionRuntime {
  readonly events: EventHub;
  readonly ownerId: string;
  private started = false;
  private _state: SessionState = 'idle';
  constructor(readonly bridge: ClientBridgeCapabilities, readonly store: SQLiteStore, options?: { eventCapacity?: number }) {
    this.events = new EventHub(options?.eventCapacity ?? 1024, store, bridge.context);
    this.ownerId = this.events.bootEpoch;
  }
  get state(): SessionState { return this._state; }
  start(): RecoveryResult {
    if (this.started) return { recovered: true, context: this.bridge.context, reconciled: [] };
    this._state = 'starting';
    const reconciled = [] as Array<{ effectId: string; status: string }>;
    try {
      // Only effects belonging to the body we are attached to may be reconciled. Records of
      // other worlds/accounts are left untouched for their own session to resolve.
      const stable = this.bridge.context;
      const foreign: Array<{ effectId: string; status: string }> = [];
      for (const effect of this.store.pendingEffects()) {
        const effectId = effect.effect_id ?? effect.effectId;
        const effectContext = effect.context as BodyContext;
        if (!sameContext(effectContext, stable)) {
          foreign.push({ effectId, status: String(effect.status) });
          continue;
        }
        let status = 'ambiguous';
        // Re-observe for every effect so a transient failure can never be carried over as evidence.
        const observed = observe(this.bridge);
        if ('snapshot' in observed) {
          const snapshot = observed.snapshot;
          const contextMatches = sameContext(effectContext, snapshot.context);
          const intent = effect.intent as { kind?: string; x?: number; y?: number };
          const fieldEvidence = Object.values(snapshot.fields ?? {});
          // Only a fresh, complete snapshot can confirm anything: a gap, a missing cell field or a
          // field the observer marks unavailable/stale/unknown means the local snapshot is not evidence.
          const evidenceRefused = snapshot.gap === true
            || fieldEvidence.length === 0
            || fieldEvidence.some(field => !field.available || field.freshness !== 'current');
          if (contextMatches && !evidenceRefused && intent.kind === 'place' && Number.isInteger(intent.x) && Number.isInteger(intent.y)) {
            const cell = snapshot.cells[`${intent.x},${intent.y}`];
            // A blocked target may have been satisfied by someone else. Only a dispatch that was
            // actually sent (may-have-dispatched or later) can be attributed as our effect; a
            // merely prepared intent stays ambiguous.
            const dispatched = effect.status === 'may-have-dispatched' || effect.status === 'verifying';
            status = dispatched && cell === 'blocked' ? 'confirmed' : 'ambiguous';
          }
          const unavailableField = Object.entries(snapshot.fields ?? {}).find(([, field]) => !field.available || field.freshness !== 'current')?.[0];
          const evidence: Record<string, unknown> = { source: 'recovery-observation', revision: snapshot.revision, contextMatched: contextMatches, intent, dispatched: effect.status };
          if (evidenceRefused) Object.assign(evidence, { error: snapshot.gap === true ? 'snapshot-gap' : unavailableField ? 'snapshot-stale' : 'snapshot-unverified', ...(unavailableField ? { unavailableField } : {}) });
          this.store.updateEffect(effectId, status, evidence);
        } else {
          this.store.updateEffect(effectId, status, { source: 'recovery-observation', error: observed.error, message: observed.error, intent: effect.intent, dispatched: effect.status });
        }
        reconciled.push({ effectId, status });
      }
      this.started = true;
      this._state = 'running';
      this.events.publish('runtime.recovered', { executions: this.store.listExecutions().length, effects: reconciled.length, foreignEffects: foreign.length, ownerId: this.ownerId }, true);
      return { recovered: true, context: this.bridge.context, reconciled };
    } catch (error) {
      this.started = false;
      this._state = 'recoverable-failure';
      this.events.publish('runtime.recovery_failed', { error: error instanceof Error ? error.message : String(error), ownerId: this.ownerId }, true);
      throw error;
    }
  }
  recover(): RecoveryResult { this.started = false; return this.start(); }
}
