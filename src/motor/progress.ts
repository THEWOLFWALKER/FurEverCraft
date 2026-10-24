import type { Clock } from '../contracts/index.js';
import type { TemporaryFailure } from './route.js';

export type ProgressKind = 'observation_no_update' | 'observation_new_no_progress' | 'phase_wait' | 'external_block' | 'control_channel_error';
export type ProgressSample = { kind: ProgressKind; failureSignature: string; hasNewEvidence: boolean; ownerToken: string };
export type RecoveryDecision = { action: 'continue' | 'cooldown' | 'replan' | 'pause' | 'control-lost'; reason: string; ownerToken: string; attempts: number };

/**
 * Bounded progress and recovery accounting.
 *
 * Every failure signature has a hard attempt budget; exhausting it enters a
 * cooldown instead of retrying forever. Temporary edge failures are recorded
 * with an expiry so a local replan can avoid the same transition for a short
 * window without turning a transient block into a permanent world rule.
 */
export class ProgressController {
  private attempts = new Map<string, number>();
  private temporary = new Map<string, TemporaryFailure>();
  private cooldownUntil = 0;
  constructor(private readonly clock: Clock, private readonly maxAttempts = 3, private readonly cooldownMs = 30000) {}

  record(sample: ProgressSample): RecoveryDecision {
    const now = this.clock.now();
    if (now < this.cooldownUntil) return { action: 'cooldown', reason: 'failure-cooldown', ownerToken: sample.ownerToken, attempts: this.attempts.get(sample.failureSignature) ?? 0 };
    // The cooldown window has elapsed: clear the attempt budget for this signature so new
    // evidence is not permanently rejected by stale counts.
    const count = (this.attempts.get(sample.failureSignature) ?? 0) + 1;
    if (count >= this.maxAttempts) { this.attempts.set(sample.failureSignature, 0); this.cooldownUntil = now + this.cooldownMs; return { action: 'cooldown', reason: sample.failureSignature, ownerToken: sample.ownerToken, attempts: count }; }
    this.attempts.set(sample.failureSignature, count);
    if (!sample.hasNewEvidence) return { action: 'continue', reason: 'no-new-evidence', ownerToken: sample.ownerToken, attempts: count };
    if (sample.kind === 'control_channel_error') return { action: 'control-lost', reason: sample.kind, ownerToken: sample.ownerToken, attempts: count };
    if (sample.kind === 'external_block') return { action: 'replan', reason: sample.kind, ownerToken: sample.ownerToken, attempts: count };
    if (sample.kind === 'phase_wait') return { action: 'pause', reason: sample.kind, ownerToken: sample.ownerToken, attempts: count };
    return { action: 'continue', reason: sample.kind, ownerToken: sample.ownerToken, attempts: count };
  }

  /** Record a bounded, expiring temporary failure for a specific transition. */
  noteFailure(edgeId: string, reason: string, ttlMs = 2_000, avoid = true): TemporaryFailure {
    const now = this.clock.now();
    const signature = `nav:${edgeId}:${reason}`;
    const previous = this.temporary.get(edgeId);
    const attempts = (previous?.signature === signature ? previous.attempts : 0) + 1;
    const failure: TemporaryFailure = { edgeId, reason, until: now + ttlMs, signature, attempts, avoid };
    this.temporary.set(edgeId, failure);
    return failure;
  }

  /** Edges whose temporary failure is still active; they are avoided during local replanning. */
  avoidedEdges(now = this.clock.now()): ReadonlySet<string> {
    const avoided = new Set<string>();
    for (const [edgeId, failure] of this.temporary) {
      if (failure.until <= now) this.temporary.delete(edgeId);
      else if (failure.avoid) avoided.add(edgeId);
    }
    return avoided;
  }

  failures(now = this.clock.now()): readonly TemporaryFailure[] {
    return [...this.temporary.values()].filter(failure => failure.until > now);
  }

  reset(signature?: string): void {
    if (signature) { this.attempts.delete(signature); this.temporary.delete(signature); }
    else { this.attempts.clear(); this.temporary.clear(); this.cooldownUntil = 0; }
  }
}
