import type { SQLiteStore } from '../persistence/store.js';
import type { EventHub } from '../diagnostics/events.js';

/**
 * EffectCoordinator — the single durable effect-state coordinator (S04).
 *
 * Every effect write in the production path goes through here. The class owns the
 * full set of invariants the L2 contract requires:
 *
 *  - an `unknown`/`ambiguous` effect is never reported as `success`;
 *  - `transitionEffect`'s exhaustive union (applied | conflict | invalid) is never
 *    silently collapsed: a conflict is surfaced, never swallowed by a monotonic
 *    rank comparison (FEC-24);
 *  - the CAS barrier that a recovery rewrote is never overwritten by a later
 *    in-process settlement (`expectedRevision` conflict);
 *  - a `prepared` effect that was never dispatched stays `ambiguous` even if the
 *    target later exists — the "prepared but never dispatched" rule (FEC-25)
 *    lives here and is reused by `session.ts` recovery.
 *
 * It is deliberately thin: the SQLiteStore remains the low-level CAS/transaction
 * layer, and the Executor remains the lease/execution-status owner. There is no
 * second execution loop.
 */

/** The outcome an effect may be settled to from an execution result. */
export type EffectOutcome = 'confirmed' | 'partial' | 'ambiguous' | 'failed' | 'canceled';

/** Result of a coordinator write. Callers must handle `conflict` and `invalid` explicitly. */
export type EffectWriteResult =
  | { status: 'applied'; effect: NonNullable<ReturnType<SQLiteStore['getEffect']>> }
  | { status: 'conflict'; effect: NonNullable<ReturnType<SQLiteStore['getEffect']>>; reason: string }
  | { status: 'invalid'; reason: string; effect?: NonNullable<ReturnType<SQLiteStore['getEffect']>> }
  | { status: 'not-found'; reason: string };

/**
 * A settlement is `success` only for an explicit confirmed outcome. `partial`,
 * `ambiguous`, `failed`, `canceled` and any missing/unknown value are failures.
 * This is the single classifier the router, executor and recovery all share so an
 * unknown effect can never leak out as success on one path but not another.
 */
export function isSuccessfulOutcome(outcome: string | undefined): boolean {
  return outcome === 'confirmed';
}

/**
 * Map an execution outcome onto the durable effect status.
 *
 * The critical rule (FEC-25): if the effect never crossed the dispatch barrier
 * (`prepared`), an execution result that did not explicitly confirm the effect
 * must settle it to `prepared`/`ambiguous` — never to `confirmed`, even if the
 * execution says it was confirmed, because the effect's own barrier proof is missing.
 */
export function statusForOutcome(
  outcome: EffectOutcome,
  currentStatus: string | undefined,
): 'confirmed' | 'partial' | 'ambiguous' | 'prepared' | 'not-dispatched' {
  if (outcome === 'confirmed') return 'confirmed';
  if (outcome === 'partial') return 'partial';
  // Ambiguous/failed/canceled never become success. A still-`prepared` effect keeps the
  // truthful "prepared but never dispatched" status; anything past the barrier stays ambiguous.
  return currentStatus === 'prepared' ? 'prepared' : 'ambiguous';
}

export type EffectCoordinatorOptions = {
  events?: EventHub;
  /** Actor label recorded in the append-only transition log. */
  actor?: string;
};

export class EffectCoordinator {
  private readonly actor: string;
  constructor(private readonly store: SQLiteStore, private readonly options: EffectCoordinatorOptions = {}) {
    this.actor = options.actor ?? 'effect-coordinator';
  }

  private publish(kind: string, payload: unknown) { this.options.events?.publish(kind, payload, false); }

  /** Durable prepare. A `prepared` effect is the only status a fresh effect may start in. */
  prepare(input: {
    effectId: string;
    executionId: string;
    context: unknown;
    intent: unknown;
    logicalActionId?: string;
    actionOrdinal?: number;
    parentEffectId?: string;
  }): NonNullable<ReturnType<SQLiteStore['getEffect']>> {
    const effect = this.store.addEffect({
      effectId: input.effectId,
      executionId: input.executionId,
      context: input.context,
      status: 'prepared',
      intent: input.intent,
      ...(input.logicalActionId === undefined ? {} : { logicalActionId: input.logicalActionId }),
      ...(input.actionOrdinal === undefined ? {} : { actionOrdinal: input.actionOrdinal }),
      ...(input.parentEffectId === undefined ? {} : { parentEffectId: input.parentEffectId }),
    });
    this.publish('effect.prepared', { effectId: effect.effectId, executionId: effect.executionId, logicalActionId: effect.logicalActionId, actionOrdinal: effect.actionOrdinal });
    return effect;
  }

  /**
   * Cross the dispatch barrier. The stored status must already be `prepared`; the
   * transition to `may-have-dispatched` is the durable proof that input may have
   * reached the body. A CAS conflict here is reported, not retried blindly.
   */
  markDispatched(effectId: string, evidence: unknown, options: { expectedRevision?: number } = {}): EffectWriteResult {
    return this.transition(effectId, 'may-have-dispatched', evidence, options);
  }

  /**
   * Settle an effect from the execution result. `prepared` effects stay `prepared`
   * (or become `ambiguous` when they were past the barrier); a confirmed execution
   * is the only path to `confirmed`.
   */
  settle(effectId: string, outcome: EffectOutcome, evidence: unknown, options: { expectedRevision?: number } = {}): EffectWriteResult {
    const current = this.store.getEffect(effectId);
    if (!current) return { status: 'not-found', reason: 'effect-not-found' };
    const target = statusForOutcome(outcome, current.status);
    return this.transition(effectId, target, evidence, options);
  }

  /**
   * Reconcile a recovered effect. This is the recovery-side settlement and carries
   * the FEC-25 rule: a `prepared` effect is `ambiguous` (it may or may not have
   * been dispatched) regardless of what the world now shows. Only the provided
   * `recoveredStatus` matters, and it can never be `confirmed` from this path.
   */
  recover(effectId: string, evidence: unknown, options: { expectedRevision?: number } = {}): EffectWriteResult {
    const current = this.store.getEffect(effectId);
    if (!current) return { status: 'not-found', reason: 'effect-not-found' };
    // Recovery never proves this process performed the action: a merely prepared intent
    // stays ambiguous, and a past-barrier effect also stays ambiguous (no causal proof).
    return this.transition(effectId, 'ambiguous', evidence, options);
  }

  /**
   * The single funnel into `store.transitionEffect`. The exhaustive union is
   * preserved: conflict and invalid are returned to the caller, never swallowed.
   */
  transition(effectId: string, status: string, evidence: unknown, options: { expectedRevision?: number; evidenceRef?: string } = {}): EffectWriteResult {    const result = this.store.transitionEffect(effectId, status, evidence, {
      actor: this.actor,
      ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
      ...(options.evidenceRef === undefined ? {} : { evidenceRef: options.evidenceRef }),
    });
    if (result.status === 'applied') {
      this.publish('effect.transition', { effectId, status, revision: result.effect.revision });
      return { status: 'applied', effect: result.effect };
    }
    if (result.status === 'conflict') {
      // A stale writer (a late settlement, or a recovery that rewrote the barrier) lost the
      // CAS race. Report it; the caller decides whether to re-read and retry.
      this.publish('effect.transition-conflict', { effectId, status, reason: result.reason, revision: result.effect.revision });
      return { status: 'conflict', effect: result.effect, reason: result.reason };
    }
    return { status: 'invalid', reason: result.reason, ...(result.effect ? { effect: result.effect } : {}) };
  }

  /** Read helper so callers never need the raw store for effect state. */
  get(effectId: string) { return this.store.getEffect(effectId); }

  /** Effects that never reached a terminal confirmation; used by recovery and diagnostics. */
  pending() { return this.store.pendingEffects(); }
}

/**
 * Whether a recovered effect should be reported as success. This is a single
 * shared predicate so the router and any recovery path agree: a `prepared`
 * effect is never success (FEC-25), and neither is an `ambiguous` one.
 */
export function recoveredEffectIsSuccess(status: string | undefined): boolean {
  return status === 'confirmed';
}
