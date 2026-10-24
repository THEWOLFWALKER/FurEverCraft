import type { BodyContext } from '../contracts/index.js';
import type { Aabb, BlockObservation, BlockPos, CellKnowledge, GeometryResult, ShapeKind, VoxelSnapshot, ValidationProfile } from './types.js';
const key=(p:BlockPos)=>`${p.x},${p.y},${p.z}`;
const clone=<T>(v:T):T=>structuredClone(v);
export const DEFAULT_VALIDATION: ValidationProfile={id:'fixture-v1',registryVersion:'fixture-registry-1',source:'fixture',approximate:false};
export class SparseVoxelWorld {
 private readonly blocks=new Map<string,BlockObservation>(); private revision=0;
 constructor(readonly context:BodyContext, readonly validation:ValidationProfile=DEFAULT_VALIDATION, private readonly now=()=>Date.now()) {}
 setBlock(pos:BlockPos, shape:Exclude<ShapeKind,'air'|'unsupported'>='full_cube', block?:string):void { this.revision++; this.blocks.set(key(pos),{pos:clone(pos),cell:'blocked',shape,...(block?{block}:{}),source:this.validation.source,observedAt:this.now(),revision:String(this.revision),validation:this.validation}); }
 setAir(pos:BlockPos):void { this.revision++; this.blocks.set(key(pos),{pos:clone(pos),cell:'free',shape:'air',source:this.validation.source,observedAt:this.now(),revision:String(this.revision),validation:this.validation}); }
 setUnknown(pos:BlockPos):void { this.revision++; this.blocks.set(key(pos),{pos:clone(pos),cell:'unknown',shape:'unsupported',source:this.validation.source,observedAt:this.now(),revision:String(this.revision),validation:this.validation}); }
 setUnsupported(pos:BlockPos):void { this.revision++; this.blocks.set(key(pos),{pos:clone(pos),cell:'unsupported',shape:'unsupported',source:this.validation.source,observedAt:this.now(),revision:String(this.revision),validation:this.validation}); }
 get(pos:BlockPos):BlockObservation { return clone(this.blocks.get(key(pos))??{pos:clone(pos),cell:'unknown',shape:'unsupported',source:this.validation.source,observedAt:this.now(),revision:String(this.revision),validation:this.validation}); }
 snapshot():VoxelSnapshot { return {context:this.context,revision:String(this.revision),blocks:new Map([...this.blocks].map(([k,v])=>[k,clone(v)])),source:this.validation.source,freshness:'current'}; }
 queryAabb(aabb:Aabb):GeometryResult { const deps:string[]=[]; const minX=Math.floor(aabb.minX),maxX=Math.ceil(aabb.maxX)-1,minY=Math.floor(aabb.minY),maxY=Math.ceil(aabb.maxY)-1,minZ=Math.floor(aabb.minZ),maxZ=Math.ceil(aabb.maxZ)-1; for(let x=minX;x<=maxX;x++)for(let y=minY;y<=maxY;y++)for(let z=minZ;z<=maxZ;z++){const b=this.get({x,y,z});deps.push(key({x,y,z}));if(b.cell==='unknown')return{status:'unknown',dependencies:deps};if(b.cell==='unsupported')return{status:'unsupported',dependencies:deps};if(b.cell==='blocked'&&this.overlaps(b,aabb))return{status:'blocked',dependencies:deps,reason:`collision:${key({x,y,z})}`};}return{status:'clear',dependencies:deps}; }
 private overlaps(b:BlockObservation,a:Aabb){const top=b.shape==='lower_slab'?b.pos.y+0.5:b.shape==='upper_slab'?b.pos.y+1:b.pos.y+1;const bottom=b.shape==='upper_slab'?b.pos.y+0.5:b.pos.y;return a.minX<b.pos.x+1&&a.maxX>b.pos.x&&a.minZ<b.pos.z+1&&a.maxZ>b.pos.z&&a.minY<top&&a.maxY>bottom;}
 /** Support for a body whose feet rest exactly at the integer block `pos.y`. */
 support(pos:BlockPos):GeometryResult { return this.queryAabb({minX:pos.x+0.1,minY:pos.y-0.05,minZ:pos.z+0.1,maxX:pos.x+0.9,maxY:pos.y+0.05,maxZ:pos.z+0.9}); }
 /**
  * Support for a continuous pose: only the thin slab *below* the feet is
  * queried, so a block occupying the feet cell can never be mistaken for the
  * floor. Unknown geometry is returned as unknown, never as air.
  */
 supportAtFeet(pose:{x:number;y:number;z:number}):GeometryResult { return this.queryAabb({minX:pose.x-0.35,minY:pose.y-0.08,minZ:pose.z-0.35,maxX:pose.x+0.35,maxY:pose.y-0.001,maxZ:pose.z+0.35}); }
 has(pos:BlockPos):boolean { return this.blocks.has(key(pos)); }
 /**
  * Highest blocked surface top crossed by a downward movement from `top` to
  * `bottom` over the body footprint. Used to settle on a support after a
  * blocked fall instead of hovering just above it. Unknown cells are not
  * surfaces.
  */
 surfaceBetween(pose:{x:number;z:number}, bottom:number, top:number):number|undefined {
  let highest:number|undefined;
  const minX=Math.floor(pose.x-0.35),maxX=Math.floor(pose.x+0.35),minZ=Math.floor(pose.z-0.35),maxZ=Math.floor(pose.z+0.35);
  for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++){
   if(!(x+1>pose.x-0.35&&x<pose.x+0.35&&z+1>pose.z-0.35&&z<pose.z+0.35))continue;
   for(let y=Math.floor(bottom)-1;y<=Math.ceil(top);y++){const b=this.blocks.get(key({x,y,z}));if(!b||b.cell!=='blocked')continue;const blockTop=b.shape==='lower_slab'?y+0.5:y+1;if(blockTop>bottom+1e-9&&blockTop<=top+1e-9&&(highest===undefined||blockTop>highest))highest=blockTop;}
  }
  return highest;
 }
 invalidate(pos:BlockPos):void { this.revision++; const b=this.get(pos); this.blocks.set(key(pos),{...b,cell:'unknown',shape:'unsupported',revision:String(this.revision)}); }
}
export const blockKey=key;
