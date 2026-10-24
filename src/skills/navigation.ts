import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import { nextId, type Clock } from '../contracts/index.js';
import type { BodyAdapter, WorldObservation } from '../motor/contracts.js';
import { getAttachedBodyAdapter, isReal3DObservation, resolveTarget3D } from '../motor/contracts.js';
import type { BlockPos } from '../motor/types.js';
import { MotionController, type ControlBudget, type NavigationResult as BodyControllerResult, type TargetRevision } from '../motor/controller.js';
import { observationUsable, poseBlock, poseDistance, worldFromObservation } from '../motor/route.js';

export type NavigationResult = { executionId: string; status: 'succeeded' | 'failed'; path: string[]; reason?: string };

/**
 * Legacy 2D planar navigation. Kept only for the explicitly simulated/legacy
 * profile and the offline demo; production movement goes through
 * `navigateToBody` and the asynchronous 3D body contract. This function must
 * never be used as evidence of 3D control.
 */
export function navigate(bridge: ClientBridgeCapabilities, target: { x: number; y: number }, budget = 3): NavigationResult {
  const executionId = nextId('exec');
  const path: string[] = [];
  for (let attempt = 0; attempt <= budget; attempt++) {
    const q = [{ x: bridge.position.x, y: bridge.position.y, path: [] as string[] }];
    const seen = new Set([`${bridge.position.x},${bridge.position.y}`]);
    let found: string[] | undefined;
    while (q.length) {
      const n = q.shift()!;
      if (n.x === target.x && n.y === target.y) { found = n.path; break; }
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const x = n.x + dx, y = n.y + dy, k = `${x},${y}`;
        if (x >= 0 && y >= 0 && x < bridge.size && y < bridge.size && !seen.has(k) && bridge.cell(x, y) === 'free') { seen.add(k); q.push({ x, y, path: [...n.path, k] }); }
      }
    }
    if (!found) return { executionId, status: 'failed', path, reason: 'no-known-path' };
    try {
      for (const k of found) {
        const [x, y] = k.split(',').map(Number) as [number, number];
        const before = `${bridge.position.x},${bridge.position.y}`;
        bridge.walk(x, y);
        // A silent drop leaves the body in place; the step did not happen, so the route is void.
        if (`${bridge.position.x},${bridge.position.y}` === before) return { executionId, status: 'failed', path, reason: 'walk-dropped' };
        path.push(k);
      }
      // Success means the body actually reached the target, not that the planned steps ran.
      if (bridge.position.x !== target.x || bridge.position.y !== target.y) return { executionId, status: 'failed', path, reason: 'target-not-reached' };
      return { executionId, status: 'succeeded', path };
    } catch {
      if (attempt === budget) return { executionId, status: 'failed', path, reason: 'replan-budget-exhausted' };
    }
  }
  return { executionId, status: 'failed', path, reason: 'unreachable' };
}

export type BodyNavigationOptions = {
  leaseId: string;
  ownerToken: string;
  tolerance?: number;
  /** Local replan budget; defaults to the controller's bounded default. */
  maxReplans?: number;
  budget?: Partial<ControlBudget>;
  signal?: AbortSignal;
  isPaused?: () => boolean;
  watch?: () => string | undefined;
  targetRevision?: TargetRevision;
  onLeaseRevoke?: (reason: string) => void;
  onProgress?: (stage: 'plan' | 'execute' | 'verify', completed: number, total: number, message: string) => void;
};

export type ResolvedNavigationTarget = { target: BlockPos; mapping: 'explicit-xyz' | 'planar-xz-current-y' | 'legacy-2d-xz'; derived: boolean; observation: WorldObservation };

/** Resolve a caller target against one observation, recording how any planar legacy input was mapped. */
export async function resolveNavigationTarget(body: BodyAdapter, target: { x: number; y: number; z?: number }): Promise<ResolvedNavigationTarget> {
  const observation = await body.observe();
  const resolved = resolveTarget3D(observation, target);
  return { ...resolved, observation };
}

/**
 * P11/P12: plan and execute a 3D route through the injected body adapter. The
 * controller re-observes, re-validates and locally replans; this helper only
 * maps the outcome and records route evidence.
 */
export async function navigateBody(body: BodyAdapter, clock: Clock, target: BlockPos, options: BodyNavigationOptions): Promise<BodyControllerResult & { executionId: string; path: string[] }> {
  const executionId = nextId('exec');
  const controller = new MotionController(body, clock, {
    ...(options.budget ? { budget: options.budget } : {}),
    ...(options.maxReplans !== undefined ? { budget: { ...(options.budget ?? {}), maxReplans: options.maxReplans } } : {}),
    ...(options.onLeaseRevoke ? { onLeaseRevoke: options.onLeaseRevoke } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  const result = await controller.run({
    target,
    leaseId: options.leaseId,
    ownerToken: options.ownerToken,
    ...(options.tolerance !== undefined ? { tolerance: options.tolerance } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.isPaused ? { isPaused: options.isPaused } : {}),
    ...(options.watch ? { watch: options.watch } : {}),
    ...(options.targetRevision ? { targetRevision: options.targetRevision } : {}),
  });
  const path = (result.route?.steps ?? []).map(step => `${step.edge.to.x},${step.edge.to.y},${step.edge.to.z}`);
  return { ...result, executionId, path };
}

/**
 * Resolve a caller target and execute it. Explicit `z` is used verbatim; a
 * planar `x/y` is mapped explicitly to world x/z at the current y and the
 * mapping is returned, never silently padded with `z = 0`.
 */
export async function navigateToBody(
  body: BodyAdapter,
  clock: Clock,
  target: { x: number; y: number; z?: number },
  options: BodyNavigationOptions,
): Promise<BodyControllerResult & { executionId: string; path: string[]; targetMapping: ResolvedNavigationTarget['mapping']; derivedTarget: boolean; target: BlockPos }> {
  const resolved = await resolveNavigationTarget(body, target);
  const result = await navigateBody(body, clock, resolved.target, options);
  return { ...result, targetMapping: resolved.mapping, derivedTarget: resolved.derived, target: resolved.target };
}

/** Navigate to a remembered place. Missing capability or place fails closed. */
export async function returnToPlaceBody(
  body: BodyAdapter,
  clock: Clock,
  placeId: string,
  options: BodyNavigationOptions,
): Promise<BodyControllerResult & { executionId: string; path: string[]; placeId: string }> {
  if (!body.findPlace) {
    return { ...failedNavigation('place-navigation-capability-unavailable'), placeId };
  }
  const place = await body.findPlace(placeId);
  if (!place) return { ...failedNavigation(`unknown-place:${placeId}`), placeId };
  const result = await navigateBody(body, clock, place, options);
  return { ...result, placeId };
}

/** Choose a deterministic reachable frontier cell from the observed local volume. */
export function selectExploreTarget(body: BodyAdapter, observation: WorldObservation, radius: number): BlockPos | undefined {
  const usable = observationUsable(observation, { maxAgeMs: 500, now: observation.observedAt, context: body.context });
  if (!usable.ok || !isReal3DObservation(observation)) return undefined;
  const world = worldFromObservation(observation);
  const origin = poseBlock(observation.pose);
  let best: { pos: BlockPos; distance: number } | undefined;
  for (const cell of observation.cells.values()) {
    if (cell.cell !== 'free') continue;
    const dx = Math.abs(cell.pos.x - origin.x), dz = Math.abs(cell.pos.z - origin.z), dy = Math.abs(cell.pos.y - origin.y);
    if (dx > radius || dz > radius || dy > 1) continue;
    if (dx + dz === 0) continue;
    if (world.support(cell.pos).status !== 'blocked') continue;
    if (world.queryAabb({ minX: cell.pos.x + 0.15, minY: cell.pos.y, minZ: cell.pos.z + 0.15, maxX: cell.pos.x + 0.85, maxY: cell.pos.y + 1.8, maxZ: cell.pos.z + 0.85 }).status !== 'clear') continue;
    const distance = dx + dz;
    if (!best || distance > best.distance) best = { pos: { ...cell.pos }, distance };
  }
  return best?.pos;
}

/** Observe, choose a frontier, then drive it through the same motor chain. */
export async function exploreBody(
  body: BodyAdapter,
  clock: Clock,
  radius: number,
  options: BodyNavigationOptions,
): Promise<BodyControllerResult & { executionId: string; path: string[]; exploreTarget?: BlockPos }> {
  const observation = await body.observe();
  const target = selectExploreTarget(body, observation, radius);
  if (!target) {
    return { ...failedNavigation('no-executable-frontier') };
  }
  const result = await navigateBody(body, clock, target, options);
  return { ...result, exploreTarget: target };
}

export type GatherBodyResult = {
  executionId: string;
  status: 'confirmed' | 'partial' | 'failed' | 'canceled';
  reason?: string;
  target?: BlockPos;
  navigation?: { executionId: string; status: string; path: string[]; reason?: string };
  collected: number;
  items: string[];
  observedFree: boolean;
};

export type GatherBodyOptions = BodyNavigationOptions & {
  /** Called after navigation and immediately before the durable-effect dispatch boundary. */
  onBeforeDig?: () => void;
};

/**
 * P11 gather path: find an observed block, navigate to a supported standing
 * cell next to it through the motor chain, then dig. Success requires an
 * observation showing the target free; an accepted dig receipt alone is not
 * evidence.
 */
export async function gatherBody(body: BodyAdapter, clock: Clock, block: string, options: GatherBodyOptions): Promise<GatherBodyResult> {
  const executionId = nextId('exec');
  if (!body.findBlock || !body.digBlock) return { executionId, status: 'failed', reason: 'gather-capability-unavailable', collected: 0, items: [], observedFree: false };
  const target = await body.findBlock(block);
  if (!target) return { executionId, status: 'failed', reason: `no-observed-block:${block}`, collected: 0, items: [], observedFree: false };
  const observation = await body.observe();
  const stand = standingPosition(observation, target);
  if (!stand) return { executionId, status: 'failed', reason: 'no-supported-standing-cell', target, collected: 0, items: [], observedFree: false };
  const current = poseBlock(observation.pose);
  let navigation;
  if (stand.x !== current.x || stand.y !== current.y || stand.z !== current.z) {
    navigation = await navigateBody(body, clock, stand, options);
    if (navigation.status !== 'confirmed') {
      return { executionId, status: navigation.status === 'canceled' ? 'canceled' : 'failed', reason: navigation.reason ?? 'navigation-failed', target, navigation: { executionId: navigation.executionId, status: navigation.status, path: navigation.path, ...(navigation.reason ? { reason: navigation.reason } : {}) }, collected: 0, items: [], observedFree: false };
    }
  }
  // Navigation is not the side effect; the dispatch boundary is immediately
  // before the dig so the caller can persist its barrier while all preconditions
  // (position, observed target) are already satisfied.
  options.onBeforeDig?.();
  const dig = await body.digBlock(target, block);
  const after = await body.observe();
  const observed = after.cells.get(`${target.x},${target.y},${target.z}`);
  const observedFree = observed?.cell === 'free';
  if (!dig.accepted) return { executionId, status: dig.ambiguous ? 'partial' : 'failed', reason: dig.ambiguous ? 'dig-ambiguous' : 'dig-rejected', target, ...(navigation ? { navigation: { executionId: navigation.executionId, status: navigation.status, path: navigation.path } } : {}), collected: dig.collected, items: dig.items, observedFree };
  return {
    executionId,
    status: observedFree ? 'confirmed' : 'partial',
    ...(observedFree ? {} : { reason: 'target-not-observed-free' }),
    target,
    ...(navigation ? { navigation: { executionId: navigation.executionId, status: navigation.status, path: navigation.path } } : {}),
    collected: dig.collected, items: dig.items, observedFree,
  };
}

function standingPosition(observation: WorldObservation, target: BlockPos): BlockPos | undefined {
  const world = worldFromObservation(observation);
  const origin = poseBlock(observation.pose);
  let best: { pos: BlockPos; distance: number } | undefined;
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]] as const) {
    const pos = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
    if (world.get(pos).cell !== 'free' && !(pos.x === origin.x && pos.y === origin.y && pos.z === origin.z)) continue;
    if (world.support(pos).status !== 'blocked') continue;
    const clearance = world.queryAabb({ minX: pos.x + 0.15, minY: pos.y, minZ: pos.z + 0.15, maxX: pos.x + 0.85, maxY: pos.y + 1.8, maxZ: pos.z + 0.85 });
    if (clearance.status !== 'clear') continue;
    const distance = Math.abs(pos.x - origin.x) + Math.abs(pos.y - origin.y) + Math.abs(pos.z - origin.z);
    if (!best || distance < best.distance) best = { pos, distance };
  }
  return best?.pos;
}

/** Map a controller result onto the skill contract shape used by `skills.ts`. */
export function toSkillResult(result: BodyControllerResult & { path?: string[]; reason?: string }): { ok: boolean; outcome: 'confirmed' | 'partial' | 'ambiguous' | 'failed' | 'canceled'; value?: unknown; reason?: string } {
  const outcome = result.status === 'confirmed' ? 'confirmed' : result.status === 'partial' ? 'partial' : result.status === 'canceled' ? 'canceled' : 'failed';
  return outcome === 'confirmed'
    ? { ok: true, outcome, value: result }
    : { ok: false, outcome, value: result, ...(result.reason ? { reason: result.reason } : {}) };
}

export type BodySkillResult = { ok: boolean; outcome: 'confirmed' | 'partial' | 'ambiguous' | 'failed' | 'canceled'; value?: unknown; reason?: string };
export type BodySkillContext = {
  bridge: object;
  lease: { leaseId: string; owner: string };
  report: (progress: { stage: 'prepare' | 'dispatch' | 'verify' | 'complete'; completed: number; total?: number; message?: string }) => void;
  isCanceled?: () => boolean;
  isPaused?: () => boolean;
  clock?: Clock;
};

/**
 * Production skill adapter. `skills.ts` only needs to call this when an
 * attached BodyAdapter exists:
 *
 *   const body = getAttachedBodyAdapter(ctx.bridge);
 *   if (body) return navigateToSkill(ctx, target);
 *
 * It fails closed when a 3D body is attached but no clock is supplied.
 */
export async function navigateToSkill(ctx: BodySkillContext, target: { x: number; y: number; z?: number }, budget = 3): Promise<BodySkillResult> {
  const body = getAttachedBodyAdapter(ctx.bridge);
  if (!body) return { ok: false, outcome: 'failed', reason: 'body-adapter-unavailable' };
  const clock = body.clock ?? ctx.clock;
  if (!clock) return { ok: false, outcome: 'failed', reason: 'clock-required' };
  const result = await navigateToBody(body, clock, target, {
    leaseId: ctx.lease.leaseId,
    ownerToken: ctx.lease.owner,
    maxReplans: budget,
    ...(ctx.isPaused ?? ctx.isCanceled ? { isPaused: ctx.isPaused ?? ctx.isCanceled } : {}),
    onProgress: (stage, completed, total, message) => ctx.report({ stage: stage === 'plan' ? 'dispatch' : 'verify', completed, total, message }),
  });
  return toSkillResult(result);
}

export async function returnToPlaceSkill(ctx: BodySkillContext, placeId: string, budget = 3): Promise<BodySkillResult> {
  const body = getAttachedBodyAdapter(ctx.bridge);
  if (!body) return { ok: false, outcome: 'failed', reason: 'body-adapter-unavailable' };
  const clock = body.clock ?? ctx.clock;
  if (!clock) return { ok: false, outcome: 'failed', reason: 'clock-required' };
  const result = await returnToPlaceBody(body, clock, placeId, { leaseId: ctx.lease.leaseId, ownerToken: ctx.lease.owner, maxReplans: budget, ...(ctx.isPaused ?? ctx.isCanceled ? { isPaused: ctx.isPaused ?? ctx.isCanceled } : {}) });
  return toSkillResult(result);
}

export async function exploreAreaSkill(ctx: BodySkillContext, radius: number, budget = 3): Promise<BodySkillResult> {
  const body = getAttachedBodyAdapter(ctx.bridge);
  if (!body) return { ok: false, outcome: 'failed', reason: 'body-adapter-unavailable' };
  const clock = body.clock ?? ctx.clock;
  if (!clock) return { ok: false, outcome: 'failed', reason: 'clock-required' };
  const result = await exploreBody(body, clock, radius, { leaseId: ctx.lease.leaseId, ownerToken: ctx.lease.owner, maxReplans: budget, ...(ctx.isPaused ?? ctx.isCanceled ? { isPaused: ctx.isPaused ?? ctx.isCanceled } : {}) });
  return toSkillResult(result);
}

export async function gatherBlocksSkill(ctx: BodySkillContext, block: string, budget = 3): Promise<BodySkillResult> {
  const body = getAttachedBodyAdapter(ctx.bridge);
  if (!body) return { ok: false, outcome: 'failed', reason: 'body-adapter-unavailable' };
  const clock = body.clock ?? ctx.clock;
  if (!clock) return { ok: false, outcome: 'failed', reason: 'clock-required' };
  const result = await gatherBody(body, clock, block, { leaseId: ctx.lease.leaseId, ownerToken: ctx.lease.owner, maxReplans: budget, ...(ctx.isPaused ?? ctx.isCanceled ? { isPaused: ctx.isPaused ?? ctx.isCanceled } : {}), onBeforeDig: () => ctx.report({ stage: 'dispatch', completed: 0, total: 1, message: 'dig' }) });
  const outcome = result.status === 'confirmed' ? 'confirmed' : result.status === 'partial' ? 'partial' : result.status === 'canceled' ? 'canceled' : 'failed';
  return outcome === 'confirmed'
    ? { ok: true, outcome, value: result }
    : { ok: false, outcome, value: result, ...(result.reason ? { reason: result.reason } : {}) };
}

/** Distance from the body to the target block center; helper for diagnostics/tests. */
export function targetDistance(observation: WorldObservation, target: BlockPos): number {
  return poseDistance(observation.pose, { x: target.x + 0.5, y: target.y, z: target.z + 0.5, yaw: 0, pitch: 0 });
}

function failedNavigation(reason: string): BodyControllerResult & { executionId: string; path: string[] } {
  return {
    executionId: nextId('exec'), status: 'failed', outcome: 'failed', reason, reasonCode: reason,
    pose: null, ticks: 0, replans: 0, released: true,
    target: null,
    evidence: 'simulated-control-loop', temporaryFailures: [], path: [],
  };
}
