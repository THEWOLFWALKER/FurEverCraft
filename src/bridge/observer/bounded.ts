import { randomUUID } from 'node:crypto';

export type ObserverLimits = { maxFrameBytes:number; maxDecompressedBytes:number; maxQueuedFrames:number; maxQueuedBytes:number; maxConcurrency:number; taskTimeoutMs:number; maxCompressionRatio:number; compressionRatioFloorBytes:number };
export type ObserverDirection = 'client-to-server'|'server-to-client';
export type ObserverPhase = 'HANDSHAKE'|'STATUS'|'LOGIN'|'CONFIGURATION'|'PLAY'|'UNKNOWN';
export type ObserverDirectionState = { direction:ObserverDirection; byteOffset:string; frameSequence:string; phase:ObserverPhase; compression:'disabled'|'enabled'|'ambiguous'|'unknown'; registryEpoch?:string };
export type ObserverHealth = 'healthy'|'degraded'|'unknown'|'stopped';
export type ObserverEvent = { kind:'observation'; source:'client'; sessionEpoch:string; direction:ObserverDirection; frameSequence:string; phase:ObserverPhase; payload:{ bytes:number; offsetStart:string; offsetEnd:string } } | { kind:'observer_gap'; source:'client'; sessionEpoch:string; gap:{ scope:'global'|'domain'; reason:string; direction?:ObserverDirection; fromFrame?:string; toFrame?:string } };
export type ObserverListener = (event:ObserverEvent)=>unknown;
type PendingFrame = { direction:ObserverDirection; frame:Buffer; frameSequence:string; phase:ObserverPhase; offsetStart:string; offsetEnd:string };

const defaults:ObserverLimits={maxFrameBytes:8*1024*1024,maxDecompressedBytes:32*1024*1024,maxQueuedFrames:128,maxQueuedBytes:32*1024*1024,maxConcurrency:2,taskTimeoutMs:2000,maxCompressionRatio:256,compressionRatioFloorBytes:1024*1024};
function varInt(buf:Buffer):{value:number,size:number}|undefined { let v=0; for(let i=0;i<5&&i<buf.length;i++){v|=(buf[i]&127)<<(7*i);if(!(buf[i]&128))return {value:v>>>0,size:i+1};} return undefined; }

export class BoundedObserver {
  readonly sessionEpoch=`observer_${randomUUID()}`;
  private healthValue:ObserverHealth='healthy';
  private readonly listeners=new Set<ObserverListener>();
  private readonly buffers:Record<ObserverDirection,Buffer>={'client-to-server':Buffer.alloc(0),'server-to-client':Buffer.alloc(0)};
  private readonly states:Record<ObserverDirection,ObserverDirectionState>={ 'client-to-server':{direction:'client-to-server',byteOffset:'0',frameSequence:'0',phase:'HANDSHAKE',compression:'disabled'}, 'server-to-client':{direction:'server-to-client',byteOffset:'0',frameSequence:'0',phase:'HANDSHAKE',compression:'disabled'} };
  private readonly pending:PendingFrame[]=[];
  private readonly consumed:Record<ObserverDirection,bigint>={'client-to-server':0n,'server-to-client':0n};
  private queuedBytes=0;
  private stopped=false;
  private draining=false;
  private readonly limits:ObserverLimits;
  constructor(limits:Partial<ObserverLimits>={}){this.limits={...defaults,...limits};}
  get health(){return this.healthValue;}
  queued(){return {frames:this.pending.length,bytes:this.queuedBytes};}
  attach(direction:ObserverDirection, chunk:Uint8Array){
    if(this.stopped)return;
    const state=this.states[direction];
    if(state.phase==='UNKNOWN')return;
    const incoming=Buffer.from(chunk);
    state.byteOffset=(BigInt(state.byteOffset)+BigInt(incoming.length)).toString();
    const queuedTotal=this.buffers[direction].length+incoming.length;
    if(queuedTotal>this.limits.maxQueuedBytes){state.phase='UNKNOWN';this.gap('global','frame-overflow',direction);this.buffers[direction]=Buffer.alloc(0);return;}
    this.buffers[direction]=this.buffers[direction].length?Buffer.concat([this.buffers[direction],incoming]):incoming;
    while(true){
      const parsed=varInt(this.buffers[direction]);
      if(!parsed)break;
      if(parsed.value>this.limits.maxFrameBytes){state.phase='UNKNOWN';this.gap('global','frame-overflow',direction);this.buffers[direction]=Buffer.alloc(0);return;}
      const total=parsed.size+parsed.value;
      if(this.buffers[direction].length<total)break;
      const frame=this.buffers[direction].subarray(0,total);
      this.buffers[direction]=this.buffers[direction].subarray(total);
      const offsetStart=this.consumed[direction].toString();
      const offsetEnd=(this.consumed[direction]+BigInt(total)).toString();
      this.consumed[direction]=BigInt(offsetEnd);
      const seq=(BigInt(state.frameSequence)+1n).toString();
      if(this.pending.length>=this.limits.maxQueuedFrames||this.queuedBytes+frame.length>this.limits.maxQueuedBytes){this.gap('domain','queue-overflow',direction,state.frameSequence);continue;}
      state.frameSequence=seq;
      this.pending.push({direction,frame:Buffer.from(frame),frameSequence:seq,phase:state.phase,offsetStart,offsetEnd});
      this.queuedBytes+=frame.length;
    }
    void this.drain();
  }
  subscribe(listener:ObserverListener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  state(){return {upstream:{...this.states['server-to-client']},downstream:{...this.states['client-to-server']}};}
  markUnknown(reason='framing-loss',direction?:ObserverDirection){this.healthValue='unknown';if(direction)this.states[direction].phase='UNKNOWN';this.gap('global',reason,direction);}
  reset(direction:ObserverDirection){this.states[direction].phase='HANDSHAKE';this.states[direction].compression='disabled';if(this.healthValue==='unknown'||this.healthValue==='degraded')this.healthValue='healthy';}
  private async drain(){
    if(this.draining||this.stopped)return;
    this.draining=true;
    try{
      while(this.pending.length){
        // Never exceed maxConcurrency live listeners even when a previous batch timed out.
        const batch=this.pending.splice(0,Math.max(1,this.limits.maxConcurrency-this.inflight));
        for(const item of batch)this.queuedBytes=Math.max(0,this.queuedBytes-item.frame.length);
        await Promise.all(batch.map(item=>this.dispatch(item)));
      }
    } finally { this.draining=false; }
  }
  private inflight=0;
  private async dispatch(item:PendingFrame){
    const event:ObserverEvent={kind:'observation',source:'client',sessionEpoch:this.sessionEpoch,direction:item.direction,frameSequence:item.frameSequence,phase:item.phase,payload:{bytes:item.frame.length,offsetStart:item.offsetStart,offsetEnd:item.offsetEnd}};
    this.inflight+=1;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<void>(resolve=>{ timer=setTimeout(()=>{ this.healthValue=this.healthValue==='healthy'?'degraded':this.healthValue; resolve(); },this.limits.taskTimeoutMs); });
    const work=Promise.all([...this.listeners].map(listener=>Promise.resolve().then(()=>listener(event)).catch(()=>undefined))).then(()=>undefined);
    await Promise.race([work,timeout]);
    // On timeout the listener may still be running; keep the slot counted until it settles.
    void work.finally(()=>{ this.inflight=Math.max(0,this.inflight-1); });
    if(timer)clearTimeout(timer);
  }
  private gap(scope:'global'|'domain',reason:string,direction?:ObserverDirection,fromFrame?:string){if(this.healthValue==='healthy')this.healthValue='degraded';this.emit({kind:'observer_gap',source:'client',sessionEpoch:this.sessionEpoch,gap:{scope,reason,direction,fromFrame,toFrame:direction?this.states[direction].frameSequence:undefined}});}
  private emit(event:ObserverEvent){for(const listener of this.listeners){try{void listener(event);}catch{ /* observer consumers are isolated */ }}}
  async stop(){if(this.stopped)return;this.stopped=true;this.healthValue='stopped';this.pending.length=0;this.queuedBytes=0;this.listeners.clear();}
}
export function createBoundedObserver(limits?:Partial<ObserverLimits>){return new BoundedObserver(limits);}
