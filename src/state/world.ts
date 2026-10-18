import type { BodyContext, WorldSnapshot } from '../contracts/index.js';
import { WorldSnapshotSchema } from '../contracts/index.js';

type Cell = 'free'|'blocked'|'unknown';
export type Observation = WorldSnapshot & { observedAt:number; sequence:string; sourceEpoch?:string; ttl?:number; baseline?:'full'|'delta' };
const clone=<T>(v:T):T=>structuredClone(v);
const sameStableContext = (a: BodyContext, b: BodyContext) => a.serverProfileId === b.serverProfileId && a.worldGenerationId === b.worldGenerationId && a.dimension === b.dimension;
/** Sequences are non-negative decimal strings; anything else is a contract error, not a BigInt SyntaxError. */
const parseSequence = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('invalid-observation-sequence');
  return BigInt(value);
};

export class WorldState {
  private current?:Observation; private revision=0n; private lastSequence=0n; private epoch?:string; private gap=false;
  private readonly listeners=new Set<(s:WorldSnapshot)=>void>();
  constructor(private readonly context:BodyContext, private readonly now:()=>number=()=>Date.now()){}

  apply(input:Observation):WorldSnapshot {
    const o = structuredClone(input);
    const parsed = WorldSnapshotSchema.parse(o);
    const c = parsed.context;
    if(!sameStableContext(c,this.context)) throw new Error('world-context-mismatch');
    const seq=parseSequence(o.sequence);
    const epoch=o.sourceEpoch??c.connectionEpoch;
    const newEpoch=this.epoch!==epoch;
    const isFull=o.baseline==='full';
    const hasBaseline=Boolean(this.current)&&!this.gap;
    if(newEpoch && !isFull) { this.epoch=epoch; this.lastSequence=seq; return this.invalidate('source-epoch-needs-baseline','all'); }
    if(!newEpoch && !isFull && seq<=this.lastSequence) return this.snapshot();
    if(!hasBaseline && !isFull) { this.epoch=epoch; this.lastSequence=seq; return this.invalidate('missing-baseline','all'); }
    const missing=!newEpoch&&!isFull&&seq>this.lastSequence+1n;
    // A gap is sticky: only an explicit full baseline clears it. Until then new deltas are not trusted.
    const mustGap=isFull ? false : (this.gap || missing || o.gap);
    // Deltas merge with the previous baseline; a full snapshot replaces it wholesale.
    const cells:Record<string,Cell> = mustGap
      ? { ...Object.fromEntries(Object.keys(this.current?.cells ?? {}).map(k=>[k,'unknown' as Cell])), ...Object.fromEntries(Object.keys(o.cells).map(k=>[k,'unknown' as Cell])) }
      : isFull || !this.current ? o.cells : { ...this.current.cells, ...o.cells };
    this.epoch=epoch; this.lastSequence=seq; this.revision++;
    this.gap=mustGap;
    if(!isFull && this.gap && !missing && !o.gap) { /* keep existing invalidated baseline */ }
    this.current={...o,...parsed,revision:this.revision.toString(),gap:this.gap,cells,fields:this.normalizeFields(o)};
    const out=this.snapshot();
    for(const listener of this.listeners){try{listener(clone(out))}catch{ /* listener isolation */ }}
    return out;
  }

  invalidate(reason='observation-gap',scope:'cells'|'all'='cells'):WorldSnapshot {
    this.revision++; this.gap=true;
    // Invalidating the default 'cells' scope demotes every known cell to unknown; keeping the old
    // values would let stale cells be read as current after the gap.
    if(this.current){const cells=Object.fromEntries(Object.keys(this.current.cells).map(k=>[k,'unknown' as Cell]));
      this.current={...this.current,revision:this.revision.toString(),freshness:'unknown',gap:true,cells,fields:Object.fromEntries(Object.entries(this.current.fields).map(([k,v])=>[k,{...v,freshness:'unknown',available:false}]))};}
    void scope;
    const out=this.snapshot(true);
    for(const listener of this.listeners){try{listener(clone(out))}catch{ /* listener isolation */ }}
    return out;
  }

  /** Re-evaluate field expiry at read time so a snapshot does not silently keep stale evidence current. */
  private normalizeFields(source?:Observation):WorldSnapshot['fields']{
    if(!source) return {};
    const now=this.now();
    return Object.fromEntries(Object.entries(source.fields).map(([k,f])=>{
      const expired=(source.ttl!==undefined&&now-source.observedAt>source.ttl)||(f.expiresAt!==undefined&&now>f.expiresAt);
      return [k,{...f,freshness:expired?'stale':f.freshness,available:expired?false:f.available}];
    }));
  }

  snapshot(gap=this.gap):WorldSnapshot {
    const fallback:WorldSnapshot={context:this.context,revision:this.revision.toString(),position:{x:0,y:0},cells:{},inventory:0,ui:'gameplay',source:'simulated',freshness:'unknown',gap,fields:{}};
    if(!this.current) return clone(WorldSnapshotSchema.parse(fallback));
    const fields=this.normalizeFields(this.current);
    const anyStale=Object.values(fields).some(f=>f.freshness==='stale'||f.freshness==='unknown');
    const freshness=gap?'unknown':anyStale?'stale':this.current.freshness;
    return clone(WorldSnapshotSchema.parse({...this.current,revision:this.revision.toString(),gap,fields,freshness}));
  }
  getState(){return this.snapshot();}
  getInventory(){const s=this.snapshot();const evidence=s.fields.inventory;return{count:evidence?.available?s.inventory:undefined,source:evidence?.source??s.source,freshness:evidence?.freshness??'unknown'};}
  queryLocalWorld(){const s=this.snapshot();return{cells:clone(s.cells),revision:s.revision,gap:s.gap,freshness:s.freshness};}
  subscribe(l:(s:WorldSnapshot)=>void){this.listeners.add(l);return()=>this.listeners.delete(l);}
}
