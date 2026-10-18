import type { Clock } from '../contracts/index.js';
export type ProgressKind='observation_no_update'|'observation_new_no_progress'|'phase_wait'|'external_block'|'control_channel_error';
export type ProgressSample={kind:ProgressKind;failureSignature:string;hasNewEvidence:boolean;ownerToken:string};
export type RecoveryDecision={action:'continue'|'cooldown'|'replan'|'pause'|'control-lost';reason:string;ownerToken:string;attempts:number};
export class ProgressController {
 private attempts=new Map<string,number>(); private cooldownUntil=0;
 constructor(private readonly clock:Clock, private readonly maxAttempts=3, private readonly cooldownMs=30000) {}
 record(sample:ProgressSample):RecoveryDecision {
  const now=this.clock.now();
  if(now<this.cooldownUntil)return{action:'cooldown',reason:'failure-cooldown',ownerToken:sample.ownerToken,attempts:this.attempts.get(sample.failureSignature)??0};
  // The cooldown window has elapsed: clear the attempt budget for this signature so new
  // evidence is not permanently rejected by stale counts.
  const count=(this.attempts.get(sample.failureSignature)??0)+1;
  if(count>=this.maxAttempts){this.attempts.set(sample.failureSignature,0);this.cooldownUntil=now+this.cooldownMs;return{action:'cooldown',reason:sample.failureSignature,ownerToken:sample.ownerToken,attempts:count};}
  this.attempts.set(sample.failureSignature,count);
  if(!sample.hasNewEvidence)return{action:'continue',reason:'no-new-evidence',ownerToken:sample.ownerToken,attempts:count};
  if(sample.kind==='control_channel_error')return{action:'control-lost',reason:sample.kind,ownerToken:sample.ownerToken,attempts:count};
  if(sample.kind==='external_block')return{action:'replan',reason:sample.kind,ownerToken:sample.ownerToken,attempts:count};
  if(sample.kind==='phase_wait')return{action:'pause',reason:sample.kind,ownerToken:sample.ownerToken,attempts:count};
  return{action:'continue',reason:sample.kind,ownerToken:sample.ownerToken,attempts:count};
 }
 reset(signature?:string):void {if(signature)this.attempts.delete(signature);else this.attempts.clear();}
}
