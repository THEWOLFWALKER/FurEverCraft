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
      const snapshot = this.bridge.snapshot();
      const status = effect.intent?.kind === 'place' && snapshot.inventory < 8 ? 'confirmed' : 'ambiguous';
      this.store.updateEffect(effect.effect_id, status, { source: 'recovery-observation', revision: snapshot.revision });
      reconciled.push({ effectId: effect.effect_id, status });
    }
    this.events.publish('runtime.recovered', { executions: this.store.listExecutions().length, effects: reconciled.length }, true);
    return { recovered: true, context: this.bridge.context, reconciled };
  }
  recover(): RecoveryResult { this.started = false; return this.start(); }
}
