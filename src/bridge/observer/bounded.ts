import { randomUUID } from 'node:crypto';

export type ObserverLimits = { maxFrameBytes:number; maxDecompressedBytes:number; maxQueuedFrames:number; maxQueuedBytes:number; maxConcurrency:number; taskTimeoutMs:number; maxCompressionRatio:number; compressionRatioFloorBytes:number };
export type ObserverDirection = 'client-to-server'|'server-to-client';
export type ObserverPhase = 'HANDSHAKE'|'STATUS'|'LOGIN'|'CONFIGURATION'|'PLAY'|'UNKNOWN';
/**
 * FEC-401/402: this observer only frames raw bytes. It does not decompress or parse packet IDs and
 * has no proven causal boundary for phase/compression transitions, so it reports those as
 * 'unsupported' rather than a false 'disabled'. 'UNKNOWN' still means framing was lost.
 */
export type ObserverPhaseState = ObserverPhase|'unsupported';
export type ObserverCompressionState = 'disabled'|'unsupported';
/** FEC-403: observation payloads carry frame metadata only; no packet ID or fields were decoded. */
export type ObserverPayloadKind = 'frame-metadata';
export type ObserverDirectionState = { direction:ObserverDirection; byteOffset:string; frameSequence:string; phase:ObserverPhaseState; compression:ObserverCompressionState; payloadKind:ObserverPayloadKind; availability:'degraded'|'unknown'; registryEpoch?:string };
export type ObserverHealth = 'healthy'|'degraded'|'unknown'|'stopped';
export type ObserverEvent = { kind:'observation'; source:'client'; sessionEpoch:string; direction:ObserverDirection; frameSequence:string; phase:ObserverPhaseState; availability:'degraded'; payload:{ kind:ObserverPayloadKind; bytes:number; offsetStart:string; offsetEnd:string; packetId?:never; fields?:never } } | { kind:'observer_gap'; source:'client'; sessionEpoch:string; gap:{ scope:'global'|'domain'; reason:string; direction?:ObserverDirection; fromFrame?:string; toFrame?:string } };
export type ObserverListener = (event:ObserverEvent)=>unknown;
type PendingFrame = { direction:ObserverDirection; frame:Buffer; frameSequence:string; phase:ObserverPhaseState; offsetStart:string; offsetEnd:string };

const defaults:ObserverLimits={maxFrameBytes:8*1024*1024,maxDecompressedBytes:32*1024*1024,maxQueuedFrames:128,maxQueuedBytes:32*1024*1024,maxConcurrency:2,taskTimeoutMs:2000,maxCompressionRatio:256,compressionRatioFloorBytes:1024*1024};
const UNSUPPORTED_PHASE:'unsupported'='unsupported'; const UNSUPPORTED_COMPRESSION:'unsupported'='unsupported'; const PAYLOAD_KIND:'frame-metadata'='frame-metadata';
const directionState=(direction:ObserverDirection):ObserverDirectionState=>({direction,byteOffset:'0',frameSequence:'0',phase:UNSUPPORTED_PHASE,compression:UNSUPPORTED_COMPRESSION,payloadKind:PAYLOAD_KIND,availability:'degraded'});
function varInt(buf:Buffer):{value:number,size:number}|undefined { let v=0; for(let i=0;i<5&&i<buf.length;i++){v|=(buf[i]&127)<<(7*i);if(!(buf[i]&128))return {value:v>>>0,size:i+1};} return undefined; }

export class BoundedObserver {
  readonly sessionEpoch=`observer_${randomUUID()}`;
  private healthValue:ObserverHealth='healthy';
  private readonly listeners=new Set<ObserverListener>();
  private readonly buffers:Record<ObserverDirection,Buffer>={'client-to-server':Buffer.alloc(0),'server-to-client':Buffer.alloc(0)};
  private readonly states:Record<ObserverDirection,ObserverDirectionState>={ 'client-to-server':directionState('client-to-server'), 'server-to-client':directionState('server-to-client') };
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
    if(queuedTotal>this.limits.maxQueuedBytes){state.phase='UNKNOWN';state.availability='unknown';this.gap('global','frame-overflow',direction);this.buffers[direction]=Buffer.alloc(0);return;}
    this.buffers[direction]=this.buffers[direction].length?Buffer.concat([this.buffers[direction],incoming]):incoming;
    while(true){
      const parsed=varInt(this.buffers[direction]);
      if(!parsed)break;
      if(parsed.value>this.limits.maxFrameBytes){state.phase='UNKNOWN';state.availability='unknown';this.gap('global','frame-overflow',direction);this.buffers[direction]=Buffer.alloc(0);return;}
      const total=parsed.size+parsed.value;
      if(this.buffers[direction].length<total)break;
      const frame=this.buffers[direction].subarray(0,total);
      this.buffers[direction]=this.buffers[direction].subarray(total);
      const offsetStart=this.consumed[direction].toString();
      const offsetEnd=(this.consumed[direction]+BigInt(total)).toString();
      this.consumed[direction]=BigInt(offsetEnd);
      const seq=(BigInt(state.frameSequence)+1n).toString();
      if(this.pending.length>=this.limits.maxQueuedFrames||this.queuedBytes+frame.length>this.limits.maxQueuedBytes){
        // Drop the frame but advance the sequence so the gap reports a real lost range.
        const fromFrame=state.frameSequence; state.frameSequence=seq;
        this.gap('domain','queue-overflow',direction,fromFrame);
        continue;
      }
      state.frameSequence=seq;
      this.pending.push({direction,frame:Buffer.from(frame),frameSequence:seq,phase:state.phase,offsetStart,offsetEnd});
      this.queuedBytes+=frame.length;
    }
    void this.drain();
  }
  subscribe(listener:ObserverListener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  state(){return {upstream:{...this.states['server-to-client']},downstream:{...this.states['client-to-server']}};}
  markUnknown(reason='framing-loss',direction?:ObserverDirection){this.healthValue='unknown';if(direction){this.states[direction].phase='UNKNOWN';this.states[direction].availability='unknown';}this.gap('global',reason,direction);}
  reset(direction:ObserverDirection){
    // A reset starts a fresh frame sequence; any partial frame from the previous epoch must not
    // be glued onto the next one. Phase/compression stay 'unsupported': reset cannot make them known.
    this.buffers[direction]=Buffer.alloc(0);
    this.consumed[direction]=0n;
    this.states[direction].phase=UNSUPPORTED_PHASE;
    this.states[direction].compression=UNSUPPORTED_COMPRESSION;
    this.states[direction].availability='degraded';
    this.states[direction].frameSequence='0';
    const unknown=Object.values(this.states).some(state=>state.phase==='UNKNOWN');
    if(!unknown&&(this.healthValue==='unknown'||this.healthValue==='degraded'))this.healthValue='healthy';
  }
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
    // Frame metadata only: the VarInt length prefix is framing, not a decoded packet ID; no fields are parsed.
    const event:ObserverEvent={kind:'observation',source:'client',sessionEpoch:this.sessionEpoch,direction:item.direction,frameSequence:item.frameSequence,phase:item.phase,availability:'degraded',payload:{kind:PAYLOAD_KIND,bytes:item.frame.length,offsetStart:item.offsetStart,offsetEnd:item.offsetEnd}};
    this.inflight+=1;
    let released=false;
    const release=()=>{ if(released)return; released=true; this.inflight=Math.max(0,this.inflight-1); };
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<void>(resolve=>{ timer=setTimeout(()=>{ this.healthValue=this.healthValue==='healthy'?'degraded':this.healthValue; resolve(); },this.limits.taskTimeoutMs); });
    const work=Promise.all([...this.listeners].map(listener=>Promise.resolve().then(()=>listener(event)).catch(()=>undefined))).then(()=>undefined);
    await Promise.race([work,timeout]);
    // On timeout release the slot immediately so a hung listener cannot exceed maxConcurrency.
    // The listener may keep running; its eventual settlement must not double-release.
    release();
    work.finally(()=>release());
    if(timer)clearTimeout(timer);
  }
  private gap(scope:'global'|'domain',reason:string,direction?:ObserverDirection,fromFrame?:string){if(this.healthValue==='healthy')this.healthValue='degraded';this.emit({kind:'observer_gap',source:'client',sessionEpoch:this.sessionEpoch,gap:{scope,reason,direction,fromFrame,toFrame:direction?this.states[direction].frameSequence:undefined}});}
  private emit(event:ObserverEvent){for(const listener of this.listeners){try{void listener(event);}catch{ /* observer consumers are isolated */ }}}
  async stop(){if(this.stopped)return;this.stopped=true;this.healthValue='stopped';this.pending.length=0;this.queuedBytes=0;this.listeners.clear();}
}
export function createBoundedObserver(limits?:Partial<ObserverLimits>){return new BoundedObserver(limits);}
