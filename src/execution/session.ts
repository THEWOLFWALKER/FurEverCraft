import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import type { BodyContext } from '../contracts/index.js';
import type { SQLiteStore } from '../persistence/store.js';
import { EventHub } from '../diagnostics/events.js';

const sameContext = (left: BodyContext, right: BodyContext) =>
  left.serverProfileId === right.serverProfileId &&
  left.worldGenerationId === right.worldGenerationId &&
  left.connectionEpoch === right.connectionEpoch &&
  left.bodyEpoch === right.bodyEpoch &&
  left.dimension === right.dimension;

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
      for (const effect of this.store.pendingEffects()) {
      let status = 'ambiguous';
      let evidence: Record<string, unknown> = { source: 'recovery-observation', error: 'snapshot-unavailable' };
      try {
        const snapshot = this.bridge.snapshot();
        const contextMatches = sameContext(effect.context as BodyContext, snapshot.context);
        const intent = effect.intent as { kind?: string; x?: number; y?: number };
        if (contextMatches && intent.kind === 'place' && Number.isInteger(intent.x) && Number.isInteger(intent.y)) {
          const cell = snapshot.cells[`${intent.x},${intent.y}`];
          status = cell === 'blocked' ? 'confirmed' : 'ambiguous';
        }
        evidence = { source: 'recovery-observation', revision: snapshot.revision, contextMatched: contextMatches, intent };
      } catch (error) {
        evidence = { ...evidence, message: error instanceof Error ? error.message : String(error) };
      }
      const effectId = effect.effect_id ?? effect.effectId;
      this.store.updateEffect(effectId, status, evidence);
        reconciled.push({ effectId, status });
      }
      this.started = true;
      this._state = 'running';
      this.events.publish('runtime.recovered', { executions: this.store.listExecutions().length, effects: reconciled.length, ownerId: this.ownerId }, true);
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
