import { z } from 'zod';
import type { BodyContext } from '../contracts/index.js';
import type { BlockPos, CellKnowledge, InputReceipt, Pose3D, ShapeKind, Vec3 } from './types.js';

/**
 * P10: the asynchronous 3D body contract.
 *
 * Every field that is inherently three-dimensional is expressed in world
 * coordinates (x/y/z with y up). The legacy 2D bridge coordinates are never
 * reused as if they were these fields: an adapter declares the coordinate
 * mapping explicitly and reports `threeDimensional: false`, so consumers fail
 * closed instead of silently inventing a `z = 0` volume.
 */
export type BodySource = 'simulated' | 'observed-server' | 'legacy-simulated';
export type CoordinateMapping = 'world-xyz' | 'legacy-2d-xz';
export type JumpCapability = 'none' | 'short';
export type BodyCapabilities = {
  threeDimensional: boolean;
  turn: boolean;
  walk: boolean;
  stop: boolean;
  jump: JumpCapability;
  /** Maximum rise supported by the validated jump profile, in blocks. */
  jumpMaxRise: number;
  stepUp: boolean;
  controlledDrop: boolean;
};
/** Capabilities that are actually implemented and may be planned against today. */
export const SIMULATED_BODY_CAPABILITIES: BodyCapabilities = { threeDimensional: true, turn: true, walk: true, stop: true, jump: 'short', jumpMaxRise: 1, stepUp: false, controlledDrop: false };
export const LEGACY_2D_CAPABILITIES: BodyCapabilities = { threeDimensional: false, turn: true, walk: true, stop: true, jump: 'none', jumpMaxRise: 0, stepUp: false, controlledDrop: false };

export type ObservedCell = { pos: BlockPos; cell: CellKnowledge; shape: ShapeKind; block?: string; revision: string };
export type WorldObservation = {
  context: BodyContext;
  /** Dimension is explicit and never derived from a 2D coordinate. */
  dimension: string;
  revision: string;
  observedAt: number;
  pose: Pose3D;
  velocity: Vec3;
  supported: boolean;
  freshness: 'current' | 'stale' | 'unknown';
  gap: boolean;
  source: BodySource;
  threeDimensional: boolean;
  coordinateMapping: CoordinateMapping;
  cells: ReadonlyMap<string, ObservedCell>;
  worldRevision?: string;
};

export type MotionDirection = { x: number; y: number; z: number };
/**
 * Only turn, walk, short jump and stop are emitted by the controller. The list
 * is closed so a caller cannot smuggle an unimplemented action into the sink.
 */
export type MotionIntent =
  | { kind: 'turn'; targetYaw: number; toleranceDegrees: number }
  | { kind: 'walk'; direction: MotionDirection; toward: BlockPos }
  | { kind: 'jump'; direction: MotionDirection; toward: BlockPos; short: true }
  | { kind: 'stop' };

export type MotionPlan = {
  commandId: string;
  ownerToken: string;
  leaseId: string;
  issuedAt: number;
  deadline: number;
  maxAge: number;
  context: BodyContext;
  observationRef: string;
  worldRevision?: string;
  intent: MotionIntent;
};

/** The only injected input boundary. No controller writes a body/world directly. */
export interface InputSink {
  submit(plan: MotionPlan): Promise<InputReceipt>;
  /** Release held input for this owner immediately. Never touches another owner's input. */
  release(ownerToken: string): Promise<void>;
}

export type GatherResult = { accepted: boolean; ambiguous?: boolean; collected: number; items: string[]; commandId?: string };

export interface BodyAdapter extends InputSink {
  readonly context: BodyContext;
  readonly capabilities: BodyCapabilities;
  readonly source: BodySource;
  /**
   * Current inventory count when the adapter has evidence for it. Real
   * adapters omit this until an inventory projection exists; tools must then
   * report inventory as unavailable instead of reading the legacy bridge.
   */
  readonly inventory?: number;
  /**
   * Clock domain used by this body's observations. When present, controllers
   * and skills must use it rather than an unrelated wall clock, otherwise
   * observation age is meaningless. Real adapters may share the Runtime clock.
   */
  readonly clock?: import('../contracts/index.js').Clock;
  observe(): Promise<WorldObservation>;
  /**
   * Optional synchronous view of the same observation `observe()` returns.
   * Control/status reads are synchronous; an adapter that can provide this
   * lets them surface a real 3D pose instead of waiting or inventing one.
   */
  peek?(): WorldObservation;
  /** Simulated bodies advance virtual time explicitly; real adapters leave this absent. */
  advance?(ticks: number): void;
  findPlace?(placeId: string): Promise<BlockPos | undefined>;
  findBlock?(block: string): Promise<BlockPos | undefined>;
  digBlock?(pos: BlockPos, block: string): Promise<GatherResult>;
  collectNearby?(): Promise<{ accepted: boolean; collected: number; items: string[] }>;
}

const BODY_ADAPTER = Symbol.for('furevercraft.body-adapter');
export function attachBodyAdapter(bridge: object, adapter: BodyAdapter): void {
  Object.defineProperty(bridge, BODY_ADAPTER, { value: adapter, enumerable: false, configurable: true, writable: false });
}
export function getAttachedBodyAdapter(bridge: object): BodyAdapter | undefined {
  return (bridge as Record<symbol, BodyAdapter | undefined>)[BODY_ADAPTER];
}
export function isBodyAdapter(value: unknown): value is BodyAdapter {
  const candidate = value as Partial<BodyAdapter> | undefined;
  return Boolean(candidate && typeof candidate.observe === 'function' && typeof candidate.submit === 'function' && typeof candidate.release === 'function' && candidate.capabilities && candidate.context);
}

/** True only when a contract consumer may treat the observation as a real 3D volume. */
export function isReal3DObservation(observation: WorldObservation): boolean {
  return observation.threeDimensional === true && observation.coordinateMapping === 'world-xyz';
}

/**
 * Public state surface for tools/control/web. A 3D adapter contributes a real
 * world pose including non-zero z; a legacy body never gets a fabricated z.
 */
export type BodyStateView = {
  mode: '3d' | 'legacy-2d';
  threeDimensional: boolean;
  legacy2d: boolean;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  pose?: Pose3D;
  dimension: string;
  revision: string;
  freshness: 'current' | 'stale' | 'unknown';
  source: BodySource | 'legacy-2d';
  gap: boolean;
  supported?: boolean;
  observedAt?: number;
  context: BodyContext;
};

/** Derive the public state shape from one observation without inventing fields. */
export function bodyStateFromObservation(observation: WorldObservation): BodyStateView {
  const threeDimensional = isReal3DObservation(observation);
  const base = {
    mode: threeDimensional ? '3d' as const : 'legacy-2d' as const,
    threeDimensional,
    legacy2d: !threeDimensional,
    dimension: observation.dimension,
    revision: observation.revision,
    freshness: observation.freshness,
    source: observation.source,
    gap: observation.gap,
    supported: observation.supported,
    observedAt: observation.observedAt,
    context: { ...observation.context },
  };
  if (!threeDimensional) return base;
  return {
    ...base,
    x: observation.pose.x,
    y: observation.pose.y,
    z: observation.pose.z,
    yaw: observation.pose.yaw,
    pitch: observation.pose.pitch,
    pose: { ...observation.pose },
  };
}

/** Synchronous state when the adapter exposes `peek`; never blocks or guesses. */
export function bodyStateView(adapter: BodyAdapter | undefined): BodyStateView | undefined {
  const observation = adapter?.peek?.();
  return observation ? bodyStateFromObservation(observation) : undefined;
}

/** A legacy snapshot is explicitly 2D; planar x/y is never promoted to a 3D pose. */
export function legacyBodyStateView(snapshot: {
  context: BodyContext; revision: string; freshness: 'current' | 'stale' | 'unknown'; source: string; gap: boolean;
}): BodyStateView {
  return {
    mode: 'legacy-2d', threeDimensional: false, legacy2d: true,
    dimension: snapshot.context.dimension, revision: snapshot.revision,
    freshness: snapshot.freshness, source: 'legacy-2d', gap: snapshot.gap,
    context: { ...snapshot.context },
  };
}

/**
 * P10 persisted/telemetry schema. Any stored or logged body position must carry
 * all three world axes plus yaw/pitch; a bare `{x,y}` is a legacy bridge shape
 * and must not be written as if it were a 3D pose.
 */
export const Pose3DSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  yaw: z.number().finite(),
  pitch: z.number().finite(),
}).strict();

/**
 * P10 tool/skill schema. The canonical navigation target is a world-space
 * x/y/z integer block position. `z` is required for the 3D tools so a caller
 * cannot omit it and have a vertical coordinate invented.
 */
export const NavigationTarget3DSchema = z.object({
  x: z.number().int().finite(),
  y: z.number().int().finite(),
  z: z.number().int().finite(),
}).strict();
export type NavigationTarget3D = z.infer<typeof NavigationTarget3DSchema>;

/**
 * Migration helper for legacy callers that still send only planar x/y.
 *
 * The translation is explicit and recorded in the result:
 * - a 3D target supplied by the caller is used verbatim;
 * - planar x/y on a 3D body are mapped to world x/z, with vertical y taken
 *   from the current pose (never silently padded with `z = 0`);
 * - legacy 2D bodies map planar x/y onto their x/z plane and y is reported as
 *   0 together with `threeDimensional: false`.
 */
export function resolveTarget3D(
  observation: WorldObservation,
  target: { x: number; y: number; z?: number },
): { target: BlockPos; mapping: 'explicit-xyz' | 'planar-xz-current-y' | 'legacy-2d-xz'; derived: boolean } {
  if (target.z !== undefined) return { target: { x: target.x, y: target.y, z: target.z }, mapping: 'explicit-xyz', derived: false };
  if (!isReal3DObservation(observation)) {
    return { target: { x: target.x, y: 0, z: target.y }, mapping: 'legacy-2d-xz', derived: true };
  }
  return { target: { x: target.x, y: Math.floor(observation.pose.y), z: target.y }, mapping: 'planar-xz-current-y', derived: true };
}

export const FULL_BODY_HEIGHT = 1.8;
export const BODY_HALF_WIDTH = 0.35;
