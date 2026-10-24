import type { ActionCapability, ActionEdge, ActionKind, BlockPos, NavRoute, PlanResult, PlanStatus, Pose3D, RouteStep } from './types.js';
import { DEFAULT_MOVEMENT_CAPABILITIES, EVIDENCED_MOVEMENT_ACTIONS } from './types.js';
import type { SparseVoxelWorld } from './geometry.js';
import { blockKey } from './geometry.js';

export const BODY_HALF_WIDTH = 0.35;
export const BODY_HEIGHT = 1.8;
export const LANDING_TOLERANCE = 0.35;
/** The only validated jump profile in this batch rises exactly one block. */
export const JUMP_MAX_RISE = 1;
/**
 * Conservative vertical envelope of the fixture jump arc. The landing rise is
 * one block; the body's head can rise further, so headroom checks and the
 * execution-time arc validation cover this apex, not just the landing cell.
 */
export const JUMP_APEX = 1.9;

const bodyAabb = (p: BlockPos) => ({ minX: p.x + 0.15, minY: p.y, maxX: p.x + 0.85, maxY: p.y + BODY_HEIGHT, minZ: p.z + 0.15, maxZ: p.z + 0.85 });
const headroomAabb = (p: BlockPos) => ({ minX: p.x + 0.15, minY: p.y + BODY_HEIGHT, maxX: p.x + 0.85, maxY: p.y + BODY_HEIGHT + JUMP_APEX, minZ: p.z + 0.15, maxZ: p.z + 0.85 });

const makeEdge = (kind: ActionKind, from: BlockPos, to: BlockPos, snapshotRevision: string, clearance: string[], takeoffHeadroom?: string[]): ActionEdge => {
  const support = blockKey({ ...to, y: to.y - 1 });
  return {
    edgeId: `${kind}:${blockKey(from)}>${blockKey(to)}`,
    kind,
    from: { ...from },
    to: { ...to },
    primitiveId: kind === 'jump_short' ? 'jump_short' : 'walk_corridor',
    primitiveVersion: 'motor-v1',
    dependencies: [...new Set([...clearance, support, blockKey(to), ...(takeoffHeadroom ?? [])])],
    snapshotRevision,
    risk: kind === 'jump_short' ? 'elevated' : 'normal',
    preconditions: { support, clearance, ...(takeoffHeadroom ? { takeoffHeadroom } : {}) },
    landingTolerance: LANDING_TOLERANCE,
  };
};

export type ActionPlannerOptions = {
  maxExpansions?: number;
  yieldEvery?: number;
  /** Only implemented transitions are honoured; unsupported requests are ignored. */
  capabilities?: readonly ActionCapability[];
  /** Edges temporarily marked as failing; they are not expanded until their expiry. */
  avoidEdges?: ReadonlySet<string>;
};

type OpenNode = { at: BlockPos; edges: ActionEdge[]; cost: number; priority: number };
type Candidate = { kind: 'edge'; edge: ActionEdge } | { kind: 'unknown' } | { kind: 'unsupported' };
/**
 * Bounded 3D A* over a sparse voxel world.
 *
 * Evidence rules:
 * - unknown geometry is not air: it prevents the edge and is reported as a
 *   concrete observation gap rather than a silent wall;
 * - every step needs a real support surface (air beneath is not support);
 * - only flat walking and a single, headroom-checked one-block jump are
 *   enabled. Slabs/drops exist as types but are never emitted.
 */
export class ActionPlanner {
  private readonly maxExpansions: number;
  private readonly yieldEvery: number;
  private readonly capabilities: ReadonlySet<ActionCapability>;
  private readonly avoidEdges: ReadonlySet<string>;
  /** Snapshot revision for the current plan call; edges must not clone the world per candidate. */
  private currentRevision = '';
  constructor(private readonly world: SparseVoxelWorld, options: ActionPlannerOptions | number = {}) {
    const normalized = typeof options === 'number' ? { maxExpansions: options } : options;
    this.maxExpansions = normalized.maxExpansions ?? 20000;
    this.yieldEvery = normalized.yieldEvery ?? 256;
    // Intersect the request with the implemented list: asking for step_up or a
    // controlled drop never produces an edge without a validated controller.
    const requested = new Set(normalized.capabilities ?? DEFAULT_MOVEMENT_CAPABILITIES);
    this.capabilities = new Set(EVIDENCED_MOVEMENT_ACTIONS.filter(action => requested.has(action)));
    this.avoidEdges = normalized.avoidEdges ?? new Set();
  }

  get supportedActions(): readonly ActionKind[] { return [...this.capabilities]; }

  plan(start: BlockPos, target: BlockPos): PlanResult {
    const route = this.planRoute(start, target);
    return {
      status: route.status,
      edges: route.steps.map(step => step.edge),
      expanded: route.expanded,
      snapshotRevision: route.snapshotRevision,
      stableEndpoint: route.stableEndpoint,
      dependencies: route.dependencies,
      supportedActions: route.supportedActions,
      ...(route.reason ? { reason: route.reason } : {}),
    };
  }

  planRoute(start: BlockPos, target: BlockPos): NavRoute {
    const snap = this.world.snapshot();
    this.currentRevision = snap.revision;
    const supportedActions: readonly ActionKind[] = [...this.capabilities];
    const base = { expanded: 0, snapshotRevision: snap.revision, observationRevision: snap.revision, supportedActions, dependencies: [] as string[], steps: [] as RouteStep[] };
    const targetKey = blockKey(target);
    const startKey = blockKey(start);
    // A route may only start from a stable, observed cell. Otherwise the caller
    // must observe/settle first; inventing a start state is not planning.
    const startClearance = this.world.queryAabb(bodyAabb(start));
    if (startClearance.status === 'unknown') return { ...base, status: 'NEEDS_OBSERVATION', reason: `unknown-start-clearance:${startKey}` };
    if (startClearance.status !== 'clear') return { ...base, status: 'NO_PATH_IN_KNOWN_GRAPH', reason: `start-not-stable:${startKey}` };
    const startSupport = this.world.support(start);
    if (startSupport.status === 'unknown') return { ...base, status: 'NEEDS_OBSERVATION', reason: `unknown-start-support:${startKey}` };
    if (startSupport.status !== 'blocked') return { ...base, status: 'NO_PATH_IN_KNOWN_GRAPH', reason: `start-unsupported:${startKey}` };

    const open: OpenNode[] = [{ at: { ...start }, edges: [], cost: 0, priority: this.heuristic(start, target) }];
    const best = new Map<string, number>([[startKey, 0]]);
    let expanded = 0;
    let needsObservation = false;
    let unsupportedTransition = false;

    while (open.length) {
      if (expanded++ >= this.maxExpansions) return { ...base, expanded, status: 'BUDGET_EXHAUSTED', reason: `expansion-budget:${this.maxExpansions}` };
      // Small deterministic priority queue: local maps are bounded, insertion sort keeps A* stable.
      open.sort((a, b) => a.priority - b.priority || a.cost - b.cost || blockKey(a.at).localeCompare(blockKey(b.at)));
      const node = open.shift()!;
      if (blockKey(node.at) === targetKey) {
        const steps = node.edges.map(edge => this.asStep(edge));
        return { ...base, status: 'COMPLETE', steps, expanded, dependencies: [...new Set(node.edges.flatMap(edge => edge.dependencies))], stableEndpoint: this.centerOf(target) };
      }
      for (const candidate of this.neighbours(node.at)) {
        if (candidate.kind === 'unsupported') { unsupportedTransition = true; continue; }
        if (candidate.kind === 'unknown') { needsObservation = true; continue; }
        const edge = candidate.edge;
        if (this.avoidEdges.has(edge.edgeId)) continue;
        const nextKey = blockKey(edge.to);
        const nextCost = node.cost + (edge.kind === 'jump_short' ? 2 : 1);
        if ((best.get(nextKey) ?? Number.POSITIVE_INFINITY) <= nextCost) continue;
        best.set(nextKey, nextCost);
        open.push({ at: edge.to, edges: [...node.edges, edge], cost: nextCost, priority: nextCost + this.heuristic(edge.to, target) });
      }
      if (expanded % this.yieldEvery === 0) void Promise.resolve();
    }

    const status: PlanStatus = needsObservation ? 'NEEDS_OBSERVATION' : unsupportedTransition ? 'UNSUPPORTED_TRANSITION' : 'NO_PATH_IN_KNOWN_GRAPH';
    const reason = needsObservation
      ? 'unknown-geometry-not-air'
      : unsupportedTransition
        ? 'no-validated-controller-for-transition'
        : 'no-path-in-known-graph';
    return { ...base, expanded, status, reason };
  }

  /**
   * Re-validate every expected precondition against a fresh world before
   * execution. Missing/unknown cells invalidate the step; they are never
   * treated as air. `start` additionally checks the from/to chain.
   */
  validateRoute(route: NavRoute, world: SparseVoxelWorld = this.world, options: { start?: BlockPos } = {}): { ok: boolean; invalidStep?: number; reason?: string } {
    if (route.status !== 'COMPLETE' || route.steps.length === 0) return { ok: false, reason: `route-not-executable:${route.status}` };
    let expectedFrom = options.start;
    for (let index = 0; index < route.steps.length; index++) {
      const step = route.steps[index]!;
      if (!EVIDENCED_MOVEMENT_ACTIONS.includes(step.edge.kind as ActionCapability)) return { ok: false, invalidStep: index, reason: `unsupported-action:${step.edge.kind}` };
      if (expectedFrom && blockKey(step.edge.from) !== blockKey(expectedFrom)) return { ok: false, invalidStep: index, reason: `route-chain-broken:${step.edge.edgeId}` };
      const support = world.support(step.edge.to);
      if (support.status === 'unknown') return { ok: false, invalidStep: index, reason: `unknown-support:${step.expected.support}` };
      if (support.status !== 'blocked') return { ok: false, invalidStep: index, reason: `unsupported-landing:${step.expected.support}` };
      const clearance = world.queryAabb(bodyAabb(step.edge.to));
      if (clearance.status === 'unknown') return { ok: false, invalidStep: index, reason: `unknown-clearance:${step.expected.clearance.join(',')}` };
      if (clearance.status !== 'clear') return { ok: false, invalidStep: index, reason: `blocked-clearance:${step.edge.edgeId}` };
      if (step.edge.kind === 'jump_short') {
        const headroom = world.queryAabb(headroomAabb(step.edge.from));
        if (headroom.status === 'unknown') return { ok: false, invalidStep: index, reason: 'unknown-takeoff-headroom' };
        if (headroom.status !== 'clear') return { ok: false, invalidStep: index, reason: 'blocked-takeoff-headroom' };
        // The arc is re-checked against the fresh world: an obstacle inserted
        // after planning must invalidate the jump before any input is issued.
        const arc = this.swept(world, step.edge.from, step.edge.to, 1);
        if (arc.status === 'unknown') return { ok: false, invalidStep: index, reason: 'unknown-jump-arc' };
        if (arc.status !== 'clear') return { ok: false, invalidStep: index, reason: 'blocked-jump-arc' };
      }
      expectedFrom = step.edge.to;
    }
    return { ok: true };
  }

  private asStep(edge: ActionEdge): RouteStep {
    return { edge, observationRevision: edge.snapshotRevision, landingTolerance: edge.landingTolerance, expected: edge.preconditions };
  }

  private neighbours(at: BlockPos): Candidate[] {
    const candidates: Candidate[] = [];
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const;
    if (this.capabilities.has('walk')) {
      for (const [dx, dy, dz] of dirs) candidates.push(this.evaluateWalk(at, { x: at.x + dx, y: at.y + dy, z: at.z + dz }));
    }
    if (this.capabilities.has('jump_short')) {
      // A defined short jump raises the body by exactly one block into an
      // adjacent column. It is never inferred from a wall or missing support;
      // the takeoff headroom and landing support are checked before admission.
      for (const [dx, , dz] of dirs) candidates.push(this.evaluateJump(at, { x: at.x + dx, y: at.y + JUMP_MAX_RISE, z: at.z + dz }));
    }
    return candidates;
  }

  private evaluateWalk(from: BlockPos, to: BlockPos): Candidate {
    const clearance = this.world.queryAabb(bodyAabb(to));
    if (clearance.status === 'unknown') return { kind: 'unknown' };
    if (clearance.status === 'unsupported') return { kind: 'unsupported' };
    if (clearance.status !== 'clear') return { kind: 'unsupported' };
    const floor = this.world.support(to);
    if (floor.status === 'unknown') return { kind: 'unknown' };
    // Air beneath the body is not support: walking off an edge is a fall, not a walk.
    if (floor.status !== 'blocked') return { kind: 'unsupported' };
    const sweep = this.swept(this.world, from, to);
    if (sweep.status === 'unknown') return { kind: 'unknown' };
    if (sweep.status !== 'clear') return { kind: 'unsupported' };
    return { kind: 'edge', edge: makeEdge('walk', from, to, this.currentRevision, clearance.dependencies) };
  }

  private evaluateJump(from: BlockPos, to: BlockPos): Candidate {
    const clearance = this.world.queryAabb(bodyAabb(to));
    if (clearance.status === 'unknown') return { kind: 'unknown' };
    if (clearance.status === 'unsupported' || clearance.status !== 'clear') return { kind: 'unsupported' };
    const floor = this.world.support(to);
    if (floor.status === 'unknown') return { kind: 'unknown' };
    if (floor.status !== 'blocked') return { kind: 'unsupported' };
    const headroom = this.world.queryAabb(headroomAabb(from));
    if (headroom.status === 'unknown') return { kind: 'unknown' };
    if (headroom.status !== 'clear') return { kind: 'unsupported' };
    // For a jump the swept volume starts one block above the takeoff feet so the
    // raised landing block itself is not mistaken for an obstruction during the arc.
    const sweep = this.swept(this.world, from, to, 1);
    if (sweep.status === 'unknown') return { kind: 'unknown' };
    if (sweep.status !== 'clear') return { kind: 'unsupported' };
    return { kind: 'edge', edge: makeEdge('jump_short', from, to, this.currentRevision, clearance.dependencies, headroom.dependencies) };
  }

  private swept(world: SparseVoxelWorld, a: BlockPos, b: BlockPos, minYOffset = 0) {
    const minX = Math.min(a.x, b.x) + 0.15, maxX = Math.max(a.x, b.x) + 0.85;
    const minZ = Math.min(a.z, b.z) + 0.15, maxZ = Math.max(a.z, b.z) + 0.85;
    return world.queryAabb({ minX, minY: Math.min(a.y, b.y) + minYOffset, minZ, maxX, maxY: Math.max(a.y, b.y) + BODY_HEIGHT + minYOffset, maxZ });
  }

  private heuristic(a: BlockPos, b: BlockPos): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) * 2 + Math.abs(a.z - b.z);
  }

  private centerOf(pos: BlockPos): Pose3D {
    return { x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5, yaw: 0, pitch: 0 };
  }
}

export { blockKey };
