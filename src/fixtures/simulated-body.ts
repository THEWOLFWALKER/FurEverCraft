import type { BodyContext, Clock } from '../contracts/index.js';
import type { InputPlan3D, InputReceipt, Pose3D, BodyObservation, BodyCorrection, InputGateway, BodyReader } from '../motor/types.js';
import type { SparseVoxelWorld } from '../motor/geometry.js';

const GRAVITY = 0.08;
const JUMP_VELOCITY = 0.32;
const WALK_SPEED = 0.1;

export class SimulatedBody implements InputGateway, BodyReader {
 private pose: Pose3D = { x: .5, y: 1, z: .5, yaw: 0, pitch: 0 };
 private velocity = { x: 0, y: 0, z: 0 };
 private supported = true;
 private revision = 0;
 private owner?: string;
 private active = new Map<string, InputPlan3D>();
 private correction?: BodyCorrection;
 private ticking = false;
 constructor(readonly context: BodyContext, readonly world: SparseVoxelWorld, readonly clock: Clock) {}

 submit(plan: InputPlan3D): InputReceipt {
  const now = this.clock.now();
  if (plan.context.connectionEpoch !== this.context.connectionEpoch || plan.context.bodyEpoch !== this.context.bodyEpoch) return { commandId: plan.commandId, accepted: false, reason: 'context-mismatch', observedRevision: String(this.revision) };
  if (now > plan.deadline || now - plan.generatedAt > plan.maxAge) return { commandId: plan.commandId, accepted: false, reason: 'input-expired', observedRevision: String(this.revision) };
  if (this.owner && this.owner !== plan.ownerToken) return { commandId: plan.commandId, accepted: false, reason: 'old-owner', observedRevision: String(this.revision) };
  this.owner = plan.ownerToken;
  this.active.set(plan.commandId, plan);
  return { commandId: plan.commandId, accepted: true, observedRevision: String(this.revision) };
 }
 /** Continuous control: an active input keeps applying until replaced or released. */
 release(ownerToken: string): void { if (this.owner === ownerToken) { this.active.clear(); this.owner = undefined; } }
 injectCorrection(correction: BodyCorrection): void { this.correction = correction; }
 tick(): BodyObservation {
  if (this.correction) { this.pose = { ...this.correction.pose }; this.correction = undefined; this.revision++; }
  const input = [...this.active.values()].at(-1);
  // Drop expired plans so a stale command cannot keep moving the body after its deadline.
  const now = this.clock.now();
  for (const [id, plan] of this.active) if (now > plan.deadline || now - plan.generatedAt > plan.maxAge) this.active.delete(id);
  const current = [...this.active.values()].at(-1) ?? input;
  const dt = 1;
  let vx = this.velocity.x; let vy = this.velocity.y - GRAVITY * dt; let vz = this.velocity.z;
  if (current) {
   const forward = current.delta.forward ?? 0; const strafe = current.delta.strafe ?? 0;
   // Movement is body-relative: rotate the requested direction by the current yaw.
   const yaw = (this.pose.yaw * Math.PI) / 180;
   vx = (forward * Math.cos(yaw) - strafe * Math.sin(yaw)) * WALK_SPEED;
   vz = (forward * Math.sin(yaw) + strafe * Math.cos(yaw)) * WALK_SPEED;
   if (current.delta.yaw) this.pose.yaw = (this.pose.yaw + current.delta.yaw) % 360;
   if (current.delta.jump && this.supported) { vy = JUMP_VELOCITY; this.supported = false; }
  }
  const next = { ...this.pose, x: this.pose.x + vx * dt, y: this.pose.y + vy * dt, z: this.pose.z + vz * dt };
  const collision = this.world.queryAabb({ minX: next.x - .35, minY: next.y, minZ: next.z - .35, maxX: next.x + .35, maxY: next.y + 1.8, maxZ: next.z + .35 });
  if (collision.status === 'clear') { this.pose = next; this.velocity = { x: vx, y: vy, z: vz }; }
  else { this.velocity = { x: 0, y: 0, z: 0 }; vy = 0; }
  // Support is the floor directly beneath the body; air beneath is not a support surface.
  const floor = this.world.support({ x: Math.floor(this.pose.x), y: Math.floor(this.pose.y - 0.05), z: Math.floor(this.pose.z) });
  this.supported = floor.status === 'blocked' && this.velocity.y <= 0;
  if (this.supported && this.pose.y < 1) this.pose.y = 1;
  if (this.supported) this.velocity.y = 0;
  this.revision++;
  return this.read();
 }
 read(): BodyObservation { return { context: this.context, pose: { ...this.pose }, velocity: { ...this.velocity }, supported: this.supported, revision: String(this.revision), source: 'simulated', gap: false }; }
}
