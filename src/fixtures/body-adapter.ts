import { nextId, type BodyContext, type Clock, type InputPlan, type WorldSnapshot } from '../contracts/index.js';
import type { BodyAdapter, BodyCapabilities, GatherResult, MotionPlan, WorldObservation } from '../motor/contracts.js';
import { LEGACY_2D_CAPABILITIES, SIMULATED_BODY_CAPABILITIES, FULL_BODY_HEIGHT } from '../motor/contracts.js';
import type { BlockPos, InputPlan3D, InputReceipt } from '../motor/types.js';
import { yawDelta } from '../motor/route.js';
import type { SparseVoxelWorld } from '../motor/geometry.js';
import { blockKey } from '../motor/geometry.js';
import type { SimulatedBody } from './simulated-body.js';

export type SimulatedBodyAdapterOptions = {
  /** Virtual milliseconds advanced per body tick (20 Hz by default). */
  tickMs?: number;
  /** Report observations as if they were taken this many ms in the past. */
  observationLagMs?: number;
  /** Local observation radius in blocks; cells outside stay unknown to the consumer. */
  observationRadius?: number;
  /** Test/diagnostic override; production stays `current`. */
  freshness?: 'current' | 'stale' | 'unknown';
  gap?: boolean;
};

/** 3D adapter over the independent voxel fixture body. */
export class SimulatedBodyAdapter implements BodyAdapter {
  readonly capabilities: BodyCapabilities = { ...SIMULATED_BODY_CAPABILITIES };
  readonly source = 'simulated' as const;
  readonly context: BodyContext;
  inventory = 0;
  private readonly places = new Map<string, BlockPos>();
  private readonly options: Required<Pick<SimulatedBodyAdapterOptions, 'tickMs' | 'observationLagMs' | 'observationRadius' | 'gap'>> & { freshness: 'current' | 'stale' | 'unknown' };
  private override?: Partial<SimulatedBodyAdapterOptions>;
  /** Observability for tests: every accepted/rejected submission and release is counted. */
  readonly counters = { submitted: 0, accepted: 0, rejected: 0, releases: 0 };

  constructor(readonly body: SimulatedBody, readonly world: SparseVoxelWorld, readonly clock: Clock, options: SimulatedBodyAdapterOptions = {}) {
    this.context = body.context;
    this.options = {
      tickMs: Math.max(1, options.tickMs ?? 20),
      observationLagMs: Math.max(0, options.observationLagMs ?? 0),
      observationRadius: Math.max(1, options.observationRadius ?? 12),
      freshness: options.freshness ?? 'current',
      gap: options.gap ?? false,
    };
  }

  /** Inject a bounded observation defect for stale/gap/dimension tests. */
  setObservationOverride(override: Partial<SimulatedBodyAdapterOptions> | undefined): void { this.override = override; }

  async observe(): Promise<WorldObservation> { return this.readObservation(); }

  /** Synchronous counterpart used by control/status surfaces; same source of truth as observe(). */
  peek(): WorldObservation { return this.readObservation(); }

  private readObservation(): WorldObservation {
    const observation = this.body.read();
    const snapshot = this.world.snapshot();
    const pose = observation.pose;
    const radius = this.override?.observationRadius ?? this.options.observationRadius;
    const cells = new Map<string, { pos: BlockPos; cell: 'free' | 'blocked' | 'unknown' | 'unsupported'; shape: 'full_cube' | 'lower_slab' | 'upper_slab' | 'air' | 'unsupported'; block?: string; revision: string }>();
    for (const [key, block] of snapshot.blocks) {
      if (Math.max(Math.abs(block.pos.x - Math.floor(pose.x)), Math.abs(block.pos.y - Math.floor(pose.y)), Math.abs(block.pos.z - Math.floor(pose.z))) > radius) continue;
      cells.set(key, { pos: { ...block.pos }, cell: block.cell, shape: block.shape, ...(block.block ? { block: block.block } : {}), revision: block.revision });
    }
    const lag = this.override?.observationLagMs ?? this.options.observationLagMs;
    return {
      context: this.context,
      dimension: this.context.dimension,
      revision: `${observation.revision}:${snapshot.revision}`,
      worldRevision: snapshot.revision,
      observedAt: this.clock.now() - lag,
      pose: { ...observation.pose },
      velocity: { ...observation.velocity },
      supported: observation.supported,
      freshness: this.override?.freshness ?? this.options.freshness,
      gap: this.override?.gap ?? this.options.gap,
      source: 'simulated',
      threeDimensional: true,
      coordinateMapping: 'world-xyz',
      cells,
    };
  }

  async submit(plan: MotionPlan): Promise<InputReceipt> {
    this.counters.submitted += 1;
    const observation = this.body.read();
    const reject = (reason: string): InputReceipt => { this.counters.rejected += 1; return { commandId: plan.commandId, accepted: false, reason, observedRevision: observation.revision }; };
    if (plan.context.connectionEpoch !== this.context.connectionEpoch
      || plan.context.bodyEpoch !== this.context.bodyEpoch
      || plan.context.worldGenerationId !== this.context.worldGenerationId
      || plan.context.dimension !== this.context.dimension) return reject('context-mismatch');
    const now = this.clock.now();
    if (now > plan.deadline || now - plan.issuedAt > plan.maxAge) return reject('input-expired');
    if (!plan.ownerToken) return reject('owner-required');

    if (plan.intent.kind === 'stop') {
      this.body.stop(plan.ownerToken);
      this.counters.accepted += 1;
      return { commandId: plan.commandId, accepted: true, observedRevision: observation.revision };
    }
    let delta: InputPlan3D['delta'] = {};
    if (plan.intent.kind === 'turn') {
      delta = { yaw: yawDelta(observation.pose.yaw, plan.intent.targetYaw) };
    } else {
      const direction = plan.intent.direction;
      if (direction.x === 0 && direction.z === 0) return reject('direction-required');
      if (plan.intent.kind === 'jump' && (this.capabilities.jump !== 'short' || this.capabilities.jumpMaxRise < 1)) return reject('jump-capability-unavailable');
      const yaw = (observation.pose.yaw * Math.PI) / 180;
      // Inverse of the simulated body's body-relative rotation. The world vector is what
      // the controller plans; body-relative forward/strafe never reuses planar tool x/y.
      const forward = direction.x * Math.cos(yaw) + direction.z * Math.sin(yaw);
      const strafe = -direction.x * Math.sin(yaw) + direction.z * Math.cos(yaw);
      delta = { forward: Math.abs(forward) > 0.1 ? Math.sign(forward) : 0, strafe: Math.abs(strafe) > 0.1 ? Math.sign(strafe) : 0 };
      if (plan.intent.kind === 'jump') delta.jump = true;
      if (!delta.forward && !delta.strafe) return reject('direction-not-representable');
    }
    const receipt = this.body.submit({
      ...baseInputPlan(this.context, plan, observation.revision),
      delta,
    });
    if (receipt.accepted) this.counters.accepted += 1; else this.counters.rejected += 1;
    return receipt;
  }

  async release(ownerToken: string): Promise<void> { this.counters.releases += 1; this.body.release(ownerToken); }

  /** Advance virtual time and body physics together; never a direct position write. */
  advance(ticks: number): void {
    const step = this.override?.tickMs ?? this.options.tickMs;
    for (let index = 0; index < ticks; index++) this.body.tick();
    const clock = this.clock as Clock & { advance?: (ms: number) => void };
    if (typeof clock.advance === 'function') clock.advance(step * ticks);
  }

  async findPlace(placeId: string): Promise<BlockPos | undefined> { const place = this.places.get(placeId); return place ? { ...place } : undefined; }
  rememberPlace(placeId: string, pos: BlockPos): void { this.places.set(placeId, { ...pos }); }
  forgetPlace(placeId: string): void { this.places.delete(placeId); }

  async findBlock(block: string): Promise<BlockPos | undefined> {
    for (const entry of this.world.snapshot().blocks.values()) {
      if (entry.cell === 'blocked' && entry.block === block) return { ...entry.pos };
    }
    return undefined;
  }

  async digBlock(pos: BlockPos, block: string): Promise<GatherResult> {
    const observed = this.world.get(pos);
    if (observed.cell !== 'blocked') return { accepted: false, collected: 0, items: [], ambiguous: true };
    if (observed.block && observed.block !== block) return { accepted: false, collected: 0, items: [] };
    this.world.setAir(pos);
    this.inventory += 1;
    return { accepted: true, collected: 1, items: [block], commandId: nextId('dig') };
  }
}

function baseInputPlan(context: BodyContext, plan: MotionPlan, observationRef: string): Omit<InputPlan3D, 'delta'> & { delta: InputPlan3D['delta'] } {
  const common: Omit<InputPlan, 'kind' | 'payload'> = {
    commandId: plan.commandId,
    executionId: plan.leaseId,
    context,
    leaseId: plan.leaseId,
    sequence: nextId('seq'),
    sourceEpoch: context.connectionEpoch,
    generatedAt: plan.issuedAt,
    clockDomain: 'virtual',
    maxAge: plan.maxAge,
    observationRef,
    leaseUntil: plan.deadline,
  };
  return { ...common, kind: 'walk', payload: {}, ownerToken: plan.ownerToken, deadline: plan.deadline, snapshotRevision: observationRef, heldSet: [], delta: {} };
}

type LegacyBridge = {
  readonly context: BodyContext;
  position: { x: number; y: number };
  snapshot(gap?: boolean): WorldSnapshot;
  walk(x: number, y: number): void;
  lookAt?(x: number, y: number): { accepted: boolean; yawDegrees: number };
  findPlace?(placeId: string): { x: number; y: number } | undefined;
  adjacentBlock?(block: string): { x: number; y: number } | undefined;
  digBlock?(x: number, y: number, block: string): { accepted: boolean; commandId: string; block: string };
  collectNearby?(): { accepted: boolean; commandId: string; collected: number; items: string[] };
};

/**
 * Explicitly legacy, explicitly planar. It is never presented as a 3D
 * observation: `threeDimensional` is false and the mapping is `legacy-2d-xz`,
 * so 3D consumers refuse it instead of inventing a vertical coordinate.
 */
export class Legacy2DBodyAdapter implements BodyAdapter {
  readonly capabilities: BodyCapabilities = { ...LEGACY_2D_CAPABILITIES };
  readonly source = 'legacy-simulated' as const;
  readonly context: BodyContext;
  constructor(readonly bridge: LegacyBridge, readonly clock?: Clock) { this.context = bridge.context; }

  async observe(): Promise<WorldObservation> { return this.readObservation(); }
  peek(): WorldObservation { return this.readObservation(); }
  private readObservation(): WorldObservation {
    const snapshot = this.bridge.snapshot();
    const cells = new Map<string, { pos: BlockPos; cell: 'free' | 'blocked' | 'unknown' | 'unsupported'; shape: 'full_cube' | 'lower_slab' | 'upper_slab' | 'air' | 'unsupported'; revision: string }>();
    for (const [key, cell] of Object.entries(snapshot.cells)) {
      const [x, y] = key.split(',').map(Number) as [number, number];
      // The legacy bridge's y is a top-down horizontal axis: it maps to world z. World y is
      // not derived from it; the observation is flagged non-3D so 3D consumers refuse it.
      const pos = { x, y: 0, z: y };
      cells.set(blockKey(pos), { pos, cell: cell === 'blocked' ? 'blocked' : cell === 'free' ? 'free' : 'unknown', shape: cell === 'free' ? 'air' : 'full_cube', revision: snapshot.revision });
    }
    return {
      context: this.bridge.context,
      dimension: this.bridge.context.dimension,
      revision: snapshot.revision,
      observedAt: snapshot.fields.position?.observedAt ?? 0,
      pose: { x: this.bridge.position.x, y: 0, z: this.bridge.position.y, yaw: 0, pitch: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      supported: true,
      freshness: snapshot.freshness,
      gap: snapshot.gap,
      source: 'legacy-simulated',
      threeDimensional: false,
      coordinateMapping: 'legacy-2d-xz',
      cells,
    };
  }

  async submit(plan: MotionPlan): Promise<InputReceipt> {
    if (plan.intent.kind === 'stop') return { commandId: plan.commandId, accepted: true, observedRevision: 'legacy' };
    if (plan.intent.kind === 'turn') {
      if (!this.bridge.lookAt) return { commandId: plan.commandId, accepted: false, reason: 'orientation-unavailable', observedRevision: 'legacy' };
      this.bridge.lookAt(this.bridge.position.x + 1, this.bridge.position.y);
      return { commandId: plan.commandId, accepted: true, observedRevision: 'legacy' };
    }
    if (plan.intent.kind === 'jump') return { commandId: plan.commandId, accepted: false, reason: 'jump-capability-unavailable', observedRevision: 'legacy' };
    const direction = plan.intent.direction;
    const to = { x: this.bridge.position.x + Math.sign(direction.x), y: this.bridge.position.y + Math.sign(direction.z) };
    try { this.bridge.walk(to.x, to.y); return { commandId: plan.commandId, accepted: true, observedRevision: 'legacy' }; }
    catch (error) { return { commandId: plan.commandId, accepted: false, reason: error instanceof Error ? error.message : String(error), observedRevision: 'legacy' }; }
  }

  async release(): Promise<void> { /* the 2D bridge has no held-input channel */ }
  async findPlace(placeId: string): Promise<BlockPos | undefined> {
    const place = this.bridge.findPlace?.(placeId);
    return place ? { x: place.x, y: 0, z: place.y } : undefined;
  }
  async findBlock(block: string): Promise<BlockPos | undefined> {
    const target = this.bridge.adjacentBlock?.(block);
    return target ? { x: target.x, y: 0, z: target.y } : undefined;
  }
  async digBlock(pos: BlockPos, block: string): Promise<GatherResult> {
    if (!this.bridge.digBlock) return { accepted: false, collected: 0, items: [] };
    try {
      const result = this.bridge.digBlock(pos.x, pos.z, block);
      return { accepted: result.accepted, collected: result.accepted ? 1 : 0, items: result.accepted ? [block] : [], commandId: result.commandId };
    } catch { return { accepted: false, collected: 0, items: [], ambiguous: true }; }
  }
  async collectNearby(): Promise<{ accepted: boolean; collected: number; items: string[] }> {
    if (!this.bridge.collectNearby) return { accepted: false, collected: 0, items: [] };
    const result = this.bridge.collectNearby();
    return { accepted: result.accepted, collected: result.collected, items: result.items };
  }
}

export { FULL_BODY_HEIGHT };
