import type { BodyContext } from '../contracts/index.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import type { SQLiteStore } from '../persistence/store.js';
import type { EventHub } from '../diagnostics/events.js';
import { EffectCoordinator, statusForOutcome, type EffectOutcome, type EffectWriteResult } from './effect-coordinator.js';

/**
 * ActionGateway — the single write entry point every skill (including chat/UI
 * control) goes through to register and settle effects (S04 / FEC-35).
 *
 * Before this existed the router wrote effect rows inline with one aggregated
 * `effectId` per skill call. That parallel legacy write path is deleted: the
 * gateway is now the only place that calls `store.addEffect` / `transitionEffect`.
 *
 * Responsibilities:
 *  - prepare the durable barrier before a skill may reach a dispatch report;
 *  - support per-dig attribution for `gather_blocks(count>1)` by minting one
 *    effect per dig, keyed on `logical_action_id` / `action_ordinal`;
 *  - funnel every settlement through the EffectCoordinator so an unknown or
 *    ambiguous effect is never reported as success.
 *
 * The gateway holds no lease and runs no execution loop: the Executor still owns
 * leases and execution status.
 */

/** A single effect the gateway manages, with the logical identity used for attribution. */
export type ManagedEffect = {
  effectId: string;
  logicalActionId: string;
  actionOrdinal: number;
  status: string;
  revision: number;
};

export type ActionGatewayOptions = {
  events?: EventHub;
  /** Actor recorded in the append-only effect transition log. */
  actor?: string;
};

export class ActionGateway {
  private readonly coordinator: EffectCoordinator;
  readonly effects = new Map<string, ManagedEffect>();

  constructor(
    private readonly store: SQLiteStore,
    private readonly context: () => BodyContext,
    options: ActionGatewayOptions = {},
  ) {
    this.coordinator = new EffectCoordinator(store, {
      ...(options.events ? { events: options.events } : {}),
      ...(options.actor ? { actor: options.actor } : {}),
    });
  }

  /**
   * Prepare one effect. `logicalActionId` groups the effects of a single logical
   * action (for example one `gather_blocks` call); `actionOrdinal` orders the
   * per-dig effects inside that group so the unique index
   * `(execution_id, logical_action_id, action_ordinal)` holds. Every prepared
   * effect is tracked so later settlement can address it by id.
   */
  prepareEffect(input: {
    effectId: string;
    executionId: string;
    intent: unknown;
    logicalActionId: string;
    actionOrdinal: number;
    parentEffectId?: string;
  }): ManagedEffect | EffectWriteResult {
    try {
      const effect = this.coordinator.prepare({
        effectId: input.effectId,
        executionId: input.executionId,
        context: this.context(),
        intent: input.intent,
        logicalActionId: input.logicalActionId,
        actionOrdinal: input.actionOrdinal,
        ...(input.parentEffectId === undefined ? {} : { parentEffectId: input.parentEffectId }),
      });
      const managed: ManagedEffect = {
        effectId: effect.effectId,
        logicalActionId: String(effect.logicalActionId ?? `single:${effect.effectId}`),
        actionOrdinal: Number(effect.actionOrdinal ?? 0),
        status: String(effect.status),
        revision: Number(effect.revision ?? 0),
      };
      this.effects.set(managed.effectId, managed);
      return managed;
    } catch (error) {
      // A duplicate logical key (already prepared) or an id conflict is surfaced, not swallowed.
      return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Cross the dispatch barrier for one effect. */
  markDispatched(effectId: string, evidence: unknown, options: { expectedRevision?: number } = {}): EffectWriteResult {
    const result = this.coordinator.markDispatched(effectId, evidence, options);
    this.sync(effectId);
    return result;
  }

  /**
   * Settle one effect from an execution outcome. `prepared` effects that never
   * crossed the barrier are preserved as `prepared`; anything else non-confirmed
   * is `ambiguous`. Never reports success for an unknown outcome.
   */
  settleEffect(effectId: string, outcome: EffectOutcome, evidence: unknown, options: { expectedRevision?: number } = {}): EffectWriteResult {
    const result = this.coordinator.settle(effectId, outcome, evidence, options);
    this.sync(effectId);
    return result;
  }

  /**
   * Settle every effect belonging to one logical action with the same outcome.
   * Used when a skill ends without the gateway having settled each per-dig effect
   * individually (for example an early abort): the effects stay `prepared` or move
   * to `ambiguous`, never to `confirmed` unless the outcome is explicitly confirmed.
   */
  settleLogicalAction(logicalActionId: string, outcome: EffectOutcome, evidence: unknown): EffectWriteResult[] {
    return [...this.effects.values()]
      .filter(effect => effect.logicalActionId === logicalActionId)
      .map(effect => this.settleEffect(effect.effectId, outcome, evidence));
  }

  /** The managed effects for one logical action, ordered by ordinal. */
  effectsFor(logicalActionId: string): ManagedEffect[] {
    return [...this.effects.values()].filter(effect => effect.logicalActionId === logicalActionId).sort((left, right) => left.actionOrdinal - right.actionOrdinal);
  }

  /** Current durable status of a managed effect. */
  status(effectId: string): string | undefined {
    return this.store.getEffect(effectId)?.status;
  }

  /** Effective status if an outcome were applied to the current status (no write). */
  projectedStatus(effectId: string, outcome: EffectOutcome): string {
    return statusForOutcome(outcome, this.store.getEffect(effectId)?.status);
  }

  private sync(effectId: string) {
    const effect = this.store.getEffect(effectId);
    const managed = this.effects.get(effectId);
    if (effect && managed) {
      managed.status = String(effect.status);
      managed.revision = Number(effect.revision ?? managed.revision);
    }
  }
}

/**
 * Whether a gateway-managed effect set may be reported as a successful skill
 * result: exactly one effect, explicitly confirmed. This is the ActionGateway's
 * own assertion of the "unknown effect never reported as success" invariant.
 */
export function gatewayReportedSuccess(effects: ManagedEffect[], confirmed: boolean): boolean {
  return confirmed && effects.length > 0 && effects.every(effect => effect.status === 'confirmed');
}
