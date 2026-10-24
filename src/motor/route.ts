import type { BodyContext } from '../contracts/index.js';
import type { BodySource, WorldObservation } from './contracts.js';
import { FULL_BODY_HEIGHT } from './contracts.js';
import { SparseVoxelWorld, blockKey } from './geometry.js';
import type { BlockPos, NavRoute, Pose3D, RouteStep, ShapeKind } from './types.js';

/**
 * Build a planner world strictly from what the body observed. Cells missing
 * from the observation stay unknown; they are never promoted to air.
 */
export function worldFromObservation(observation: WorldObservation, now: () => number = () => observation.observedAt): SparseVoxelWorld {
  const source = observation.source === 'legacy-simulated' ? 'fixture' : observation.source;
  const world = new SparseVoxelWorld(observation.context, {
    id: `body-observation:${observation.source}`,
    registryVersion: observation.revision,
    source,
    approximate: observation.source !== 'observed-server',
  }, now);
  for (const cell of observation.cells.values()) {
    if (cell.cell === 'free') world.setAir(cell.pos);
    else if (cell.cell === 'blocked') world.setBlock(cell.pos, cell.shape === 'lower_slab' || cell.shape === 'upper_slab' ? cell.shape : 'full_cube', cell.block);
    else if (cell.cell === 'unknown') world.setUnknown(cell.pos);
    else world.setUnsupported(cell.pos);
  }
  return world;
}

export function observationUsable(observation: WorldObservation, options: { maxAgeMs: number; now: number; context?: BodyContext }): { ok: boolean; reason?: string } {
  if (observation.freshness !== 'current') return { ok: false, reason: `observation-${observation.freshness}` };
  if (observation.gap) return { ok: false, reason: 'observation-gap' };
  if (options.context && bodyContextKey(observation.context) !== bodyContextKey(options.context)) return { ok: false, reason: 'observation-context-mismatch' };
  if (!Number.isFinite(observation.observedAt) || options.now < observation.observedAt) return { ok: false, reason: 'observation-clock-invalid' };
  if (options.now - observation.observedAt > options.maxAgeMs) return { ok: false, reason: 'observation-stale' };
  return { ok: true };
}

export const bodyContextKey = (context: BodyContext) => `${context.serverProfileId}|${context.worldGenerationId ?? ''}|${context.connectionEpoch}|${context.bodyEpoch}|${context.dimension}`;

export function poseBlock(pose: Pose3D): BlockPos {
  return { x: Math.floor(pose.x), y: Math.floor(pose.y + 0.001), z: Math.floor(pose.z) };
}

export function centerOf(pos: BlockPos): Pose3D {
  return { x: pos.x + 0.5, y: pos.y, z: pos.z + 0.5, yaw: 0, pitch: 0 };
}

export function horizontalDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function poseDistance(a: Pose3D, b: Pose3D): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

export function stepTarget(step: RouteStep): Pose3D {
  return centerOf(step.edge.to);
}

export function stepMatchesPose(step: RouteStep, pose: Pose3D): boolean {
  const block = poseBlock(pose);
  return block.x === step.edge.to.x && block.y === step.edge.to.y && block.z === step.edge.to.z;
}

/**
 * Landing check for one grid edge. The body must be inside the destination
 * cell, supported vertically, and within tolerance along the travel axis. The
 * perpendicular offset is not required to be near the centre: a body that
 * starts off-centre in that axis cannot correct it with a cardinal walk, and
 * demanding a radial centre would make ordinary starts fail and overshoot.
 */
export function stepLanded(step: RouteStep, pose: Pose3D): boolean {
  const block = poseBlock(pose);
  if (block.x !== step.edge.to.x || block.y !== step.edge.to.y || block.z !== step.edge.to.z) return false;
  if (Math.abs(pose.y - step.edge.to.y) > 0.2) return false;
  const from = centerOf(step.edge.from);
  const to = centerOf(step.edge.to);
  if (to.x !== from.x) return step.edge.to.x > step.edge.from.x ? pose.x >= to.x - step.landingTolerance : pose.x <= to.x + step.landingTolerance;
  if (to.z !== from.z) return step.edge.to.z > step.edge.from.z ? pose.z >= to.z - step.landingTolerance : pose.z <= to.z + step.landingTolerance;
  return horizontalDistance(pose, to) <= step.landingTolerance;
}

/** World-space direction of an edge, used for turning and body-relative input. */
export function stepDirection(step: RouteStep): { x: number; y: number; z: number } {
  return { x: step.edge.to.x - step.edge.from.x, y: step.edge.to.y - step.edge.from.y, z: step.edge.to.z - step.edge.from.z };
}

/** Body-relative yaw convention used by the simulated adapter: yaw 0 faces +X, yaw 90 faces +Z. */
export function expectedYaw(direction: { x: number; z: number }): number {
  return (Math.atan2(direction.z, direction.x) * 180) / Math.PI;
}

export function yawDelta(from: number, to: number): number {
  let delta = ((to - from + 540) % 360) - 180;
  if (Object.is(delta, -180)) delta = 180;
  return delta;
}

export function normalizeYaw(yaw: number): number {
  return ((yaw % 360) + 360) % 360;
}

/** Zero-based edge-relative progress, clamped to [0,1]; used for stall detection. */
export function edgeProgress(step: RouteStep, pose: Pose3D): number {
  const from = centerOf(step.edge.from);
  const to = centerOf(step.edge.to);
  const total = horizontalDistance(from, to);
  if (total === 0) return 1;
  const travelled = total - horizontalDistance(pose, to);
  return Math.max(0, Math.min(1, travelled / total));
}

export function routeSummary(route: NavRoute) {
  return {
    status: route.status,
    steps: route.steps.length,
    observationRevision: route.observationRevision,
    snapshotRevision: route.snapshotRevision,
    supportedActions: route.supportedActions,
    dependencies: route.dependencies.length,
    landingTolerance: route.steps[0]?.landingTolerance,
    reason: route.reason,
  };
}

export type TemporaryFailure = { edgeId: string; reason: string; until: number; signature: string; attempts: number; avoid: boolean };

export function blockedEdgeKey(step: RouteStep): string {
  return step.edge.edgeId;
}

export function preconditionKeys(step: RouteStep): string[] {
  return [blockKey(step.edge.to), step.expected.support, ...step.expected.clearance, ...(step.expected.takeoffHeadroom ?? [])];
}

export type { BodySource, ShapeKind };
export { FULL_BODY_HEIGHT };
