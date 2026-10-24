import type { BodyContext, Clock, InputPlan } from '../contracts/index.js';

/**
 * World-space pose. `y` is up. `x`/`z` are the horizontal plane. This type is
 * never a re-labelled legacy 2D bridge coordinate: adapters that only know the
 * planar bridge must declare `coordinateMapping: 'legacy-2d-xz'` and
 * `threeDimensional: false` on their observations.
 */
export type Pose3D = { x: number; y: number; z: number; yaw: number; pitch: number };
export type BlockPos = { x: number; y: number; z: number };
export type Vec3 = { x: number; y: number; z: number };
export type Aabb = { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
export type ShapeKind = 'full_cube' | 'lower_slab' | 'upper_slab' | 'air' | 'unsupported';
export type CellKnowledge = 'free' | 'blocked' | 'unknown' | 'unsupported';
export type FixtureSource = 'simulated' | 'fixture' | 'observed-server';
export type ValidationProfile = { id: string; registryVersion: string; source: FixtureSource; approximate: boolean };
export type BlockObservation = { pos: BlockPos; cell: CellKnowledge; shape: ShapeKind; block?: string; source: FixtureSource; observedAt: number; revision: string; validation: ValidationProfile };
export type VoxelSnapshot = { context: BodyContext; revision: string; blocks: ReadonlyMap<string, BlockObservation>; source: FixtureSource; freshness: 'current' | 'stale' | 'unknown' };
export type GeometryStatus = 'clear' | 'blocked' | 'unknown' | 'unsupported';
export type GeometryResult = { status: GeometryStatus; dependencies: string[]; reason?: string };

/**
 * `turn` and `stop` are motor phases, not graph traversal transitions. The only
 * graph transitions enabled for navigation in this batch are the evidence-backed
 * `walk` and the explicitly bounded one-block `jump_short`. `step_up` and
 * `controlled_drop` remain modelled kinds for a future validated profile but no
 * controller emits them today.
 */
export type ActionKind = 'walk' | 'jump_short' | 'step_up' | 'controlled_drop' | 'turn' | 'stop';
export type ActionCapability = 'walk' | 'jump_short' | 'step_up' | 'controlled_drop';

export type ActionEdge = {
  edgeId: string;
  kind: ActionKind;
  from: BlockPos;
  to: BlockPos;
  primitiveId: string;
  primitiveVersion: string;
  dependencies: string[];
  snapshotRevision: string;
  risk: 'normal' | 'elevated';
  /** Expected preconditions re-checked against a fresh observation before execution. */
  preconditions: { support: string; clearance: string[]; takeoffHeadroom?: string[] };
  /** Landing tolerance in blocks. */
  landingTolerance: number;
};

/**
 * The only actions with an implemented, evidence-backed controller profile.
 * Callers may request others, but the planner resolves that request against
 * this list and refuses to emit unsupported transitions.
 */
export const EVIDENCED_MOVEMENT_ACTIONS: readonly ActionCapability[] = ['walk', 'jump_short'];
export const DEFAULT_MOVEMENT_CAPABILITIES: readonly ActionCapability[] = [...EVIDENCED_MOVEMENT_ACTIONS];
/** Motor primitives with an implementation in this batch. */
export const EVIDENCED_MOTOR_PRIMITIVES = ['turn', 'walk', 'stop', 'jump_short'] as const;

export type PlanStatus = 'COMPLETE' | 'PARTIAL' | 'NEEDS_OBSERVATION' | 'BUDGET_EXHAUSTED' | 'NO_PATH_IN_KNOWN_GRAPH' | 'UNSUPPORTED_TRANSITION';
export type PlanResult = { status: PlanStatus; edges: ActionEdge[]; expanded: number; snapshotRevision: string; stableEndpoint?: Pose3D; dependencies: string[]; supportedActions: readonly ActionKind[]; reason?: string };

/** A planned edge plus the observation it was planned against and its tolerances. */
export type RouteStep = {
  edge: ActionEdge;
  observationRevision: string;
  landingTolerance: number;
  expected: { support: string; clearance: string[]; takeoffHeadroom?: string[] };
};

/** A route carries expected preconditions, landing points/tolerances, supported actions and observation version. */
export type NavRoute = {
  status: PlanStatus;
  steps: RouteStep[];
  expanded: number;
  observationRevision: string;
  snapshotRevision: string;
  supportedActions: readonly ActionKind[];
  stableEndpoint?: Pose3D;
  dependencies: string[];
  reason?: string;
};

/**
 * Internal plan handed to the legacy synchronous facade. New code uses
 * `MotionPlan` from `./contracts.js` instead.
 */
export type InputPlan3D = InputPlan & { ownerToken: string; deadline: number; snapshotRevision: string; heldSet: readonly string[]; delta: { forward?: number; strafe?: number; yaw?: number; jump?: boolean } };
export type InputReceipt = { commandId: string; accepted: boolean; reason?: string; observedRevision: string };
export type BodyObservation = { context: BodyContext; pose: Pose3D; velocity: Vec3; supported: boolean; revision: string; source: 'simulated' | 'observed-server' | 'legacy-simulated'; gap: boolean };
export type BodyCorrection = { pose: Pose3D; reason: string; revision: string };
export type BodyReader = { read(): BodyObservation };
export type InputGateway = { submit(plan: InputPlan3D): InputReceipt; release(ownerToken: string): void };

/** Synchronous deps retained only for the legacy simulated Motor facade. */
export type MotorDeps = { context: BodyContext; clock: Clock; reader: BodyReader; input: InputGateway };

/** Asynchronous 3D contract deps used by the closed-loop controller. */
export type MotorAsyncDeps = { context: BodyContext; clock: Clock; body: import('./contracts.js').BodyAdapter; leaseId: string; ownerToken: string };
