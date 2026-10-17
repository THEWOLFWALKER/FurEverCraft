import { BodyContext, CellSchema, WorldSnapshot, nextId } from '../../contracts/index.js';
import { z } from 'zod';
export type UiMode = 'gameplay'|'chat'|'inventory';
export type FakeFault = 'disconnect'|'drop'|'delay'|'failure'|'ambiguous';
export type FakeFaultConfig = { fault: FakeFault; count?: number; delayMs?: number; error?: string };
export type FakeBridgeOptions = { context?: Partial<BodyContext>; faults?: Partial<Record<'walk'|'place'|'snapshot', FakeFaultConfig>>; delay?: (ms:number)=>void };
const clone = <T>(v:T):T => structuredClone(v);
export class FakeClientBridge {
 readonly context: BodyContext; position={x:0,y:0}; inventory=8; ui:UiMode='gameplay'; private cells=new Map<string,z.infer<typeof CellSchema>>(); private seq=0; private session=1; private readonly faults: FakeBridgeOptions['faults']; private readonly sleep:(ms:number)=>void;
 constructor(public readonly size=12, options:FakeBridgeOptions={}) { this.context={serverProfileId:'simulated',worldGenerationId:'world-1',connectionEpoch:'1',bodyEpoch:'1',dimension:'overworld',...options.context}; this.faults=options.faults??{}; this.sleep=options.delay??(()=>undefined); for(let x=0;x<size;x++)for(let y=0;y<size;y++)this.cells.set(`${x},${y}`,'free'); }
 get sessionEpoch(){return `${this.context.connectionEpoch}:${this.session}`;}
 disconnect(){this.session++;}
 configureFault(op:'walk'|'place'|'snapshot', config?:FakeFaultConfig){if(config)this.faults![op]={...config};else delete this.faults![op];}
 private fault(op:'walk'|'place'|'snapshot'){const c=this.faults?.[op];if(!c)return; if(c.count!==undefined){if(c.count<=0)return;c.count--;} if(c.fault==='delay')this.sleep(c.delayMs??0); if(c.fault==='disconnect'){this.disconnect();throw new Error('bridge-disconnected');} if(c.fault==='failure')throw new Error(c.error??'bridge-failure'); return c.fault;}
 block(x:number,y:number){this.cells.set(`${x},${y}`,'blocked');} setUnknown(x:number,y:number){this.cells.set(`${x},${y}`,'unknown');} cell(x:number,y:number){return this.cells.get(`${x},${y}`)??'unknown';}
 walk(x:number,y:number){const f=this.fault('walk');if(f==='drop')return;if(this.ui!=='gameplay')throw new Error('ui-conflict');if(Math.abs(x-this.position.x)+Math.abs(y-this.position.y)!==1)throw new Error('non-adjacent');if(this.cell(x,y)!=='free')throw new Error('blocked-or-unknown');this.position={x,y};this.seq++;if(f==='ambiguous')throw new Error('bridge-ambiguous');}
 place(x:number,y:number){const f=this.fault('place');if(f==='drop')return {accepted:false,ambiguous:true,commandId:nextId('place'),seq:this.seq};if(this.inventory<1)throw new Error('empty-inventory');if(Math.abs(x-this.position.x)+Math.abs(y-this.position.y)!==1||this.cell(x,y)!=='free')throw new Error('invalid-place');this.inventory--;this.block(x,y);const r={accepted:true,commandId:nextId('place'),seq:this.seq};return f==='ambiguous'?{...r,ambiguous:true}:r;}
 setUi(ui:UiMode){this.ui=ui;}
 snapshot(gap=false):WorldSnapshot {const f=this.fault('snapshot');const unavailable=f==='drop'||f==='ambiguous';const now=this.seq;const fields: Record<string,{source:'simulated';observedAt:number;expiresAt:number;freshness:'unknown'|'current';available:boolean}> = Object.fromEntries(['position','cells','inventory','ui'].map(k=>[k,{source:'simulated',observedAt:now,expiresAt:now+1,freshness:unavailable?'unknown':'current',available:!unavailable}]));return clone({context:this.context,revision:String(this.seq),position:{...this.position},cells:Object.fromEntries(this.cells),inventory:this.inventory,ui:this.ui,source:'simulated',freshness:unavailable?'unknown':'current',gap:gap||unavailable,fields});}
}
