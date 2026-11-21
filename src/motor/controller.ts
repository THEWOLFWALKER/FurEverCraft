import type { Clock } from '../contracts/index.js';
import type { BodyAdapter, ObserveOptions, SupportState, WorldObservation } from './contracts.js';
import { isReal3DObservation, observationSupport } from './contracts.js';
import { ActionPlanner, type ActionPlannerOptions } from './action-graph.js';
import { Motor3D } from './primitives.js';
import { ProgressController } from './progress.js';
import {
  DEFAULT_ARRIVAL_TOLERANCE, edgeProgress, horizontalDistance, observationUsable, poseBlock, preconditionKeys, stepDirection, stepLanded,
  stepTarget, targetCenter, withinArrivalTolerance, worldFromObservation, yawDelta, type TemporaryFailure,
} from './route.js';
import type { ActionCapability, BlockPos, MotorAsyncDeps, NavRoute, Pose3D, RouteStep } from './types.js';

export type ControlBudget = {
  maxTicks: number;
  maxWallClockMs: number;
  maxReplans: number;
  maxTicksPerStep: number;
  /** Ticks without observed progress on one edge before a local replan. */
  stallTicks: number;
  observationMaxAgeMs: number;
  yawToleranceDegrees: number;
  /** Bound for one observation; an unsettled observe is abandoned after this. */
  observeTimeoutMs: number;
  /** Bound for the terminal stop submission on the release path. */
  stopTimeoutMs: number;
  /** Bound for owner release; a hung release is reported, never awaited forever. */
  releaseTimeoutMs: number;
};
export const DEFAULT_CONTROL_BUDGET: ControlBudget = {
  maxTicks: 400,
  maxWallClockMs: 30_000,
  maxReplans: 3,
  maxTicksPerStep: 40,
  stallTicks: 8,
  observationMaxAgeMs: 500,
  yawToleranceDegrees: 8,
  observeTimeoutMs: 250,
  stopTimeoutMs: 250,
  releaseTimeoutMs: 250,
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
  /** Per-execution Motor writer factory; the default is Motor3D over the same body. */
  motor?: MotorFactory;
  /** Called once when the run abandons its lease (pause, target change, disconnect, stale observation, focus loss). */
  onLeaseRevoke?: (reason: string) => void;
  /** Optional wall-clock wait used only when the body has no virtual advance hook. */
  waitTick?: () => Promise<void>;
  onProgress?: (stage: 'plan' | 'execute' | 'verify', completed: number, total: number, message: string) => void;
};

/** The production control loop can receive a different Motor writer through the same contract. */
export type MotorFactory = (deps: MotorAsyncDeps) => Pick<Motor3D, 'orientTo' | 'walk' | 'jumpShort' | 'stop' | 'release'>;

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
  private releaseFailed = false;
  /** Aborted by pause/stop/watch/target change so a stuck observe exits promptly. */
  private runController?: AbortController;
  private externalAbort?: { signal: AbortSignal; listener: () => void };
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
    // Signal any in-flight observation immediately. The guarded observe races
    // this controller, so a never-settling adapter cannot pin the control loop.
    if (!this.runController?.signal.aborted) {
      try { this.runController?.abort(reason); } catch { /* abort is best effort */ }
    }
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
    this.releaseFailed = false;
    this.running = true;
    // One controller per run: pause/stop/watch and the caller signal share it.
    const runController = new AbortController();
    this.runController = runController;
    if (request.signal) {
      const listener = () => this.abort('canceled');
      if (request.signal.aborted) listener();
      else request.signal.addEventListener('abort', listener, { once: true });
      this.externalAbort = { signal: request.signal, listener };
    }
    let ticks = 0;
    const tick = () => ++ticks;
    let replans = 0;
    let pose: Pose3D | undefined;
    const target = request.target;
    const tolerance = request.tolerance ?? DEFAULT_ARRIVAL_TOLERANCE;

    const finish = async (status: NavigationStatus, outcome: NavigationOutcome, reason?: string, reasonCode?: string): Promise<NavigationResult> => {
      await this.stopAndRelease();
      this.running = false;
      this.currentOwnerToken = undefined;
      this.currentLeaseId = undefined;
      const finalPose = pose ?? this.lastObservedPose ?? null;
      return {
        status, outcome,
        ...(reason ? { reason } : {}), ...(reasonCode ? { reasonCode } : {}),
        pose: finalPose ? { ...finalPose } : null, ticks, replans, released: !this.releaseFailed,
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

        const read = await this.readObservation(request);
        if (!('observation' in read)) {
          const stop = stopReason();
          if (stop) { this.abort(stop); return await this.finishStop(finish, stop); }
          if (read.kind === 'timeout' || read.kind === 'aborted') {
            // An observation we could not obtain is partial/control-budget, never confirmed.
            return await finish('partial', 'partial', read.reason, 'control-budget');
          }
          this.abort(read.reason);
          return await finish('failed', 'failed', read.reason, read.reason);
        }
        const observed = read.observation;
        pose = observed.pose;
        this.lastObservedPose = observed.pose;
        const issue = this.observationIssue(observed);
        if (issue) { this.abort(issue); return await finish('failed', 'failed', issue, issue); }

        const support = observationSupport(observed);
        // Unknown support cannot confirm arrival and is not evidence of being
        // airborne: stop here and ask for a usable observation instead.
        if (support === 'unknown') return await finish('partial', 'partial', 'support-unknown', 'needs-observation');
        if (this.reached(observed.pose, target, tolerance, support)) return await finish('confirmed', 'confirmed');

        if (support === 'unsupported') {
          // Airborne/unsupported start is not a stable planning anchor. Wait for
          // bounded evidence instead of declaring a route from an invented pose.
          const decision = this.progress.record({ kind: 'observation_no_update', failureSignature: 'unstable-start', hasNewEvidence: false, ownerToken: request.ownerToken });
          if (decision.action === 'cooldown') return await finish('failed', 'failed', 'unstable-start-budget-exhausted', 'unstable-start');
          await this.advanceBody(); ticks += 1;
          continue;
        }

        const world = worldFromObservation(observed);
        const planner = new ActionPlanner(world, this.plannerOptions());
        // Async planning yields a real macrotask every expansion slice; the
        // signal/deadline let pause and the wall-clock budget interrupt it.
        const planned = await planner.planRouteAsync(poseBlock(observed.pose), target, {
          signal: runController.signal,
          deadline: startedAt + this.budget.maxWallClockMs,
          now: () => this.clock.now(),
        });
        this.currentRoute = this.annotate(planned, observed.revision);
        this.options.onProgress?.('plan', 0, this.currentRoute.steps.length, this.currentRoute.status);
        if (planned.status === 'CANCELED') {
          const stop = stopReason();
          if (stop) { this.abort(stop); return await this.finishStop(finish, stop); }
          this.abort('canceled');
          return await this.finishStop(finish, 'canceled');
        }
        if (planned.status !== 'COMPLETE') {
          const partial = planned.status === 'NEEDS_OBSERVATION' || planned.status === 'BUDGET_EXHAUSTED' || planned.status === 'PARTIAL';
          const status: NavigationStatus = partial ? 'partial' : 'failed';
          const outcome: NavigationOutcome = partial ? 'partial' : 'failed';
          // Unreachable/unsupported is declared, not executed. Held input is still released.
          return await finish(status, outcome, planned.reason ?? planned.status.toLowerCase(), `plan:${planned.status}`);
        }
        if (planned.steps.length === 0) {
          // A zero-step route is a same-block planning anchor, not proof of
          // arrival. Re-check the observed pose against the continuous target
          // tolerance and close the remaining gap with bounded local control.
          const settled = await this.settleAtTarget(target, tolerance, request, tick, stopReason, budgetExhausted, observed);
          pose = settled.pose ?? pose;
          if (settled.outcome === 'confirmed') return await finish('confirmed', 'confirmed');
          if (settled.outcome === 'canceled') { this.abort(settled.reason ?? 'canceled'); return await this.finishStop(finish, settled.reason ?? 'canceled'); }
          return await finish('partial', 'partial', settled.reason ?? 'arrival-tolerance-not-met', 'arrival-tolerance-not-met');
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
          const beforeRead = await this.readObservation(request);
          if (!('observation' in beforeRead)) {
            const stop = stopReason();
            if (stop) { this.abort(stop); return await this.finishStop(finish, stop); }
            if (beforeRead.kind === 'timeout' || beforeRead.kind === 'aborted') return await finish('partial', 'partial', beforeRead.reason, 'control-budget');
            this.abort(beforeRead.reason); return await finish('failed', 'failed', beforeRead.reason, beforeRead.reason);
          }
          const before = beforeRead.observation;
          pose = before.pose;
          const beforeIssue = this.observationIssue(before);
          if (beforeIssue) { this.abort(beforeIssue); return await finish('failed', 'failed', beforeIssue, beforeIssue); }
          const beforeSupport = observationSupport(before);
          if (beforeSupport === 'unknown') return await finish('partial', 'partial', 'support-unknown', 'needs-observation');
          if (beforeSupport !== 'supported') return await finish('failed', 'failed', 'support-lost', 'support-lost');
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
          if (executed.outcome === 'unknown') {
            const stop = stopReason();
            if (stop) { this.abort(stop); return await this.finishStop(finish, stop); }
            // An unabortable/unavailable observation or unknown support inside a
            // step is reported as partial and fresh observation, never confirmed.
            return await finish('partial', 'partial', executed.reason ?? 'observation-unknown', 'control-budget');
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
          this.progress.clearFailure(step.edge.edgeId);
          this.options.onProgress?.('execute', stepIndex + 1, this.currentRoute.steps.length, step.edge.edgeId);
        }
        if (replanNeeded) continue;

        // A route is only successful when the body is observed within the
        // continuous target tolerance, not because the planned step list ended.
        const finalRead = await this.readObservation(request);
        if (!('observation' in finalRead)) {
          const stop = stopReason();
          if (stop) { this.abort(stop); return await this.finishStop(finish, stop); }
          if (finalRead.kind === 'timeout' || finalRead.kind === 'aborted') return await finish('partial', 'partial', finalRead.reason, 'control-budget');
          this.abort(finalRead.reason); return await finish('failed', 'failed', finalRead.reason, finalRead.reason);
        }
        const finalObserved = finalRead.observation;
        pose = finalObserved.pose;
        const finalIssue = this.observationIssue(finalObserved);
        if (finalIssue) { this.abort(finalIssue); return await finish('failed', 'failed', finalIssue, finalIssue); }
        if (observationSupport(finalObserved) === 'unknown') return await finish('partial', 'partial', 'support-unknown', 'needs-observation');
        const settledResult = await this.settleAtTarget(target, tolerance, request, tick, stopReason, budgetExhausted, finalObserved);
        pose = settledResult.pose ?? pose;
        if (settledResult.outcome === 'confirmed') return await finish('confirmed', 'confirmed');
        if (settledResult.outcome === 'canceled') { this.abort(settledResult.reason ?? 'canceled'); return await this.finishStop(finish, settledResult.reason ?? 'canceled'); }
        // Local short-range control was insufficient or preconditions were not
        // provable. Report partial honestly; the same block is not arrival proof.
        this.progress.noteFailure('route-end', settledResult.reason ?? 'arrival-tolerance-not-met');
        return await finish('partial', 'partial', settledResult.reason ?? 'arrival-tolerance-not-met', 'arrival-tolerance-not-met');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.abort('control-error');
      return await finish('failed', 'failed', reason, 'control-error');
    } finally {
      this.running = false;
      if (this.externalAbort) {
        this.externalAbort.signal.removeEventListener('abort', this.externalAbort.listener);
        this.externalAbort = undefined;
      }
      this.runController = undefined;
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
  ): Promise<{ outcome: 'confirmed' | 'failed' | 'canceled' | 'replan' | 'unknown'; pose?: Pose3D; reason?: string }> {
    const motor = this.motorFor(request);
    const direction = stepDirection(step);
    const targetPose = stepTarget(step);
    const initialRead = await this.readObservation(request);
    if (!('observation' in initialRead)) {
      const stop = stopReason();
      if (stop) return { outcome: 'canceled', reason: stop };
      return { outcome: this.readFailureOutcome(initialRead), reason: initialRead.reason };
    }
    let observation = initialRead.observation;
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
            const read = await this.readObservation(request);
            if (!('observation' in read)) {
              const stopped = stopReason();
              if (stopped) return { outcome: 'canceled', pose, reason: stopped };
              return { outcome: this.readFailureOutcome(read), pose, reason: read.reason };
            }
            observation = read.observation; pose = observation.pose;
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
        const read = await this.readObservation(request);
        if (!('observation' in read)) {
          const stopped = stopReason();
          if (stopped) return { outcome: 'canceled', pose, reason: stopped };
          return { outcome: this.readFailureOutcome(read), pose, reason: read.reason };
        }
        observation = read.observation; pose = observation.pose;
        const issue = this.observationIssue(observation);
        if (issue) return { outcome: 'canceled', pose, reason: issue };

        if (stepLanded(step, pose)) {
          // Stop input and verify a stable, supported landing before claiming the edge.
          await this.boundedStop(motor);
          const settledRead = await this.readObservation(request);
          if (!('observation' in settledRead)) {
            const stopped = stopReason();
            if (stopped) return { outcome: 'canceled', pose, reason: stopped };
            return { outcome: this.readFailureOutcome(settledRead), pose, reason: settledRead.reason };
          }
          const settled = settledRead.observation; pose = settled.pose;
          const settledIssue = this.observationIssue(settled);
          if (settledIssue) return { outcome: 'canceled', pose, reason: settledIssue };
          const settledSupport = observationSupport(settled);
          // Unknown is not airborne, but it also cannot prove a landing.
          if (settledSupport === 'unknown') return { outcome: 'unknown', pose, reason: 'landing-support-unknown' };
          if (settledSupport === 'unsupported') return { outcome: 'replan', pose, reason: 'landing-unsupported' };
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
      // Release is bounded: a hung release cannot keep the control loop alive.
      const outcome = await this.withWallTimeout(motor.release(), this.budget.releaseTimeoutMs);
      if (outcome.timedOut || outcome.error) this.releaseFailed = true;
    }
  }

  private motorFor(request: RunRequest): Pick<Motor3D, 'orientTo' | 'walk' | 'jumpShort' | 'stop' | 'release'> {
    return this.options.motor?.({ context: this.body.context, clock: this.clock, body: this.body, leaseId: request.leaseId, ownerToken: request.ownerToken })
      ?? new Motor3D({ context: this.body.context, clock: this.clock, body: this.body, leaseId: request.leaseId, ownerToken: request.ownerToken });
  }

  /**
   * Guarded observation (FEC-31). Every observe is bounded by the clock budget
   * and raced against a per-run AbortController, so pause/stop/external cancel
   * exit even when the adapter never settles. The per-call signal is also
   * handed to the adapter so cooperative implementations can abort their work.
   */
  private async readObservation(request: RunRequest): Promise<
    | { observation: WorldObservation }
    | { kind: 'timeout' | 'aborted' | 'error'; reason: string }
  > {
    void request;
    const runSignal = this.runController?.signal;
    if (runSignal?.aborted) return { kind: 'aborted', reason: 'observation-aborted' };
    const callController = new AbortController();
    const onRunAbort = () => callController.abort();
    if (runSignal) {
      if (runSignal.aborted) callController.abort();
      else runSignal.addEventListener('abort', onRunAbort, { once: true });
    }
    const startedAt = this.clock.now();
    const deadline = startedAt + this.budget.observeTimeoutMs;
    let timerId: string | undefined;
    const options: ObserveOptions = { signal: callController.signal, deadline };
    const timeout = new Promise<'timeout'>(resolve => {
      timerId = this.clock.schedule(deadline, () => resolve('timeout'));
    });
    let onAbortResolve: (() => void) | undefined;
    const aborted = new Promise<'aborted'>(resolve => {
      onAbortResolve = () => resolve('aborted');
      if (callController.signal.aborted) onAbortResolve();
      else callController.signal.addEventListener('abort', onAbortResolve, { once: true });
    });
    const observed = Promise.resolve()
      .then(() => this.body.observe(options))
      .then(
        observation => ({ kind: 'observation' as const, observation }),
        error => ({ kind: 'error' as const, error }),
      );
    try {
      const result = await Promise.race([observed, timeout, aborted]);
      if (result === 'timeout' || result === 'aborted') {
        // Best effort cancellation of the underlying adapter task; the caller is
        // already free, and the next observation will not queue behind this one.
        callController.abort();
        return { kind: result, reason: result === 'timeout' ? 'observation-timeout' : 'observation-aborted' };
      }
      if (result.kind === 'error') {
        const message = result.error instanceof Error ? result.error.message : String(result.error);
        return { kind: 'error', reason: `observation-failed:${message}` };
      }
      return { observation: result.observation };
    } finally {
      if (timerId !== undefined) this.clock.cancel(timerId);
      runSignal?.removeEventListener('abort', onRunAbort);
      if (onAbortResolve) callController.signal.removeEventListener('abort', onAbortResolve);
    }
  }

  private readFailureOutcome(read: { kind: 'timeout' | 'aborted' | 'error' }): 'unknown' | 'canceled' | 'failed' {
    if (read.kind === 'timeout' || read.kind === 'aborted') return 'unknown';
    return 'failed';
  }

  private async boundedStop(motor: Pick<Motor3D, 'stop'>): Promise<void> {
    const outcome = await this.withWallTimeout(motor.stop(), this.budget.stopTimeoutMs);
    if (outcome.timedOut || outcome.error) this.releaseFailed = true;
  }

  /** Wall-clock bound for terminal stop/release calls (no fresh observation needed). */
  private withWallTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T; error?: unknown }> {
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ timedOut: true });
      }, Math.max(1, timeoutMs));
      operation.then(
        value => { if (settled) return; settled = true; clearTimeout(timer); resolve({ timedOut: false, value }); },
        error => { if (settled) return; settled = true; clearTimeout(timer); resolve({ timedOut: false, error }); },
      );
    });
  }

  /**
   * Close the remaining distance inside the target block (FEC-32). A discrete
   * block match is only a planning anchor; final arrival requires the observed
   * pose within `tolerance` (default 0.25) of the block centre. Cardinal walks
   * can leave a perpendicular offset, which is corrected with bounded
   * short-range input while staying inside the target block. If the body cannot
   * walk, lacks support evidence, or cannot make progress, the result is
   * partial - never confirmed.
   */
  private async settleAtTarget(
    target: BlockPos,
    tolerance: number,
    request: RunRequest,
    tick: () => number,
    stopReason: () => string | undefined,
    budgetExhausted: () => boolean,
    initial: WorldObservation,
  ): Promise<{ outcome: 'confirmed' | 'canceled' | 'partial'; pose?: Pose3D; reason?: string }> {
    let observation = initial;
    let pose = observation.pose;
    let support = observationSupport(observation);
    if (support === 'unknown') return { outcome: 'partial', pose, reason: 'support-unknown' };
    if (support === 'unsupported') return { outcome: 'partial', pose, reason: 'support-unsupported' };
    if (!this.body.capabilities.threeDimensional || !this.body.capabilities.walk) return { outcome: 'partial', pose, reason: 'arrival-tolerance-not-met' };
    if (withinArrivalTolerance(pose, target, tolerance)) return { outcome: 'confirmed', pose };

    const motor = this.motorFor(request);
    let issued = false;
    let lastSign: { x: number; z: number } | undefined;
    try {
      for (let index = 0; index < this.budget.maxTicksPerStep; index++) {
        const stop = stopReason();
        if (stop) return { outcome: 'canceled', pose, reason: stop };
        if (budgetExhausted()) return { outcome: 'partial', pose, reason: 'control-budget-exhausted' };
        const block = poseBlock(pose);
        // Short-range correction never leaves the target block. If the pose is
        // outside it, this is not a same-cell arrival at all.
        if (block.x !== target.x || block.y !== target.y || block.z !== target.z) return { outcome: 'partial', pose, reason: 'arrival-tolerance-not-met' };
        const center = targetCenter(target);
        const direction = { x: center.x - pose.x, y: 0, z: center.z - pose.z };
        if (withinArrivalTolerance(pose, target, tolerance)) return { outcome: 'confirmed', pose };
        const sign = { x: Math.sign(direction.x), z: Math.sign(direction.z) };
        // Held input keeps applying until replaced or released. Re-submitting
        // every tick would continuously reset a latent plan and (with injected
        // latency) never let it take effect, so only re-issue when the needed
        // direction actually changes (for example after crossing the centre).
        if (!issued || !lastSign || sign.x !== lastSign.x || sign.z !== lastSign.z) {
          const submission = await motor.walk(target, direction, observation);
          if (submission.status !== 'accepted') return { outcome: 'partial', pose, reason: submission.reason ?? 'arrival-input-rejected' };
          this.inputIssued = true;
          issued = true;
          lastSign = sign;
        }
        await this.advanceBody(); tick();
        const read = await this.readObservation(request);
        if (!('observation' in read)) {
          const stopped = stopReason();
          if (stopped) return { outcome: 'canceled', pose, reason: stopped };
          return { outcome: 'partial', pose, reason: read.reason };
        }
        observation = read.observation; pose = observation.pose;
        const issue = this.observationIssue(observation);
        if (issue) return { outcome: 'partial', pose, reason: issue };
        support = observationSupport(observation);
        if (support === 'unknown') return { outcome: 'partial', pose, reason: 'support-unknown' };
        if (support === 'unsupported') return { outcome: 'partial', pose, reason: 'support-unsupported' };
      }
      return { outcome: 'partial', pose, reason: 'arrival-tolerance-not-met' };
    } finally {
      if (issued) await this.boundedStop(motor);
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

  /**
   * Final arrival requires supported evidence AND the continuous pose to be
   * within tolerance of the block centre. Being in the same discrete block is
   * not sufficient (FEC-32); `settleAtTarget` performs the bounded local
   * correction before this check is used to confirm.
   */
  private reached(pose: Pose3D, target: BlockPos, tolerance: number, support: SupportState): boolean {
    if (support !== 'supported') return false;
    const block = poseBlock(pose);
    if (block.x !== target.x || block.y !== target.y || block.z !== target.z) return false;
    return withinArrivalTolerance(pose, target, tolerance);
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
    let outcome: { timedOut: boolean; error?: unknown };
    try {
      outcome = await this.withWallTimeout(this.body.release(this.currentOwnerToken), this.budget.releaseTimeoutMs);
    } catch (error) {
      outcome = { timedOut: false, error };
    }
    // A rejecting or unsettled sink may still hold input. Report that honestly
    // instead of claiming release succeeded. Never touches a different owner.
    if (outcome.timedOut || outcome.error) this.releaseFailed = true;
  }

  private async stopAndRelease(): Promise<void> {
    // `run` owns the token for this invocation; stop() zeroes held motion, then release is authoritative.
    if (this.inputIssued && this.currentOwnerToken) {
      try {
        await this.withWallTimeout(this.body.submit({
          commandId: `stop-${this.currentOwnerToken}`, ownerToken: this.currentOwnerToken, leaseId: this.currentLeaseId ?? 'lease',
          issuedAt: this.clock.now(), deadline: this.clock.now() + 250, maxAge: 250, context: this.body.context,
          observationRef: 'stop', intent: { kind: 'stop' },
        }), this.budget.stopTimeoutMs);
        // A timed-out stop still falls through to release: the owner token is
        // the authoritative held-input boundary and release must be attempted.
      } catch { /* fall through to release */ }
    }
    await this.releaseInput();
    this.releasePromise ??= Promise.resolve();
  }
}
