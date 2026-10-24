import { nextId } from '../contracts/index.js';
import type { BlockPos, InputPlan3D, InputReceipt, MotorAsyncDeps, MotorDeps, Pose3D } from './types.js';
import type { MotionIntent, WorldObservation } from './contracts.js';

export type PrimitivePhase = 'check' | 'run' | 'verify' | 'stable' | 'complete' | 'canceled' | 'failed';
export type PrimitiveResult = { status: 'succeeded' | 'failed' | 'canceled'; phase: PrimitivePhase; reason?: string; pose: Pose3D };
export type AsyncPrimitiveResult = { status: 'accepted' | 'rejected'; phase: PrimitivePhase; reason?: string; receipt: InputReceipt };

/**
 * Synchronous Motor facade retained only for the explicitly legacy simulated
 * demo. New code uses `Motor3D` with the asynchronous body contract; this
 * facade is not the production movement path.
 */
export class Motor {
  constructor(private readonly deps: MotorDeps) {}
  private send(delta: InputPlan3D['delta'], ownerToken = nextId('owner')): PrimitiveResult {
    const before = this.deps.reader.read(); const now = this.deps.clock.now();
    const plan = { commandId: nextId('cmd'), executionId: nextId('exec'), context: this.deps.context, leaseId: nextId('lease'), sequence: nextId('seq'), sourceEpoch: this.deps.context.connectionEpoch, generatedAt: now, clockDomain: 'manual', maxAge: 100, observationRef: before.revision, leaseUntil: now + 100, kind: 'walk' as const, payload: {}, ownerToken, deadline: now + 100, snapshotRevision: before.revision, heldSet: [], delta };
    const receipt = this.deps.input.submit(plan);
    if (!receipt.accepted) return { status: 'failed', phase: 'failed', reason: receipt.reason, pose: before.pose };
    const after = this.deps.reader.read();
    return { status: 'succeeded', phase: 'complete', pose: after.pose };
  }
  orientTo(yaw: number): PrimitiveResult { const current = this.deps.reader.read().pose; return this.send({ yaw: yaw - current.yaw }); }
  walkCorridor(from: BlockPos, to: BlockPos): PrimitiveResult { return this.send({ forward: Math.sign(to.x - from.x), strafe: Math.sign(to.z - from.z) }); }
  stepUp(from: BlockPos, to: BlockPos): PrimitiveResult { return this.send({ forward: Math.sign(to.x - from.x), strafe: Math.sign(to.z - from.z), jump: true }); }
  jumpShort(from: BlockPos, to: BlockPos): PrimitiveResult { return this.send({ forward: Math.sign(to.x - from.x), strafe: Math.sign(to.z - from.z), jump: true }); }
  controlledDrop(from: BlockPos, to: BlockPos): PrimitiveResult { return this.send({ forward: Math.sign(to.x - from.x), strafe: Math.sign(to.z - from.z) }); }
}

/**
 * The 3D primitive writer. It only issues the primitives with evidence in this
 * batch: turn, flat walk, one-block short jump, and stop. It never calls the
 * planner and never mutates the body or world directly.
 */
export class Motor3D {
  private readonly maxAge: number;
  constructor(private readonly deps: MotorAsyncDeps, options: { maxAge?: number } = {}) { this.maxAge = options.maxAge ?? 1000; }

  async orientTo(targetYaw: number, observation: WorldObservation, toleranceDegrees = 4): Promise<AsyncPrimitiveResult> {
    return this.issue({ kind: 'turn', targetYaw, toleranceDegrees }, observation);
  }

  async walk(toward: BlockPos, direction: { x: number; y: number; z: number }, observation: WorldObservation): Promise<AsyncPrimitiveResult> {
    return this.issue({ kind: 'walk', direction, toward: { ...toward } }, observation);
  }

  async jumpShort(toward: BlockPos, direction: { x: number; y: number; z: number }, observation: WorldObservation): Promise<AsyncPrimitiveResult> {
    return this.issue({ kind: 'jump', direction, toward: { ...toward }, short: true }, observation);
  }

  /** Stop the body and release held input for this owner. Safe to call repeatedly. */
  async stop(): Promise<void> {
    try { await this.deps.body.submit(this.plan({ kind: 'stop' })); } catch { /* release below is authoritative */ }
    await this.deps.body.release(this.deps.ownerToken);
  }

  async release(): Promise<void> {
    await this.deps.body.release(this.deps.ownerToken);
  }

  private async issue(intent: MotionIntent, observation: WorldObservation): Promise<AsyncPrimitiveResult> {
    try {
      const receipt = await this.deps.body.submit(this.plan(intent, observation));
      return receipt.accepted
        ? { status: 'accepted', phase: 'run', receipt }
        : { status: 'rejected', phase: 'failed', reason: receipt.reason ?? 'input-rejected', receipt };
    } catch (error) {
      return { status: 'rejected', phase: 'failed', reason: error instanceof Error ? error.message : String(error), receipt: { commandId: 'unissued', accepted: false, observedRevision: observation.revision, reason: 'submit-failed' } };
    }
  }

  private plan(intent: MotionIntent, observation?: WorldObservation): import('./contracts.js').MotionPlan {
    const now = this.deps.clock.now();
    return {
      commandId: nextId('motion'),
      ownerToken: this.deps.ownerToken,
      leaseId: this.deps.leaseId,
      issuedAt: now,
      deadline: now + this.maxAge,
      maxAge: this.maxAge,
      context: this.deps.context,
      observationRef: observation?.revision ?? 'unobserved',
      ...(observation?.worldRevision !== undefined ? { worldRevision: observation.worldRevision } : {}),
      intent,
    };
  }
}

export type { MotorDeps, MotorAsyncDeps };
