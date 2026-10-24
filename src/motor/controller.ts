import type { Clock } from '../contracts/index.js';
import type { BodyAdapter, WorldObservation } from './contracts.js';
import { isReal3DObservation } from './contracts.js';
import { ActionPlanner, LANDING_TOLERANCE, type ActionPlannerOptions } from './action-graph.js';
import { Motor3D } from './primitives.js';
import { ProgressController } from './progress.js';
import {
  edgeProgress, horizontalDistance, observationUsable, poseBlock, preconditionKeys, stepDirection, stepLanded,
  stepTarget, worldFromObservation, yawDelta, type TemporaryFailure,
} from './route.js';
import type { ActionCapability, BlockPos, NavRoute, Pose3D, RouteStep } from './types.js';

export type ControlBudget = {
  maxTicks: number;
  maxWallClockMs: number;
  maxReplans: number;
  maxTicksPerStep: number;
  /** Ticks without observed progress on one edge before a local replan. */
  stallTicks: number;
  observationMaxAgeMs: number;
  yawToleranceDegrees: number;
};
export const DEFAULT_CONTROL_BUDGET: ControlBudget = {
  maxTicks: 400,
  maxWallClockMs: 30_000,
  maxReplans: 3,
  maxTicksPerStep: 40,
  stallTicks: 8,
  observationMaxAgeMs: 500,
  yawToleranceDegrees: 8,
};

export type NavigationStatus = 'confirmed' | 'partial' | 'failed' | 'canceled';
export type NavigationOutcome = 'confirmed' | 'partial' | 'ambiguous' | 'failed' | 'canceled';
export type NavigationResult = {
  status: NavigationStatus;
  outcome: NavigationOutcome;
  reason?: string;
  reasonCode?: string;
  pose: Pose3D | null;
  ticks: number;
  replans: number;
  released: boolean;
  route?: NavRoute;
  target: BlockPos | null;
  /** Simulated/observed body that produced the result; never a real-client claim. */
  evidence: 'simulated-control-loop';
  temporaryFailures: readonly TemporaryFailure[];
};

export type MotionControllerOptions = {
  budget?: Partial<ControlBudget>;
  planner?: ActionPlannerOptions;
  progress?: ProgressController;
  /** Called once when the run abandons its lease (pause, target change, disconnect, stale observation, focus loss). */
  onLeaseRevoke?: (reason: string) => void;
  /** Optional wall-clock wait used only when the body has no virtual advance hook. */
  waitTick?: () => Promise<void>;
  onProgress?: (stage: 'plan' | 'execute' | 'verify', completed: number, total: number, message: string) => void;
};

export type TargetRevision = { expected: number; current: () => number };

export type RunRequest = {
  target: BlockPos;
  leaseId: string;
  ownerToken: string;
  tolerance?: number;
  signal?: AbortSignal;
  isPaused?: () => boolean;
  /** Called before every control tick; a returned reason revokes the route immediately. */
  watch?: () => string | undefined;
  /** Compare-and-swap guard for the operator's current target. */
  targetRevision?: TargetRevision;
};

const CANCEL_REASONS = new Set(['canceled', 'paused', 'target-changed', 'target-revision-changed', 'superseded']);
const NOOP = (_reason: string): void => undefined;

/**
 * Closed-loop 3D motion supervisor.
 *
 * Truth comes only from injected body observations: the planner proposes
 * edges, each edge is re-validated against fresh observations, and success is
 * the observed landing. Planner reachability is never used as execution truth.
 * Every failure is bounded: a stall consumes a local attempt, then triggers at
 * most `maxReplans` replans and an expiring temporary-failure record.
 */
export class MotionController {
  private abortReason?: string;
  private releasePromise?: Promise<void>;
  private currentOwnerToken?: string;
  private currentLeaseId?: string;
  private lastNow?: number;
  private lastObservedPose?: Pose3D;
  private currentRoute?: NavRoute;
  private running = false;
  private inputIssued = false;
  private readonly budget: ControlBudget;
  private readonly progress: ProgressController;

  constructor(
    private readonly body: BodyAdapter,
    private readonly clock: Clock,
    private readonly options: MotionControllerOptions = {},
  ) {
    this.budget = { ...DEFAULT_CONTROL_BUDGET, ...(options.budget ?? {}) };
    this.progress = options.progress ?? new ProgressController(clock);
  }

  get route(): NavRoute | undefined { return this.currentRoute; }
  get aborted(): boolean { return this.abortReason !== undefined; }
  get failures(): readonly TemporaryFailure[] { return this.progress.failures(); }
  get isRunning(): boolean { return this.running; }

  /** Pause is an immediate release, not a flag checked later. */
  pause(): void { this.abort('paused'); }
  /** A different target invalidates the old route, lease and held input at once. */
  changeTarget(): void { this.abort('target-changed'); }
  onDisconnect(): void { this.abort('disconnected'); }
  onObservationExpired(): void { this.abort('observation-stale'); }
  onFocusLost(): void { this.abort('focus-lost'); }

  abort(reason: string, revokeLease = true): void {
    const fresh = this.abortReason === undefined;
    if (fresh) this.abortReason = reason;
    if (fresh && revokeLease) {
      try { this.options.onLeaseRevoke?.(reason); } catch { /* lease revocation is best effort at the hook boundary */ }
      this.releasePromise ??= this.releaseInput();
    }
  }

  /** Await the immediate release started by an abort (useful for operator commands and tests). */
  async whenReleased(): Promise<void> { await this.releasePromise; }

  async run(request: RunRequest): Promise<NavigationResult> {
    const startedAt = this.clock.now();
    this.lastNow = startedAt;
    this.abortReason = undefined;
    this.lastObservedPose = undefined;
    this.currentRoute = undefined;
    this.currentOwnerToken = request.ownerToken;
    this.currentLeaseId = request.leaseId;
    this.releasePromise = undefined;
    this.inputIssued = false;
    this.running = true;
    let ticks = 0;
    let replans = 0;
    let pose: Pose3D | undefined;
    const target = request.target;
    const tolerance = request.tolerance ?? LANDING_TOLERANCE;

    const finish = async (status: NavigationStatus, outcome: NavigationOutcome, reason?: string, reasonCode?: string): Promise<NavigationResult> => {
      await this.stopAndRelease();
      this.running = false;
      this.currentOwnerToken = undefined;
      this.currentLeaseId = undefined;
      const finalPose = pose ?? this.lastObservedPose ?? null;
      return {
        status, outcome,
        ...(reason ? { reason } : {}), ...(reasonCode ? { reasonCode } : {}),
        pose: finalPose ? { ...finalPose } : null, ticks, replans, released: true,
        ...(this.currentRoute ? { route: this.currentRoute } : {}),
        target: { ...target },
        evidence: 'simulated-control-loop',
        temporaryFailures: [...this.progress.failures()],
      };
    };

    const stopReason = (): string | undefined => {
      if (this.abortReason) return this.abortReason;
      if (request.signal?.aborted) return 'canceled';
      if (request.isPaused?.()) return 'paused';
      if (request.targetRevision && request.targetRevision.current() !== request.targetRevision.expected) return 'target-revision-changed';
      return request.watch?.();
    };
    const budgetExhausted = (): boolean => ticks >= this.budget.maxTicks || this.clock.now() - startedAt > this.budget.maxWallClockMs;

    try {
      for (;;) {
        const requestedStop = stopReason();
        if (requestedStop) { this.abort(requestedStop); return await this.finishStop(finish, requestedStop); }
        if (!this.advanceClock()) { this.abort('clock-not-monotonic'); return await finish('failed', 'failed', 'clock-not-monotonic', 'clock-not-monotonic'); }
        if (budgetExhausted()) {
          this.abort('control-budget-exhausted');
          return await finish('failed', 'failed', 'control-budget-exhausted', 'control-budget-exhausted');
        }

        const observed = await this.body.observe();
        pose = observed.pose;
        this.lastObservedPose = observed.pose;
        const issue = this.observationIssue(observed);
        if (issue) { this.abort(issue); return await finish('failed', 'failed', issue, issue); }

        if (this.reached(observed.pose, target, tolerance)) return await finish('confirmed', 'confirmed');

        if (!observed.supported) {
          // Airborne/unsupported start is not a stable planning anchor. Wait for
          // bounded evidence instead of declaring a route from an invented pose.
          const decision = this.progress.record({ kind: 'observation_no_update', failureSignature: 'unstable-start', hasNewEvidence: false, ownerToken: request.ownerToken });
          if (decision.action === 'cooldown') return await finish('failed', 'failed', 'unstable-start-budget-exhausted', 'unstable-start');
          await this.advanceBody(); ticks += 1;
          continue;
        }

        const world = worldFromObservation(observed);
        const planner = new ActionPlanner(world, this.plannerOptions());
        const planned = planner.planRoute(poseBlock(observed.pose), target);
        this.currentRoute = this.annotate(planned, observed.revision);
        this.options.onProgress?.('plan', 0, this.currentRoute.steps.length, this.currentRoute.status);
        if (planned.status !== 'COMPLETE') {
          const status: NavigationStatus = planned.status === 'NEEDS_OBSERVATION' ? 'partial' : 'failed';
          const outcome: NavigationOutcome = planned.status === 'NEEDS_OBSERVATION' ? 'partial' : 'failed';
          // Unreachable/unsupported is declared, not executed. Held input is still released.
          return await finish(status, outcome, planned.reason ?? planned.status.toLowerCase(), `plan:${planned.status}`);
        }
        const validated = planner.validateRoute(this.currentRoute, world, { start: poseBlock(observed.pose) });
        if (!validated.ok) {
          const reason = validated.reason ?? 'route-invalid';
          if (validated.invalidStep !== undefined) this.noteStepFailure(this.currentRoute.steps[validated.invalidStep], reason);
          if (replans >= this.budget.maxReplans) return await finish('failed', 'failed', reason, 'route-invalid');
          replans += 1;
          continue;
        }

        let replanNeeded = false;
        for (let stepIndex = 0; stepIndex < this.currentRoute.steps.length; stepIndex++) {
          const stop = stopReason();
          if (stop) { this.abort(stop); return await this.finishStop(finish, stop); }
          const step = this.currentRoute.steps[stepIndex]!;
          // Preconditions are re-evaluated against the freshest observation, not the plan snapshot.
          const before = await this.body.observe();
          pose = before.pose;
          const beforeIssue = this.observationIssue(before);
          if (beforeIssue) { this.abort(beforeIssue); return await finish('failed', 'failed', beforeIssue, beforeIssue); }
          const freshWorld = worldFromObservation(before);
          const freshPlanner = new ActionPlanner(freshWorld, this.plannerOptions());
          const stepRoute: NavRoute = { ...this.currentRoute, steps: [step] };
          const stepCheck = freshPlanner.validateRoute(stepRoute, freshWorld, { start: poseBlock(before.pose) });
          if (!stepCheck.ok) {
            this.noteStepFailure(step, stepCheck.reason ?? 'precondition-invalidated');
            if (replans >= this.budget.maxReplans) return await finish('failed', 'failed', stepCheck.reason ?? 'precondition-invalidated', 'route-invalidated');
            replans += 1;
            replanNeeded = true;
            break;
          }

          const executed = await this.executeStep(step, request, () => ++ticks, stopReason, budgetExhausted);
          pose = executed.pose ?? pose;
          if (executed.outcome === 'canceled') {
            if (executed.reason) this.abort(executed.reason);
            return await this.finishStop(finish, executed.reason ?? 'canceled');
          }
          if (executed.outcome === 'replan') {
            this.noteStepFailure(step, executed.reason ?? 'stalled');
            if (replans >= this.budget.maxReplans) return await finish('failed', 'failed', executed.reason ?? 'replan-budget-exhausted', 'replan-budget-exhausted');
            replans += 1;
            replanNeeded = true;
            break;
          }
          if (executed.outcome === 'failed') {
            this.noteStepFailure(step, executed.reason ?? 'step-failed');
            return await finish('failed', 'failed', executed.reason ?? 'step-failed', executed.reason ?? 'step-failed');
          }
          this.progress.reset(`nav:${step.edge.edgeId}`);
          this.options.onProgress?.('execute', stepIndex + 1, this.currentRoute.steps.length, step.edge.edgeId);
        }
        if (replanNeeded) continue;

        // A route is only successful when the body is observed on the target, not
        // because the planned step list was exhausted.
        const finalObserved = await this.body.observe();
        pose = finalObserved.pose;
        const finalIssue = this.observationIssue(finalObserved);
        if (finalIssue) { this.abort(finalIssue); return await finish('failed', 'failed', finalIssue, finalIssue); }
        if (this.reached(finalObserved.pose, target, tolerance)) return await finish('confirmed', 'confirmed');
        this.progress.noteFailure('route-end', 'target-not-reached');
        if (replans >= this.budget.maxReplans) return await finish('failed', 'failed', 'target-not-reached', 'target-not-reached');
        replans += 1;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.abort('control-error');
      return await finish('failed', 'failed', reason, 'control-error');
    } finally {
      this.running = false;
    }
  }

  private async finishStop(finish: (status: NavigationStatus, outcome: NavigationOutcome, reason?: string, reasonCode?: string) => Promise<NavigationResult>, reason: string): Promise<NavigationResult> {
    return CANCEL_REASONS.has(reason)
      ? finish('canceled', 'canceled', reason, reason)
      : finish('failed', 'failed', reason, reason);
  }

  private plannerOptions(): ActionPlannerOptions {
    const capabilities: ActionCapability[] = [];
    if (this.body.capabilities.walk) capabilities.push('walk');
    if (this.body.capabilities.jump === 'short' && this.body.capabilities.jumpMaxRise >= 1) capabilities.push('jump_short');
    return { ...(this.options.planner ?? {}), capabilities, avoidEdges: this.progress.avoidedEdges() };
  }

  private async executeStep(
    step: RouteStep,
    request: RunRequest,
    tick: () => number,
    stopReason: () => string | undefined,
    budgetExhausted: () => boolean,
  ): Promise<{ outcome: 'confirmed' | 'failed' | 'canceled' | 'replan'; pose?: Pose3D; reason?: string }> {
    const motor = new Motor3D({ context: this.body.context, clock: this.clock, body: this.body, leaseId: request.leaseId, ownerToken: request.ownerToken });
    const direction = stepDirection(step);
    const targetPose = stepTarget(step);
    let observation = await this.body.observe();
    let pose = observation.pose;

    try {
      if (direction.x !== 0 || direction.z !== 0) {
        const desiredYaw = (Math.atan2(direction.z, direction.x) * 180) / Math.PI;
        if (Math.abs(yawDelta(pose.yaw, desiredYaw)) > 4) {
          const turn = await motor.orientTo(desiredYaw, observation);
          if (turn.status !== 'accepted') return { outcome: 'failed', pose, reason: turn.reason ?? 'turn-rejected' };
          this.inputIssued = true;
          // Turning is closed-loop: wait a bounded number of ticks for the body
          // (and injected latency) to actually reach the requested yaw.
          for (let turnTicks = 0; turnTicks < 6 && Math.abs(yawDelta(pose.yaw, desiredYaw)) > this.budget.yawToleranceDegrees / 2; turnTicks++) {
            const stop = stopReason();
            if (stop) return { outcome: 'canceled', pose, reason: stop };
            if (budgetExhausted()) return { outcome: 'failed', pose, reason: 'control-budget-exhausted' };
            await this.advanceBody(); tick();
            observation = await this.body.observe(); pose = observation.pose;
            const yawIssue = this.observationIssue(observation);
            if (yawIssue) return { outcome: 'canceled', pose, reason: yawIssue };
          }
          if (Math.abs(yawDelta(pose.yaw, desiredYaw)) > this.budget.yawToleranceDegrees) return { outcome: 'replan', pose, reason: 'yaw-not-reached' };
        }
      }

      const submission = step.edge.kind === 'jump_short'
        ? await motor.jumpShort(step.edge.to, direction, observation)
        : await motor.walk(step.edge.to, direction, observation);
      if (submission.status !== 'accepted') return { outcome: 'failed', pose, reason: submission.reason ?? 'input-rejected' };
      this.inputIssued = true;

      let bestDistance = horizontalDistance(pose, targetPose);
      let bestProgress = edgeProgress(step, pose);
      let stalled = 0;
      for (let ticksForStep = 0; ticksForStep < this.budget.maxTicksPerStep; ticksForStep++) {
        const stop = stopReason();
        if (stop) return { outcome: 'canceled', pose, reason: stop };
        if (budgetExhausted()) return { outcome: 'failed', pose, reason: 'control-budget-exhausted' };
        await this.advanceBody(); tick();
        observation = await this.body.observe(); pose = observation.pose;
        const issue = this.observationIssue(observation);
        if (issue) return { outcome: 'canceled', pose, reason: issue };

        if (stepLanded(step, pose)) {
          // Stop input and verify a stable, supported landing before claiming the edge.
          await motor.stop();
          const settled = await this.body.observe(); pose = settled.pose;
          const settledIssue = this.observationIssue(settled);
          if (settledIssue) return { outcome: 'canceled', pose, reason: settledIssue };
          if (!settled.supported) return { outcome: 'replan', pose, reason: 'landing-unsupported' };
          if (!stepLanded(step, settled.pose)) return { outcome: 'replan', pose, reason: 'landing-deviation' };
          return { outcome: 'confirmed', pose };
        }

        const block = poseBlock(pose);
        const onExpectedLine = (block.x === step.edge.from.x && block.z === step.edge.from.z) || (block.x === step.edge.to.x && block.z === step.edge.to.z);
        if (!onExpectedLine) return { outcome: 'replan', pose, reason: 'pose-deviation' };
        const distance = horizontalDistance(pose, targetPose);
        if (distance > bestDistance + 0.5) return { outcome: 'replan', pose, reason: 'distance-deviation' };
        bestDistance = Math.min(bestDistance, distance);

        const progress = edgeProgress(step, pose);
        if (progress > bestProgress + 0.05) { bestProgress = progress; stalled = 0; }
        else stalled += 1;
        if (stalled >= this.budget.stallTicks) return { outcome: 'replan', pose, reason: 'no-progress' };
      }
      // No observed progress on this edge: consume the bounded recovery budget.
      const decision = this.progress.record({ kind: 'observation_new_no_progress', failureSignature: `nav:${step.edge.edgeId}`, hasNewEvidence: true, ownerToken: request.ownerToken });
      if (decision.action === 'cooldown') return { outcome: 'failed', pose, reason: 'stall-recovery-budget-exhausted' };
      if (decision.action === 'pause') return { outcome: 'canceled', pose, reason: 'paused-by-progress' };
      return { outcome: 'replan', pose, reason: 'no-progress' };
    } finally {
      // The owner releases held input on every exit; a new owner is never touched.
      await motor.release();
    }
  }

  private observationIssue(observation: WorldObservation): string | undefined {
    const now = this.clock.now();
    if (this.lastNow !== undefined && now < this.lastNow) return 'clock-not-monotonic';
    this.lastNow = now;
    if (!isReal3DObservation(observation)) return 'legacy-observation-not-3d';
    if (observation.dimension !== this.body.context.dimension) return 'observation-dimension-mismatch';
    if (![observation.pose.x, observation.pose.y, observation.pose.z, observation.pose.yaw].every(Number.isFinite)) return 'observation-pose-invalid';
    const usable = observationUsable(observation, { maxAgeMs: this.budget.observationMaxAgeMs, now, context: this.body.context });
    return usable.ok ? undefined : usable.reason;
  }

  private advanceClock(): boolean {
    const now = this.clock.now();
    if (this.lastNow !== undefined && now < this.lastNow) return false;
    this.lastNow = now;
    return true;
  }

  private async advanceBody(): Promise<void> {
    if (this.body.advance) { this.body.advance(1); return; }
    if (this.options.waitTick) { await this.options.waitTick(); return; }
    await new Promise<void>(resolve => { this.clock.schedule(this.clock.now() + 20, resolve); });
  }

  private reached(pose: Pose3D, target: BlockPos, tolerance: number): boolean {
    const block = poseBlock(pose);
    return block.x === target.x && block.y === target.y && block.z === target.z
      && horizontalDistance(pose, { x: target.x + 0.5, z: target.z + 0.5 }) <= tolerance
      && Math.abs(pose.y - target.y) <= 0.2;
  }

  private annotate(route: NavRoute, observationRevision: string): NavRoute {
    return {
      ...route,
      observationRevision,
      steps: route.steps.map(step => ({ ...step, observationRevision })),
    };
  }

  private noteStepFailure(step: RouteStep, reason: string): TemporaryFailure {
    // Orientation/pose deviations are controller issues; only transitions whose
    // world preconditions or observed progress failed are worth avoiding during
    // the local replan window.
    const avoid = /precondition|clearance|support|landing|no-progress|stall/.test(reason);
    const failure = this.progress.noteFailure(step.edge.edgeId, reason, 2_000, avoid);
    void preconditionKeys(step);
    return failure;
  }

  private async releaseInput(): Promise<void> {
    if (!this.currentOwnerToken) return;
    try { await this.body.release(this.currentOwnerToken); } catch { /* release is best effort; the sink owns its own audit */ }
  }

  private async stopAndRelease(): Promise<void> {
    // `run` owns the token for this invocation; stop() zeroes held motion, then release is authoritative.
    if (this.inputIssued && this.currentOwnerToken) {
      try {
        await this.body.submit({
          commandId: `stop-${this.currentOwnerToken}`, ownerToken: this.currentOwnerToken, leaseId: this.currentLeaseId ?? 'lease',
          issuedAt: this.clock.now(), deadline: this.clock.now() + 250, maxAge: 250, context: this.body.context,
          observationRef: 'stop', intent: { kind: 'stop' },
        });
      } catch { /* fall through to release */ }
    }
    await this.releaseInput();
    this.releasePromise ??= Promise.resolve();
  }
}
