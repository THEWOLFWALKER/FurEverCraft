import { PositionProjector } from './position.js';
import { BlocksProjector } from './blocks.js';
import { EntitiesProjector } from './entities.js';
import { InventoryProjector } from './inventory.js';
import { ChatProjector } from './chat.js';
import { LifecycleProjector } from './lifecycle.js';
import type { DomainFamily, DomainProjector, ProjectionResult, ProjectionScope, PacketEnvelope } from './types.js';

export * from './types.js';
export { POSITION_SCHEMA, PositionProjector } from './position.js';
export { BLOCKS_SCHEMA, BlocksProjector } from './blocks.js';
export { ENTITIES_SCHEMA, EntitiesProjector } from './entities.js';
export { INVENTORY_SCHEMA, InventoryProjector } from './inventory.js';
export { CHAT_SCHEMA, ChatProjector } from './chat.js';
export { LIFECYCLE_SCHEMA, LifecycleProjector } from './lifecycle.js';

/** Explicit synthetic contract fixtures used to assemble and verify the projection pipeline. */
export function createSyntheticProjectors(): DomainProjector[] {
  return [
    new PositionProjector(),
    new BlocksProjector(),
    new EntitiesProjector(),
    new InventoryProjector(),
    new ChatProjector(),
    new LifecycleProjector(),
  ];
}

export type ProjectionAvailability = {
  release: string;
  real26_3Projectors: 'unavailable';
  syntheticFixture: 'assembly-only';
  families: DomainFamily[];
  reason: string;
};

/**
 * The repository has no verified 26.3 schema. Real 26.3 projectors therefore stay
 * unavailable; only synthetic fixtures exercise assembly. This is a capability report,
 * not a claim that 26.3 packets can be decoded.
 */
export function realProjectionAvailability(): ProjectionAvailability {
  return {
    release: '26.3',
    real26_3Projectors: 'unavailable',
    syntheticFixture: 'assembly-only',
    families: ['position', 'blocks', 'entities', 'inventory', 'chat', 'lifecycle'],
    reason: '26.3-codec-data-unavailable',
  };
}

export function projectWith(projectors: readonly DomainProjector[], packet: PacketEnvelope, scope: ProjectionScope, sessionEpoch: string, sequence: string): { projector?: DomainProjector; result: ProjectionResult } {
  const projector = projectors.find(candidate => candidate.handles(packet.name));
  if (!projector) {
    return { result: { ok: false, rejection: { code: 'unknown-packet-family', reason: `no projector owns packet ${packet.name}`, packet: packet.name } } };
  }
  return { projector, result: projector.project(packet, scope, sessionEpoch, sequence) };
}
