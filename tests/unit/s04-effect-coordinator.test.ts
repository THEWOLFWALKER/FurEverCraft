import { describe, expect, it } from 'vitest';
import { SQLiteStore } from '../../src/persistence/store.js';
import {
  EffectCoordinator, isSuccessfulOutcome, statusForOutcome, recoveredEffectIsSuccess,
} from '../../src/execution/effect-coordinator.js';

const context = { serverProfileId: 'fixture', worldGenerationId: 'world-a', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };
const execution = { executionId: 'execution-1', proposalId: 'proposal-1', proposalHash: 'hash-1', goalId: 'goal-1', skillId: 'dig_one', skillVersion: '1.0.0', status: 'running' };

function setup() {
  const store = new SQLiteStore(':memory:');
  store.saveExecution(execution);
  const coordinator = new EffectCoordinator(store);
  const prepare = (effectId: string, logicalActionId?: string, actionOrdinal?: number) => coordinator.prepare({
    effectId, executionId: 'execution-1', context, intent: { kind: 'dig' },
    ...(logicalActionId === undefined ? {} : { logicalActionId }),
    ...(actionOrdinal === undefined ? {} : { actionOrdinal }),
  });
  return { store, coordinator, prepare };
}

describe('S04 EffectCoordinator', () => {
  it('starts every prepared effect in the explicit prepared status', () => {
    const { prepare, store } = setup();
    const effect = prepare('e1');
    expect(effect.status).toBe('prepared');
    expect(store.getEffect('e1')).toMatchObject({ status: 'prepared', revision: 0 });
  });

  it('returns an exhaustive union and never swallows a revision conflict (FEC-24)', () => {
    const { prepare, coordinator } = setup();
    prepare('e1');
    // Cross the barrier once (revision becomes 1).
    const first = coordinator.markDispatched('e1', { barrier: 'pre-dispatch' });
    expect(first.status).toBe('applied');
    // A second writer that still believes revision 0 loses the CAS race and must be told so,
    // not silently applied on top of the newer revision.
    const raced = coordinator.transition('e1', 'confirmed', { observed: true }, { expectedRevision: 0 });
    expect(raced.status).toBe('conflict');
    if (raced.status !== 'conflict') throw new Error('unreachable');
    expect(raced.reason).toContain('effect-revision-conflict');
    // The winning revision is the barrier, not the stale confirmed write.
    expect(raced.effect.status).toBe('may-have-dispatched');
  });

  it('reports an illegal transition as invalid rather than applying it', () => {
    const { prepare, coordinator } = setup();
    prepare('e1');
    // prepared -> confirmed is not a legal transition; the caller must be told explicitly.
    const result = coordinator.transition('e1', 'confirmed', { observed: true });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('unreachable');
    expect(result.reason).toContain('invalid-effect-transition');
  });

  it('reports a settlement on a missing effect as not-found instead of success', () => {
    const { coordinator } = setup();
    expect(coordinator.settle('nope', 'confirmed', {})).toMatchObject({ status: 'not-found' });
    expect(coordinator.recover('nope', {})).toMatchObject({ status: 'not-found' });
  });

  it('never reports an unknown/ambiguous settlement as a successful outcome', () => {
    const { prepare, coordinator, store } = setup();
    prepare('e1');
    coordinator.markDispatched('e1', { barrier: 'pre-dispatch' });
    // An ambiguous settlement is explicitly not a success.
    const settled = coordinator.settle('e1', 'ambiguous', { reason: 'receipt-lost' });
    expect(settled.status).toBe('applied');
    expect(store.getEffect('e1')?.status).toBe('ambiguous');
    expect(isSuccessfulOutcome('ambiguous')).toBe(false);
    expect(isSuccessfulOutcome('confirmed')).toBe(true);
    expect(isSuccessfulOutcome(undefined)).toBe(false);
  });

  it('keeps a prepared-but-never-dispatched effect out of success even when the target later exists (FEC-25)', () => {
    const { prepare, store } = setup();
    prepare('e1');
    // The world changed (another actor), but this process cannot prove it dispatched the dig.
    // Recovery reconciles it: a merely prepared intent must stay ambiguous, never confirmed.
    const recovered = new EffectCoordinator(store, { actor: 'recovery' }).recover('e1', { source: 'recovery-observation', targetSatisfied: true });
    expect(recovered.status).toBe('applied');
    expect(store.getEffect('e1')?.status).toBe('ambiguous');
    // And a settlement of that recovered effect with a non-confirmed outcome cannot upgrade it.
    const settled = statusForOutcome('ambiguous', 'prepared');
    expect(settled).toBe('prepared');
    expect(recoveredEffectIsSuccess(store.getEffect('e1')?.status)).toBe(false);
  });

  it('lets a monotonic-looking confirmed settlement only be applied through a legal transition', () => {
    const { prepare, coordinator, store } = setup();
    prepare('e1');
    // Ranks are gone: a `prepared` effect cannot jump straight to confirmed without a barrier.
    expect(coordinator.settle('e1', 'confirmed', { observed: true })).toMatchObject({ status: 'invalid' });
    expect(store.getEffect('e1')?.status).toBe('prepared');
    // After the barrier, confirmation is legal and is the only success path.
    coordinator.markDispatched('e1', { barrier: 'pre-dispatch' });
    const confirmed = coordinator.settle('e1', 'confirmed', { observed: true });
    expect(confirmed.status).toBe('applied');
    expect(store.getEffect('e1')?.status).toBe('confirmed');
  });

  it('does not let a later dispatch settlement overwrite a barrier a recovery rewrote (FEC-24)', () => {
    const { prepare, coordinator, store } = setup();
    prepare('e1');
    // A recovery rewrites the prepared effect to ambiguous (revision 1) while a dispatch is in flight.
    const recovery = new EffectCoordinator(store, { actor: 'recovery' });
    expect(recovery.recover('e1', { source: 'recovery-observation' }).status).toBe('applied');
    const afterRecovery = store.getEffect('e1')!;
    expect(afterRecovery.status).toBe('ambiguous');
    // The in-flight dispatcher still holds the pre-recovery revision and tries to cross the barrier
    // based on it. The CAS must reject: the barrier the recovery wrote is not swallowed.
    const stale = coordinator.markDispatched('e1', { barrier: 'pre-dispatch' }, { expectedRevision: 0 });
    expect(stale.status).toBe('conflict');
    expect(store.getEffect('e1')?.status).toBe('ambiguous');
  });

  it('records an append-only transition log with actor and from/to status', () => {
    const { prepare, coordinator, store } = setup();
    prepare('e1');
    coordinator.markDispatched('e1', { barrier: 'pre-dispatch' });
    coordinator.settle('e1', 'confirmed', { observed: true });
    const transitions = store.effectTransitions('e1');
    expect(transitions.map(item => `${item.fromStatus ?? 'none'}->${item.toStatus}`)).toEqual([
      'none->prepared', 'prepared->may-have-dispatched', 'may-have-dispatched->confirmed',
    ]);
    expect(transitions.every(item => item.actor.length > 0)).toBe(true);
  });

  it('keeps distinct per-dig effects for one logical action separate', () => {
    const { prepare, store } = setup();
    prepare('dig-0', 'action-gather', 0);
    prepare('dig-1', 'action-gather', 1);
    const effects = store.listEffects('execution-1');
    const gathers = effects.filter(effect => effect.logicalActionId === 'action-gather');
    expect(gathers.map(effect => effect.actionOrdinal).sort()).toEqual([0, 1]);
    // Re-preparing the same (execution, logical action, ordinal) key conflicts on the unique index.
    const coordinator = new EffectCoordinator(store);
    expect(() => coordinator.prepare({ effectId: 'dig-1b', executionId: 'execution-1', context, intent: { kind: 'dig' }, logicalActionId: 'action-gather', actionOrdinal: 1 })).toThrow();
  });
});
