import type { BlockPos } from '../motor/types.js';
import type { SparseVoxelWorld } from '../motor/geometry.js';
export type FixtureEdit={pos:BlockPos;kind:'air'|'full_cube'|'lower_slab'|'upper_slab'|'unknown'|'unsupported';block?:string};
export class VoxelFixtureWorld {
 constructor(readonly world:SparseVoxelWorld) {}
 edit(edit:FixtureEdit):void {if(edit.kind==='air')this.world.setAir(edit.pos);else if(edit.kind==='unknown')this.world.setUnknown(edit.pos);else if(edit.kind==='unsupported')this.world.setUnsupported(edit.pos);else this.world.setBlock(edit.pos,edit.kind,edit.block);}
 observe(center:BlockPos,radius=4){const snapshot=this.world.snapshot();const blocksArray=[...snapshot.blocks.values()].filter(b=>Math.abs(b.pos.x-center.x)<=radius&&Math.abs(b.pos.y-center.y)<=radius&&Math.abs(b.pos.z-center.z)<=radius);const blocks=new Map(blocksArray.map(b=>[`${b.pos.x},${b.pos.y},${b.pos.z}`,b] as const));return{...snapshot,blocks};}
}
