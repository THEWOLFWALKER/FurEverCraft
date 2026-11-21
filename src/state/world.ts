import type { BodyContext, WorldSnapshot } from '../contracts/index.js';
import { WorldSnapshotSchema } from '../contracts/index.js';
import { canonicalScopeKey, resolveStableScope, type ScopeResolution } from '../contracts/context.js';

type Cell = 'free'|'blocked'|'unknown';
export type Observation = WorldSnapshot & { observedAt:number; sequence:string; sourceEpoch?:string; ttl?:number; baseline?:'full'|'delta' };
const clone=<T>(v:T):T=>structuredClone(v);
const knownAccount = (context: BodyContext): string | undefined => (typeof context.accountId === 'string' && context.accountId.length > 0 ? context.accountId : undefined);
/** A known account never merges with a different or unknown account; both unknown is allowed. */
const sameStableContext = (a: BodyContext, b: BodyContext) => a.serverProfileId === b.serverProfileId && a.worldGenerationId === b.worldGenerationId && a.dimension === b.dimension && knownAccount(a) === knownAccount(b);
/** Sequences are non-negative decimal strings; anything else is a contract error, not a BigInt SyntaxError. */
const parseSequence = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('invalid-observation-sequence');
  return BigInt(value);
};

export class WorldState {
  private current?:Observation; private revision=0n; private lastSequence=0n; private epoch?:string; private gap=false;
  private readonly seenEpochs=new Set<string>();
  private readonly epochOrder:string[]=[];
  private readonly listeners=new Set<(s:WorldSnapshot)=>void>();
  constructor(private readonly context:BodyContext, private readonly now:()=>number=()=>Date.now(), private readonly maxSeenEpochs=1024){
    if(!Number.isInteger(maxSeenEpochs)||maxSeenEpochs<1) throw new Error('invalid-epoch-history-limit');
  }

  /** Bounded, insertion-ordered epoch history: old epochs are pruned so a long session cannot grow forever. */
  private rememberEpoch(epoch:string):void{
    if(this.seenEpochs.has(epoch)) return;
    this.seenEpochs.add(epoch); this.epochOrder.push(epoch);
    while(this.epochOrder.length>this.maxSeenEpochs){
      const oldest=this.epochOrder.shift();
      if(oldest!==undefined) this.seenEpochs.delete(oldest);
    }
  }
  /** Number of epoch identifiers currently retained for superseded-epoch detection. */
  get epochHistorySize():number{return this.seenEpochs.size;}

  apply(input:Observation):WorldSnapshot {
    const o = structuredClone(input);
    const parsed = WorldSnapshotSchema.parse(o);
    const c = parsed.context;
    if(!sameStableContext(c,this.context)) throw new Error('world-context-mismatch');
    const seq=parseSequence(o.sequence);
    const epoch=o.sourceEpoch??c.connectionEpoch;
    // A superseded epoch is never re-adopted, even by an explicit full snapshot. Epochs are
    // only ordered by the fact that they were once current; unseen epochs are accepted via a
    // full baseline without inventing an ordering between them.
    if(this.epoch!==undefined && epoch!==this.epoch && this.seenEpochs.has(epoch)) throw new Error('stale-source-epoch');
    const newEpoch=this.epoch!==epoch;
    const isFull=o.baseline==='full';
    // Same-epoch observations must advance the sequence, including full snapshots. A stale full
    // snapshot is not a new baseline and must not roll world state backwards.
    if(!newEpoch && seq<=this.lastSequence) return this.snapshot();
    if(newEpoch) this.rememberEpoch(epoch);
    if(newEpoch && !isFull) {
      this.epoch=epoch; this.lastSequence=seq;
      return this.invalidate('source-epoch-needs-baseline','all');
    }
    if(!newEpoch && !isFull) {
      const current=this.current;
      if(!current || this.gap) { this.epoch=epoch; this.lastSequence=seq; return this.invalidate('missing-baseline','all'); }
      const missing=seq>this.lastSequence+1n;
      // A gap is sticky: only an explicit full baseline without gap clears it.
      const mustGap=this.gap||missing||o.gap;
      const cells:Record<string,Cell> = mustGap
        ? { ...Object.fromEntries(Object.keys(current.cells).map(k=>[k,'unknown' as Cell])), ...Object.fromEntries(Object.keys(o.cells).map(k=>[k,'unknown' as Cell])) }
        : { ...current.cells, ...o.cells };
      this.epoch=epoch; this.lastSequence=seq; this.revision++;
      this.gap=mustGap;
      this.current={...o,...parsed,revision:this.revision.toString(),gap:this.gap,cells,fields:this.fieldsFor(o,mustGap)};
      const out=this.snapshot();
      for(const listener of this.listeners){try{listener(clone(out))}catch{ /* listener isolation */ }}
      return out;
    }
    // Full baseline. It clears uncertainty only when the snapshot itself is not gapped.
    const mustGap=o.gap===true;
    const cells:Record<string,Cell> = mustGap
      ? { ...Object.fromEntries(Object.keys(this.current?.cells ?? {}).map(k=>[k,'unknown' as Cell])), ...Object.fromEntries(Object.keys(o.cells).map(k=>[k,'unknown' as Cell])) }
      : o.cells;
    this.epoch=epoch; this.lastSequence=seq; this.revision++;
    this.gap=mustGap;
    this.current={...o,...parsed,revision:this.revision.toString(),gap:this.gap,cells,fields:this.fieldsFor(o,mustGap)};
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

  /** A gapped observation keeps field evidence unknown and unavailable, matching invalidate(). */
  private fieldsFor(source:Observation,gapped:boolean):WorldSnapshot['fields']{
    const fields=this.normalizeFields(source);
    if(!gapped) return fields;
    return Object.fromEntries(Object.entries(fields).map(([k,f])=>[k,{...f,freshness:'unknown' as const,available:false}]));
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
  /**
   * The stable identity of this world. Resolved only when every durable field is present;
   * callers must treat an unresolved result as "do not read or write trustworthy memory"
   * rather than filling the missing fields from the current session.
   */
  stableScope(): ScopeResolution { return resolveStableScope(this.context); }
  /** Canonical scope key for this observation stream, or undefined when unresolved. */
  scopeKey(): string | undefined {
    const resolved = this.stableScope();
    return resolved.status === 'resolved' ? canonicalScopeKey(resolved.scope) : undefined;
  }
  /** Copy of the immutable bridge context (never a live mutable reference). */
  contextSnapshot(): BodyContext { return clone(this.context); }
  matchesScope(value: unknown): boolean {
    const resolved = resolveStableScope(value as Partial<BodyContext> | undefined);
    const own = this.stableScope();
    return resolved.status === 'resolved' && own.status === 'resolved' && canonicalScopeKey(resolved.scope) === canonicalScopeKey(own.scope);
  }
  getInventory(){const s=this.snapshot();const evidence=s.fields.inventory;return{count:evidence?.available?s.inventory:undefined,source:evidence?.source??s.source,freshness:evidence?.freshness??'unknown'};}
  queryLocalWorld(){const s=this.snapshot();return{cells:clone(s.cells),revision:s.revision,gap:s.gap,freshness:s.freshness};}
  subscribe(l:(s:WorldSnapshot)=>void){this.listeners.add(l);return()=>this.listeners.delete(l);}
}
