import type { FakeClientBridge } from '../bridge/fake/index.js';
import type { BodyContext } from '../contracts/index.js';
import type { SQLiteStore } from '../persistence/store.js';
import { EventHub } from '../diagnostics/events.js';

export type RecoveryResult = { recovered: boolean; context: BodyContext; reconciled: Array<{ effectId: string; status: string }> };

export class SessionRuntime {
  readonly events: EventHub;
  private started = false;
  constructor(readonly bridge: FakeClientBridge, readonly store: SQLiteStore, options?: { eventCapacity?: number }) {
    this.events = new EventHub(options?.eventCapacity ?? 1024, store, bridge.context);
  }
  start(): RecoveryResult {
    if (this.started) return { recovered: true, context: this.bridge.context, reconciled: [] };
    this.started = true;
    const reconciled = [] as Array<{ effectId: string; status: string }>;
    for (const effect of this.store.pendingEffects()) {
      let status = 'ambiguous';
      let evidence: Record<string, unknown> = { source: 'recovery-observation', error: 'snapshot-unavailable' };
      try {
        const snapshot = this.bridge.snapshot();
        const sameContext = JSON.stringify(effect.context) === JSON.stringify(snapshot.context);
        const intent = effect.intent as { kind?: string; x?: number; y?: number };
        if (sameContext && intent.kind === 'place' && Number.isInteger(intent.x) && Number.isInteger(intent.y)) {
          const cell = snapshot.cells[`${intent.x},${intent.y}`];
          status = cell === 'blocked' ? 'confirmed' : 'ambiguous';
        }
        evidence = { source: 'recovery-observation', revision: snapshot.revision, contextMatched: sameContext, intent };
      } catch (error) {
        evidence = { ...evidence, message: error instanceof Error ? error.message : String(error) };
      }
      const effectId = effect.effect_id ?? effect.effectId;
      this.store.updateEffect(effectId, status, evidence);
      reconciled.push({ effectId, status });
    }
    this.events.publish('runtime.recovered', { executions: this.store.listExecutions().length, effects: reconciled.length }, true);
    return { recovered: true, context: this.bridge.context, reconciled };
  }
  recover(): RecoveryResult { this.started = false; return this.start(); }
}
