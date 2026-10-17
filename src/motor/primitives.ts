import type { BodyContext, Clock } from '../contracts/index.js';
import { nextId } from '../contracts/index.js';
import type { BlockPos, InputPlan3D, MotorDeps, Pose3D } from './types.js';
export type PrimitivePhase='check'|'run'|'verify'|'stable'|'complete'|'canceled'|'failed';
export type PrimitiveResult={status:'succeeded'|'failed'|'canceled';phase:PrimitivePhase;reason?:string;pose:Pose3D};
export class Motor {
 constructor(private readonly deps:MotorDeps) {}
 private send(delta:InputPlan3D['delta'], ownerToken=nextId('owner')):PrimitiveResult {const before=this.deps.reader.read();const now=this.deps.clock.now();const plan={commandId:nextId('cmd'),executionId:nextId('exec'),context:this.deps.context,leaseId:nextId('lease'),sequence:nextId('seq'),sourceEpoch:this.deps.context.connectionEpoch,generatedAt:now,clockDomain:'manual',maxAge:100,observationRef:before.revision,leaseUntil:now+100,kind:'walk' as const,payload:{},ownerToken,deadline:now+100,snapshotRevision:before.revision,heldSet:[],delta};const receipt=this.deps.input.submit(plan);if(!receipt.accepted)return{status:'failed',phase:'failed',reason:receipt.reason,pose:before.pose};const after=this.deps.reader.read();return{status:'succeeded',phase:'complete',pose:after.pose};}
 orientTo(yaw:number):PrimitiveResult {const current=this.deps.reader.read().pose;return this.send({yaw:yaw-current.yaw});}
 walkCorridor(from:BlockPos,to:BlockPos):PrimitiveResult {return this.send({forward:Math.sign(to.x-from.x),strafe:Math.sign(to.z-from.z)});}
 stepUp(from:BlockPos,to:BlockPos):PrimitiveResult{return this.send({forward:Math.sign(to.x-from.x),strafe:Math.sign(to.z-from.z),jump:true});}
 jumpShort(from:BlockPos,to:BlockPos):PrimitiveResult{return this.send({forward:Math.sign(to.x-from.x),strafe:Math.sign(to.z-from.z),jump:true});}
 controlledDrop(from:BlockPos,to:BlockPos):PrimitiveResult{return this.send({forward:Math.sign(to.x-from.x),strafe:Math.sign(to.z-from.z)});}
}
export type { MotorDeps };
