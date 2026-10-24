import type { BodyContext, Clock } from '../contracts/index.js';
import type { InputPlan3D, InputReceipt, Pose3D, BodyObservation, BodyCorrection, InputGateway, BodyReader } from '../motor/types.js';
import type { SparseVoxelWorld } from '../motor/geometry.js';
import { BODY_HALF_WIDTH, FULL_BODY_HEIGHT } from '../motor/contracts.js';
import { JUMP_APEX } from '../motor/action-graph.js';

/**
 * Fixture physics constants. These are simulator assumptions, not Minecraft
 * 26.3 constants and not evidence of real-client physics. The jump arc apex is
 * above one block (the maximum planned landing rise) but below two blocks, so a
 * two-block rise is physically unreachable as well as unplanned.
 */
export const SIMULATOR_ASSUMPTIONS = {
  gravityPerTick: 0.08,
  jumpVelocityPerTick: 0.45,
  walkSpeedPerTick: 0.1,
  bodyHeight: FULL_BODY_HEIGHT,
  bodyHalfWidth: BODY_HALF_WIDTH,
  jumpMaxRise: 1,
  jumpApex: JUMP_APEX,
  /** Unknown geometry is treated as blocking, never as air. */
  unknownIsBlocking: true,
} as const;

const { gravityPerTick: GRAVITY, jumpVelocityPerTick: JUMP_VELOCITY, walkSpeedPerTick: WALK_SPEED } = SIMULATOR_ASSUMPTIONS;

export type SimulatedBodyOptions = {
  /** Starting pose, including a non-zero world z and yaw. */
  start?: Partial<Pose3D>;
  /** Fixed seed for deterministic disturbance injection. */
  seed?: number;
  /** Input takes effect after this many virtual ticks. */
  latencyTicks?: number;
  /** Deterministic disturbance cadence: every N ticks may inject a small offset. */
  disturbanceEvery?: number;
  /** Magnitude of the injected horizontal/yaw disturbance. */
  disturbance?: { x?: number; z?: number; yaw?: number };
};

const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Independent offline body over the existing sparse voxel fixture.
 *
 * The controller only sees `read()`/observations; it cannot set the pose. The
 * body owns collision, support, jump and stop behaviour and is advanced by
 * explicit virtual ticks with injected latency and deterministic disturbance.
 */
export class SimulatedBody implements InputGateway, BodyReader {
  private pose: Pose3D;
  private velocity = { x: 0, y: 0, z: 0 };
  private supported = true;
  private revision = 0;
  private owner?: string;
  private active = new Map<string, InputPlan3D>();
  private pending: Array<{ due: number; plan: InputPlan3D }> = [];
  private correction?: BodyCorrection;
  private readonly options: Required<Pick<SimulatedBodyOptions, 'seed' | 'latencyTicks' | 'disturbanceEvery'>> & { disturbance: { x: number; z: number; yaw: number } };
  private readonly random: () => number;
  private tickCount = 0;
  private jumpsAccepted = 0;
  private jumpsBlocked = 0;
  /** Last accepted/blocked action, observable so tests can verify capability limits. */
  lastAction: 'idle' | 'walk' | 'turn' | 'jump' | 'jump-blocked' | 'stop' = 'idle';

  constructor(readonly context: BodyContext, readonly world: SparseVoxelWorld, readonly clock: Clock, options: SimulatedBodyOptions = {}) {
    this.pose = { x: 0.5, y: 1, z: 0.5, yaw: 0, pitch: 0, ...options.start };
    this.options = {
      seed: options.seed ?? 1,
      latencyTicks: Math.max(0, options.latencyTicks ?? 0),
      disturbanceEvery: Math.max(0, options.disturbanceEvery ?? 0),
      disturbance: { x: options.disturbance?.x ?? 0, z: options.disturbance?.z ?? 0, yaw: options.disturbance?.yaw ?? 0 },
    };
    this.random = mulberry32(this.options.seed);
    this.supported = world.supportAtFeet(this.pose).status === 'blocked';
  }

  submit(plan: InputPlan3D): InputReceipt {
    const now = this.clock.now();
    if (plan.context.connectionEpoch !== this.context.connectionEpoch
      || plan.context.bodyEpoch !== this.context.bodyEpoch
      || plan.context.worldGenerationId !== this.context.worldGenerationId
      || plan.context.dimension !== this.context.dimension) {
      return { commandId: plan.commandId, accepted: false, reason: 'context-mismatch', observedRevision: String(this.revision) };
    }
    if (now > plan.deadline || now - plan.generatedAt > plan.maxAge) return { commandId: plan.commandId, accepted: false, reason: 'input-expired', observedRevision: String(this.revision) };
    if (this.owner && this.owner !== plan.ownerToken) return { commandId: plan.commandId, accepted: false, reason: 'old-owner', observedRevision: String(this.revision) };
    this.owner = plan.ownerToken;
    // Store a private copy: held-input bookkeeping (one-shot jump consumption) must
    // never mutate the caller's plan object.
    const stored: InputPlan3D = { ...plan, delta: { ...plan.delta }, heldSet: [...plan.heldSet] };
    // Held input is a set, not a growing log: a new plan for the same owner replaces it.
    for (const [id, existing] of this.active) if (existing.ownerToken === plan.ownerToken) this.active.delete(id);
    this.pending = this.pending.filter(entry => entry.plan.ownerToken !== plan.ownerToken);
    if (this.options.latencyTicks > 0) this.pending.push({ due: this.tickCount + this.options.latencyTicks, plan: stored });
    else this.active.set(stored.commandId, stored);
    return { commandId: plan.commandId, accepted: true, observedRevision: String(this.revision) };
  }

  /** Continuous control: an active input keeps applying until replaced or released. */
  release(ownerToken: string): void {
    if (this.owner !== ownerToken) return;
    this.active.clear();
    this.pending = this.pending.filter(entry => entry.plan.ownerToken !== ownerToken);
    this.owner = undefined;
    this.velocity = { x: 0, y: this.velocity.y, z: 0 };
    this.lastAction = 'stop';
  }

  stop(ownerToken?: string): void {
    if (ownerToken !== undefined) {
      if (ownerToken !== this.owner) return;
      this.release(ownerToken);
      return;
    }
    this.active.clear();
    this.owner = undefined;
    this.velocity = { x: 0, y: this.velocity.y, z: 0 };
    this.lastAction = 'stop';
  }

  /** Server-style correction. This is an observation input, not controller execution. */
  injectCorrection(correction: BodyCorrection): void { this.correction = correction; }
  get ticks() { return this.tickCount; }
  get jumpStats() { return { accepted: this.jumpsAccepted, blocked: this.jumpsBlocked }; }
  get ownerToken() { return this.owner; }
  get activePlanCount() { return this.active.size; }
  get currentPose(): Pose3D { return { ...this.pose }; }

  tick(): BodyObservation {
    this.tickCount += 1;
    // Deliver latent input deterministically on the due virtual tick.
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const entry = this.pending[index]!;
      if (entry.due <= this.tickCount) {
        for (const [id, existing] of this.active) if (existing.ownerToken === entry.plan.ownerToken) this.active.delete(id);
        this.active.set(entry.plan.commandId, entry.plan);
        this.pending.splice(index, 1);
      }
    }
    if (this.correction) { this.pose = { ...this.correction.pose }; this.correction = undefined; this.revision++; }
    const now = this.clock.now();
    // Drop expired plans so a stale command cannot keep moving the body after its deadline.
    for (const [id, plan] of this.active) if (now > plan.deadline || now - plan.generatedAt > plan.maxAge) this.active.delete(id);
    const current = [...this.active.values()].at(-1);
    const dt = 1;
    let vx = 0; let vy = this.velocity.y - GRAVITY * dt; let vz = 0;
    this.lastAction = 'idle';
    if (current) {
      if (current.delta.yaw) {
        // A turn is a one-shot primitive: consume it so a held plan cannot keep
        // rotating tick after tick.
        this.pose.yaw = (this.pose.yaw + current.delta.yaw) % 360;
        this.lastAction = 'turn';
        this.active.delete(current.commandId);
      }
      const forward = current.delta.forward ?? 0; const strafe = current.delta.strafe ?? 0;
      // Movement is body-relative: rotate the requested direction by the current yaw.
      const yaw = (this.pose.yaw * Math.PI) / 180;
      if (forward !== 0 || strafe !== 0) {
        vx = (forward * Math.cos(yaw) - strafe * Math.sin(yaw)) * WALK_SPEED;
        vz = (forward * Math.sin(yaw) + strafe * Math.cos(yaw)) * WALK_SPEED;
        this.lastAction = 'walk';
      }
      if (current.delta.jump) {
        const headroom = this.world.queryAabb(this.headAabb());
        if (this.supported && headroom.status === 'clear') {
          vy = JUMP_VELOCITY; this.supported = false; this.jumpsAccepted += 1; this.lastAction = 'jump';
        } else {
          // No second jump in the air, unknown headroom is not clear, and a blocked
          // head stops the jump rather than clipping through.
          this.lastAction = 'jump-blocked'; this.jumpsBlocked += 1;
        }
        // Jump is a one-shot primitive. The plan may stay active to keep applying
        // forward/strafe during the arc, but it must not re-fire on landing.
        current.delta.jump = false;
      }
    }
    this.moveWithAxisSeparation(vx, vy, vz, dt);
    this.applyDisturbance();
    // Support is the thin slab below the feet; air/unknown beneath is not support.
    const floor = this.world.supportAtFeet(this.pose);
    this.supported = floor.status === 'blocked' && this.velocity.y <= 0;
    if (this.supported) this.velocity.y = 0;
    this.revision++;
    return this.read();
  }

  private headAabb() {
    return { minX: this.pose.x - BODY_HALF_WIDTH, minY: this.pose.y + FULL_BODY_HEIGHT, minZ: this.pose.z - BODY_HALF_WIDTH, maxX: this.pose.x + BODY_HALF_WIDTH, maxY: this.pose.y + FULL_BODY_HEIGHT + JUMP_APEX, maxZ: this.pose.z + BODY_HALF_WIDTH };
  }

  private collisionAt(pos: { x: number; y: number; z: number }) {
    return this.world.queryAabb({ minX: pos.x - BODY_HALF_WIDTH, minY: pos.y, minZ: pos.z - BODY_HALF_WIDTH, maxX: pos.x + BODY_HALF_WIDTH, maxY: pos.y + FULL_BODY_HEIGHT, maxZ: pos.z + BODY_HALF_WIDTH });
  }

  private moveWithAxisSeparation(vx: number, vy: number, vz: number, dt: number): void {
    const next = { x: this.pose.x + vx * dt, y: this.pose.y + vy * dt, z: this.pose.z + vz * dt };
    // Try the full move first. If it collides, allow axes independently so a
    // bounded jump can rise beside a step and a body can slide along a wall.
    // Unknown geometry blocks movement for the same reason: it is not air.
    if (this.collisionAt(next).status === 'clear') {
      this.pose = { ...this.pose, ...next };
      this.velocity = { x: vx, y: vy, z: vz };
      return;
    }
    let moved = false;
    if (vy !== 0) {
      const vertical = { x: this.pose.x, y: next.y, z: this.pose.z };
      if (this.collisionAt(vertical).status === 'clear') { this.pose.y = next.y; this.velocity = { x: 0, y: vy, z: 0 }; moved = true; }
      else if (vy < 0) {
        // Settle on the surface crossed by this downward step instead of hovering
        // just above it while gravity keeps being blocked.
        const surface = this.world.surfaceBetween(this.pose, next.y, this.pose.y);
        if (surface !== undefined) { this.pose.y = surface; this.velocity.y = 0; moved = true; }
        else this.velocity.y = 0;
      } else {
        this.velocity.y = 0;
      }
    }
    if (vx !== 0) {
      const alongX = { x: next.x, y: this.pose.y, z: this.pose.z };
      if (this.collisionAt(alongX).status === 'clear') { this.pose.x = next.x; this.velocity = { x: vx, y: this.velocity.y, z: 0 }; moved = true; }
    }
    if (vz !== 0) {
      const alongZ = { x: this.pose.x, y: this.pose.y, z: next.z };
      if (this.collisionAt(alongZ).status === 'clear') { this.pose.z = next.z; this.velocity = { x: this.velocity.x, y: this.velocity.y, z: vz }; moved = true; }
    }
    // Blocked entirely: do not teleport through the obstruction.
    if (!moved) this.velocity = { x: 0, y: 0, z: 0 };
  }

  private applyDisturbance(): void {
    const { disturbanceEvery, disturbance } = this.options;
    if (disturbanceEvery <= 0 || this.tickCount % disturbanceEvery !== 0) return;
    const roll = this.random();
    if (roll < 0.5) return;
    const dx = (this.random() * 2 - 1) * disturbance.x;
    const dz = (this.random() * 2 - 1) * disturbance.z;
    const dyaw = (this.random() * 2 - 1) * disturbance.yaw;
    const candidate = { x: this.pose.x + dx, y: this.pose.y, z: this.pose.z + dz };
    // Disturbance is observation/physics noise, never permission to enter blocked or unknown cells.
    if (this.collisionAt(candidate).status !== 'clear') return;
    this.pose = { ...this.pose, ...candidate, yaw: (this.pose.yaw + dyaw) % 360 };
  }

  read(): BodyObservation { return { context: this.context, pose: { ...this.pose }, velocity: { ...this.velocity }, supported: this.supported, revision: String(this.revision), source: 'simulated', gap: false }; }
}
