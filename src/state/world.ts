import type { BodyContext, WorldSnapshot } from '../contracts/index.js';
import { WorldSnapshotSchema } from '../contracts/index.js';

type Cell = 'free'|'blocked'|'unknown';
export type Observation = WorldSnapshot & { observedAt:number; sequence:string; sourceEpoch?:string; ttl?:number; baseline?:'full'|'delta' };
const clone=<T>(v:T):T=>structuredClone(v);
const sameStableContext = (a: BodyContext, b: BodyContext) => a.serverProfileId === b.serverProfileId && a.worldGenerationId === b.worldGenerationId && a.dimension === b.dimension;

export class WorldState {
 private current?:Observation; private revision=0n; private lastSequence=0n; private epoch?:string; private gap=false; private readonly listeners=new Set<(s:WorldSnapshot)=>void>();
 constructor(private readonly context:BodyContext,private readonly now:()=>number=()=>Date.now()){}
 apply(input:Observation):WorldSnapshot {
  const o = structuredClone(input);
  const parsed = WorldSnapshotSchema.parse(o);
  const c=parsed.context;
  if(!sameStableContext(c,this.context)) throw new Error('world-context-mismatch');
  const seq=BigInt(o.sequence); if(seq<0n) throw new Error('invalid-observation-sequence');
  const epoch=o.sourceEpoch??c.connectionEpoch;
  const newEpoch=this.epoch!==epoch;
  const full=o.baseline==='full' || (!this.current && !this.gap);
  if(newEpoch && !full) { this.invalidate('source-epoch-needs-baseline','all'); this.epoch=epoch; this.lastSequence=seq; return this.snapshot(); }
  if(!newEpoch && seq<=this.lastSequence) return this.snapshot();
  const missing=!newEpoch&&seq>this.lastSequence+1n;
  const missingBaseline=!this.current&&!full;
  const now=this.now();
  const fields=Object.fromEntries(Object.entries(o.fields).map(([k,f])=>{const expired=(o.ttl!==undefined&&now-o.observedAt>o.ttl)||(f.expiresAt!==undefined&&now>f.expiresAt);return [k,{...f,freshness:expired?'stale':f.freshness,available:expired?false:f.available}]}));
  const mustGap=o.gap||missing||missingBaseline;
  const cells:Record<string,Cell> = mustGap ? Object.fromEntries(Object.entries(o.cells).map(([k,v])=>[k,v==='blocked'?'unknown':v])) : o.cells;
  this.epoch=epoch; this.lastSequence=seq; this.revision++;
  this.gap=mustGap;
  this.current={...o,...parsed,revision:this.revision.toString(),gap:this.gap,fields,cells};
  const out=this.snapshot(); for(const listener of this.listeners){try{listener(out)}catch{}}
  return out;
 }
 invalidate(reason='observation-gap',scope:'cells'|'all'='cells'):WorldSnapshot {
  this.revision++; this.gap=true;
  if(this.current){const cells=scope==='all'?Object.fromEntries(Object.keys(this.current.cells).map(k=>[k,'unknown' as Cell])):this.current.cells;this.current={...this.current,revision:this.revision.toString(),freshness:'unknown',gap:true,cells,fields:Object.fromEntries(Object.entries(this.current.fields).map(([k,v])=>[k,{...v,freshness:'unknown',available:false}]))};}
  void reason; return this.snapshot(true);
 }
 snapshot(gap=this.gap):WorldSnapshot {const fallback:WorldSnapshot={context:this.context,revision:this.revision.toString(),position:{x:0,y:0},cells:{},inventory:0,ui:'gameplay',source:'simulated',freshness:'unknown',gap,fields:{}};return clone(WorldSnapshotSchema.parse(this.current?{...this.current,gap}:fallback));}
 getState(){return this.snapshot();}getInventory(){const s=this.snapshot();const evidence=s.fields.inventory;return{count:evidence?.available?s.inventory:undefined,source:evidence?.source??s.source,freshness:evidence?.freshness??'unknown'};}queryLocalWorld(){const s=this.snapshot();return{cells:clone(s.cells),revision:s.revision,gap:s.gap,freshness:s.freshness};}subscribe(l:(s:WorldSnapshot)=>void){this.listeners.add(l);return()=>this.listeners.delete(l);}
}
