import { describe, expect, it } from 'vitest';
import {
  createSyntheticProjectors,
  isFiniteNumber,
  isString,
  realProjectionAvailability,
  type DomainFamily,
  type DomainProjection,
  type PacketEnvelope,
  type ProjectionDirection,
  type ProjectionScope,
  type Provenance,
} from '../../src/bridge/protocol/projectors/index.js';
import { DomainProjectionPipeline } from '../../src/bridge/protocol/projection-pipeline.js';

/**
 * SYNTHETIC-ONLY ASSEMBLY FIXTURE — NOT REAL 26.3 OR CLIENT EVIDENCE.
 *
 * There is no verified 26.3 schema/native/data in this repository, so there is no real
 * decoded packet payload to feed the projection pipeline. These explicit `PacketEnvelope`s
 * and the synthetic projectors only prove the assembly contract
 * envelope -> ordered pipeline -> consumer state. Every projection must keep
 * `source: 'synthetic'` / `release: 'synthetic-fixture'`; nothing here may be reported as
 * real-client, live-server or 26.3 compatibility evidence.
 *
 * The consumer below is deliberately test-only. `WorldState` cannot consume these
 * projections truthfully: its contract only has integer 2D x/y (the projection is 3D),
 * no block-name/chat/lifecycle fields, and its evidence-source enum has no `synthetic`
 * value. Mapping synthetic data into it would either drop observed fields or mislabel
 * provenance, so this file does not fake that production wiring.
 */
const SYNTHETIC_EPOCH = 'synthetic-epoch-2026-10-24';
const SYNTHETIC_SCOPE: ProjectionScope = {
  serverProfileId: 'synthetic-server-profile',
  dimension: 'minecraft:overworld',
  worldGenerationId: 'synthetic-world-generation-1',
  accountId: 'synthetic-account-1',
};

const packet = (name: string, params: Record<string, unknown>, direction: ProjectionDirection = 'downstream'): PacketEnvelope => ({ name, direction, phase: 'PLAY', params });

type SyntheticStep = { sequence: string; expectedKind: DomainFamily; packet: PacketEnvelope };

/** One ordered made-up stream covering position, blocks, inventory, chat and lifecycle. */
const SYNTHETIC_STREAM: readonly SyntheticStep[] = [
  { sequence: '1', expectedKind: 'lifecycle', packet: packet('join_game', { dimension: SYNTHETIC_SCOPE.dimension, entityId: 42, worldGenerationId: SYNTHETIC_SCOPE.worldGenerationId }) },
  { sequence: '2', expectedKind: 'position', packet: packet('position', { x: 1.5, y: 64, z: -3.25, yawDeg: 90, pitchDeg: 0, dimension: SYNTHETIC_SCOPE.dimension }) },
  { sequence: '3', expectedKind: 'blocks', packet: packet('block_change', { x: 1, y: 63, z: -4, block: 'minecraft:stone', stateId: 10 }) },
  { sequence: '4', expectedKind: 'inventory', packet: packet('window_items', { windowId: 0, stateId: 7, slots: [1, 2, 3] }) },
  { sequence: '5', expectedKind: 'inventory', packet: packet('held_slot', { slot: 2 }) },
  { sequence: '6', expectedKind: 'chat', packet: packet('chat_message', { message: 'synthetic hello', sender: 'fixture-bot' }) },
  { sequence: '7', expectedKind: 'lifecycle', packet: packet('game_mode', { mode: 'survival' }) },
];

const feed = (
  pipeline: DomainProjectionPipeline,
  sequence: string,
  envelope: PacketEnvelope,
  epoch = SYNTHETIC_EPOCH,
  scope: ProjectionScope = SYNTHETIC_SCOPE,
) => pipeline.project({ epoch, direction: envelope.direction, sequence, packet: envelope, scope });

const accept = (
  pipeline: DomainProjectionPipeline,
  consumer: SyntheticConsumerState,
  sequence: string,
  envelope: PacketEnvelope,
  epoch = SYNTHETIC_EPOCH,
  scope: ProjectionScope = SYNTHETIC_SCOPE,
): DomainProjection => {
  const result = feed(pipeline, sequence, envelope, epoch, scope);
  expect(result.accepted, `${envelope.name}@${sequence} should be accepted`).toBe(true);
  if (!result.accepted) throw new Error('unreachable: accepted assertion failed');
  consumer.apply(result.projection);
  return result.projection;
};

const asRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`synthetic-consumer-malformed-${field}`);
  return value as Record<string, unknown>;
};
const finite = (value: unknown, field: string): number => {
  if (!isFiniteNumber(value)) throw new Error(`synthetic-consumer-malformed-${field}`);
  return value;
};
const optionalFinite = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined) return null;
  return finite(value, field);
};
const requiredString = (value: unknown, field: string): string => {
  if (!isString(value)) throw new Error(`synthetic-consumer-malformed-${field}`);
  return value;
};
const optionalString = (value: unknown, field: string): string | null => {
  if (value === null || value === undefined) return null;
  return requiredString(value, field);
};
const requiredArray = (value: unknown, field: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`synthetic-consumer-malformed-${field}`);
  return value;
};
const normalizedAccount = (scope: ProjectionScope): string | undefined => (scope.accountId === undefined || scope.accountId.length === 0 ? undefined : scope.accountId);
const sameScope = (left: ProjectionScope, right: ProjectionScope): boolean =>
  left.serverProfileId === right.serverProfileId
  && left.dimension === right.dimension
  && left.worldGenerationId === right.worldGenerationId
  && normalizedAccount(left) === normalizedAccount(right);

type ObservedPosition = {
  x: number; y: number; z: number;
  yawDeg: number | null; pitchDeg: number | null;
  dimension: string | null;
  sequence: string;
  provenance: Provenance;
};
type ObservedBlock = {
  cell: string; x: number; y: number; z: number;
  block: string; stateId: number | null;
  sequence: string;
  provenance: Provenance;
};
type InventoryFields = { windowId: number | null; stateId: number | null; slots: unknown[]; heldSlot: number | null; uiMode: string | null };
type ObservedInventory = InventoryFields & { sequence: string; provenance: Provenance };
type ObservedChat = { message: string; sender: string | null; level: string | null; sequence: string; provenance: Provenance };
type LifecycleFields = {
  event: string | null; dimension: string | null; entityId: number | null; worldGenerationId: string | null;
  cause: string | null; reason: string | null; mode: string | null; protocolVersion: number | null; nextState: number | null;
};
type ObservedLifecycle = LifecycleFields & { sequence: string; provenance: Provenance };
type AppliedRecord = { kind: DomainFamily; packet: string; sequence: string; sessionEpoch: string; scope: ProjectionScope; provenance: Provenance };

const EMPTY_INVENTORY: InventoryFields = { windowId: null, stateId: null, slots: [], heldSlot: null, uiMode: null };
const EMPTY_LIFECYCLE: LifecycleFields = { event: null, dimension: null, entityId: null, worldGenerationId: null, cause: null, reason: null, mode: null, protocolVersion: null, nextState: null };

/**
 * TEST-ONLY projection consumer. It keeps scope, revision and provenance exactly as the
 * pipeline projected them and refuses anything that is not labelled synthetic assembly.
 * This is not the production WorldState adapter and must not be presented as one.
 */
class SyntheticConsumerState {
  private boundScope?: ProjectionScope;
  private boundEpoch?: string;
  private revisionValue = 0;
  private readonly lastSequences = new Map<ProjectionDirection, bigint>();
  private readonly records: AppliedRecord[] = [];
  private positionState?: ObservedPosition;
  private readonly blockCells = new Map<string, ObservedBlock>();
  private inventoryState?: ObservedInventory;
  private readonly chatMessages: ObservedChat[] = [];
  private lifecycleState?: ObservedLifecycle;

  get revision(): number { return this.revisionValue; }

  apply(projection: DomainProjection): void {
    // Fail closed on any provenance that would promote synthetic assembly to real evidence.
    if (projection.source !== 'synthetic') throw new Error(`synthetic-consumer-refused-source:${projection.source}`);
    if (projection.provenance.source !== 'synthetic' || projection.provenance.release !== 'synthetic-fixture') {
      throw new Error(`synthetic-consumer-refused-provenance:${projection.provenance.source}/${projection.provenance.release}`);
    }
    if (projection.kind === 'unknown') throw new Error('synthetic-consumer-refused-unknown-kind');
    if (!projection.scope || typeof projection.scope !== 'object') throw new Error('synthetic-consumer-scope-required');
    if (!projection.sessionEpoch) throw new Error('synthetic-consumer-epoch-required');
    if (!/^\d+$/.test(projection.sequence)) throw new Error('synthetic-consumer-invalid-sequence');

    if (this.boundScope === undefined) this.boundScope = { ...projection.scope };
    else if (!sameScope(this.boundScope, projection.scope)) throw new Error(`synthetic-consumer-scope-mismatch:${projection.scope.serverProfileId}/${projection.scope.dimension}/${projection.scope.worldGenerationId}`);
    if (this.boundEpoch === undefined) this.boundEpoch = projection.sessionEpoch;
    else if (this.boundEpoch !== projection.sessionEpoch) throw new Error(`synthetic-consumer-epoch-mismatch:${projection.sessionEpoch}`);

    const sequence = BigInt(projection.sequence);
    const direction = projection.evidence.direction;
    const previousSequence = this.lastSequences.get(direction);
    if (previousSequence !== undefined && sequence <= previousSequence) throw new Error(`synthetic-consumer-stale-sequence:${direction}:${projection.sequence}`);

    switch (projection.kind) {
      case 'position': {
        const payload = projection.payload;
        const position = asRecord(payload.position, 'position');
        const orientation = asRecord(payload.orientation, 'orientation');
        this.positionState = {
          x: finite(position.x, 'position.x'),
          y: finite(position.y, 'position.y'),
          z: finite(position.z, 'position.z'),
          yawDeg: optionalFinite(orientation.yawDeg, 'orientation.yawDeg'),
          pitchDeg: optionalFinite(orientation.pitchDeg, 'orientation.pitchDeg'),
          dimension: optionalString(payload.dimension, 'position.dimension'),
          sequence: projection.sequence,
          provenance: { ...projection.provenance },
        };
        break;
      }
      case 'blocks': {
        if (projection.packet !== 'block_change') throw new Error(`synthetic-consumer-unsupported-blocks-packet:${projection.packet}`);
        const payload = projection.payload;
        const position = asRecord(payload.position, 'block.position');
        const x = finite(position.x, 'block.x');
        const y = finite(position.y, 'block.y');
        const z = finite(position.z, 'block.z');
        const cell = `${x},${y},${z}`;
        this.blockCells.set(cell, {
          cell, x, y, z,
          block: requiredString(payload.block, 'block.block'),
          stateId: optionalFinite(payload.stateId, 'block.stateId'),
          sequence: projection.sequence,
          provenance: { ...projection.provenance },
        });
        break;
      }
      case 'inventory': {
        const payload = projection.payload;
        const previous: InventoryFields = this.inventoryState ?? EMPTY_INVENTORY;
        if (projection.packet === 'ui_mode') {
          this.inventoryState = {
            ...previous,
            uiMode: requiredString(payload.uiMode, 'inventory.uiMode'),
            stateId: optionalFinite(payload.stateId, 'inventory.stateId'),
            sequence: projection.sequence,
            provenance: { ...projection.provenance },
          };
        } else if (projection.packet === 'held_slot') {
          this.inventoryState = {
            ...previous,
            heldSlot: finite(payload.heldSlot, 'inventory.heldSlot'),
            sequence: projection.sequence,
            provenance: { ...projection.provenance },
          };
        } else if (projection.packet === 'window_items' || projection.packet === 'inventory_update') {
          this.inventoryState = {
            ...previous,
            windowId: projection.packet === 'window_items' ? optionalFinite(payload.windowId, 'inventory.windowId') : previous.windowId,
            stateId: optionalFinite(payload.stateId, 'inventory.stateId'),
            slots: [...requiredArray(payload.slots, 'inventory.slots')],
            sequence: projection.sequence,
            provenance: { ...projection.provenance },
          };
        } else {
          throw new Error(`synthetic-consumer-unsupported-inventory-packet:${projection.packet}`);
        }
        break;
      }
      case 'chat': {
        const payload = projection.payload;
        this.chatMessages.push({
          message: requiredString(payload.message, 'chat.message'),
          sender: optionalString(payload.sender, 'chat.sender'),
          level: optionalString(payload.level, 'chat.level'),
          sequence: projection.sequence,
          provenance: { ...projection.provenance },
        });
        break;
      }
      case 'lifecycle': {
        const payload = projection.payload;
        const previous: LifecycleFields = this.lifecycleState ?? EMPTY_LIFECYCLE;
        if (projection.packet === 'game_mode') {
          this.lifecycleState = {
            ...previous,
            event: 'game_mode',
            mode: requiredString(payload.mode, 'lifecycle.mode'),
            sequence: projection.sequence,
            provenance: { ...projection.provenance },
          };
        } else if (projection.packet === 'set_protocol') {
          this.lifecycleState = {
            ...previous,
            event: 'set_protocol',
            protocolVersion: optionalFinite(payload.protocolVersion, 'lifecycle.protocolVersion'),
            nextState: optionalFinite(payload.nextState, 'lifecycle.nextState'),
            sequence: projection.sequence,
            provenance: { ...projection.provenance },
          };
        } else {
          this.lifecycleState = {
            ...previous,
            event: optionalString(payload.event, 'lifecycle.event') ?? previous.event,
            dimension: optionalString(payload.dimension, 'lifecycle.dimension') ?? previous.dimension,
            entityId: optionalFinite(payload.entityId, 'lifecycle.entityId') ?? previous.entityId,
            worldGenerationId: optionalString(payload.worldGenerationId, 'lifecycle.worldGenerationId') ?? previous.worldGenerationId,
            cause: optionalString(payload.cause, 'lifecycle.cause') ?? previous.cause,
            reason: optionalString(payload.reason, 'lifecycle.reason') ?? previous.reason,
            sequence: projection.sequence,
            provenance: { ...projection.provenance },
          };
        }
        break;
      }
      case 'entities':
        throw new Error('synthetic-consumer-unsupported-family:entities');
    }

    this.lastSequences.set(direction, sequence);
    this.revisionValue += 1;
    this.records.push({
      kind: projection.kind,
      packet: projection.packet,
      sequence: projection.sequence,
      sessionEpoch: projection.sessionEpoch,
      scope: { ...projection.scope },
      provenance: { ...projection.provenance },
    });
  }

  /** The state a read-only tool would observe, including the evidence labels. */
  toolView() {
    return structuredClone({
      epoch: this.boundEpoch ?? null,
      scope: this.boundScope === undefined ? null : { ...this.boundScope },
      revision: this.revisionValue,
      position: this.positionState ?? null,
      blocks: [...this.blockCells.values()].sort((left, right) => left.cell.localeCompare(right.cell)),
      inventory: this.inventoryState ?? null,
      chat: this.chatMessages,
      lifecycle: this.lifecycleState ?? null,
      evidence: {
        source: 'synthetic' as const,
        release: 'synthetic-fixture' as const,
        assemblyOnly: true as const,
        schemaIds: [...new Set(this.records.map(record => record.provenance.schemaId))].sort(),
      },
    });
  }

  applied(): AppliedRecord[] { return structuredClone(this.records); }
  provenanceSources(): string[] { return [...new Set(this.records.map(record => record.provenance.source))].sort(); }
  provenanceReleases(): string[] { return [...new Set(this.records.map(record => record.provenance.release))].sort(); }
}

describe('P08 synthetic observation-chain assembly (offline-only)', () => {
  it('feeds an ordered synthetic envelope stream through the pipeline into tool-visible consumer state', () => {
    const pipeline = new DomainProjectionPipeline({ projectors: createSyntheticProjectors() });
    pipeline.start(SYNTHETIC_EPOCH, {}, SYNTHETIC_SCOPE);
    const consumer = new SyntheticConsumerState();

    for (const step of SYNTHETIC_STREAM) {
      const projection = accept(pipeline, consumer, step.sequence, step.packet);
      expect(projection.kind).toBe(step.expectedKind);
      expect(projection.packet).toBe(step.packet.name);
      expect(projection.source).toBe('synthetic');
      expect(projection.provenance).toMatchObject({ source: 'synthetic', release: 'synthetic-fixture', adapterVersion: 'synthetic-fixture-v1' });
      expect(projection.provenance.schemaId).toMatch(/^synthetic\//);
      expect(projection.sessionEpoch).toBe(SYNTHETIC_EPOCH);
      expect(projection.sequence).toBe(step.sequence);
      expect(projection.scope).toEqual(SYNTHETIC_SCOPE);
      expect(projection.evidence).toEqual({ direction: 'downstream', phase: 'PLAY' });
      expect(projection.availability).toBe('observed');
    }

    const view = consumer.toolView();
    expect(view.epoch).toBe(SYNTHETIC_EPOCH);
    expect(view.scope).toEqual(SYNTHETIC_SCOPE);
    expect(view.revision).toBe(SYNTHETIC_STREAM.length);
    expect(view.position).toMatchObject({ x: 1.5, y: 64, z: -3.25, yawDeg: 90, pitchDeg: 0, dimension: SYNTHETIC_SCOPE.dimension, sequence: '2' });
    expect(view.blocks).toEqual([expect.objectContaining({ cell: '1,63,-4', block: 'minecraft:stone', stateId: 10, sequence: '3' })]);
    expect(view.inventory).toMatchObject({ windowId: 0, stateId: 7, slots: [1, 2, 3], heldSlot: 2, sequence: '5' });
    expect(view.chat).toEqual([expect.objectContaining({ message: 'synthetic hello', sender: 'fixture-bot', level: null, sequence: '6' })]);
    expect(view.lifecycle).toMatchObject({
      event: 'game_mode',
      mode: 'survival',
      dimension: SYNTHETIC_SCOPE.dimension,
      entityId: 42,
      worldGenerationId: SYNTHETIC_SCOPE.worldGenerationId,
      sequence: '7',
    });
    expect(view.evidence).toMatchObject({ source: 'synthetic', release: 'synthetic-fixture', assemblyOnly: true });
    expect(view.evidence.schemaIds).toEqual([
      'synthetic/blocks-v1',
      'synthetic/chat-v1',
      'synthetic/inventory-v1',
      'synthetic/lifecycle-v1',
      'synthetic/position-v1',
    ]);
    expect(consumer.provenanceSources()).toEqual(['synthetic']);
    expect(consumer.provenanceReleases()).toEqual(['synthetic-fixture']);
    expect(pipeline.state()).toMatchObject({
      epoch: SYNTHETIC_EPOCH,
      status: 'healthy',
      stickyUnknown: null,
      globalCause: null,
      degradedDomains: [],
      lastSequences: { downstream: '7', upstream: null },
    });
  });

  it('fences stale epochs and non-advancing sequences before the consumer sees them', () => {
    const pipeline = new DomainProjectionPipeline({ projectors: createSyntheticProjectors() });
    pipeline.start('synthetic-epoch-fenced', { downstream: '10' }, SYNTHETIC_SCOPE);
    const consumer = new SyntheticConsumerState();
    const position = (x: number) => packet('position', { x, y: 64, z: 0, yawDeg: 0, pitchDeg: 0 });

    expect(feed(pipeline, '10', position(1), 'synthetic-epoch-fenced')).toMatchObject({ accepted: false, reason: 'stale-sequence' });
    expect(feed(pipeline, '11', position(2), 'synthetic-epoch-old')).toMatchObject({ accepted: false, reason: 'stale-epoch' });
    expect(consumer.toolView()).toMatchObject({ revision: 0, position: null });

    const accepted = accept(pipeline, consumer, '11', position(3), 'synthetic-epoch-fenced');
    expect(accepted.sequence).toBe('11');

    expect(feed(pipeline, '11', position(4), 'synthetic-epoch-fenced')).toMatchObject({ accepted: false, reason: 'stale-sequence' });
    expect(consumer.toolView()).toMatchObject({ revision: 1, position: expect.objectContaining({ x: 3 }) });
  });

  it('holds a sequence gap sticky until an explicit current-epoch resync anchor', () => {
    const pipeline = new DomainProjectionPipeline({ projectors: createSyntheticProjectors() });
    pipeline.start('synthetic-epoch-resync', {}, SYNTHETIC_SCOPE);
    const consumer = new SyntheticConsumerState();
    const position = (x: number) => packet('position', { x, y: 64, z: 0, yawDeg: 0, pitchDeg: 0 });

    accept(pipeline, consumer, '1', position(1), 'synthetic-epoch-resync');
    expect(feed(pipeline, '3', position(2), 'synthetic-epoch-resync')).toMatchObject({ accepted: false, reason: 'sequence-gap' });
    expect(pipeline.stickyUnknown).toContain('sequence-gap:downstream');
    expect(consumer.toolView().revision).toBe(1);

    // An old/behind anchor and an old epoch must not clear the uncertainty.
    expect(pipeline.resync('synthetic-epoch-resync', '2')).toMatchObject({ accepted: false, reason: 'stale-resync-sequence' });
    expect(pipeline.stickyUnknown).toContain('sequence-gap:downstream');
    expect(() => pipeline.resync('synthetic-epoch-old', '3')).toThrow(/stale-epoch/);
    expect(feed(pipeline, '4', position(3), 'synthetic-epoch-resync')).toMatchObject({ accepted: false, reason: 'sticky-unknown' });
    expect(consumer.toolView().revision).toBe(1);

    // Re-anchoring at the exact sequence that opened the gap is the explicit recovery.
    expect(pipeline.resync('synthetic-epoch-resync', '3')).toEqual({ accepted: true });
    expect(pipeline.stickyUnknown).toBeUndefined();
    expect(accept(pipeline, consumer, '4', position(4), 'synthetic-epoch-resync').sequence).toBe('4');
    expect(consumer.toolView()).toMatchObject({ revision: 2, position: expect.objectContaining({ x: 4 }) });

    // Once the gap is anchored, the same anchor is a replay and is refused.
    expect(pipeline.resync('synthetic-epoch-resync', '3')).toMatchObject({ accepted: false, reason: 'stale-resync-sequence' });
    expect(pipeline.resync('synthetic-epoch-resync', 'not-a-sequence')).toMatchObject({ accepted: false, reason: 'invalid-resync-sequence' });
    expect(pipeline.resyncAll('synthetic-epoch-resync', { downstream: '6' })).toEqual({ accepted: true });
    expect(accept(pipeline, consumer, '7', position(5), 'synthetic-epoch-resync').sequence).toBe('7');
    expect(consumer.toolView().revision).toBe(3);
  });

  it('keeps a local domain rejection local while control loss stays sticky/global', () => {
    const pipeline = new DomainProjectionPipeline({ projectors: createSyntheticProjectors() });
    pipeline.start('synthetic-epoch-local', {}, SYNTHETIC_SCOPE);
    const consumer = new SyntheticConsumerState();

    accept(pipeline, consumer, '1', packet('position', { x: 1, y: 64, z: 0, yawDeg: 0, pitchDeg: 0 }), 'synthetic-epoch-local');

    const malformed = feed(pipeline, '2', packet('chunk_delta', { chunkX: 0, chunkZ: 0 }), 'synthetic-epoch-local');
    expect(malformed).toMatchObject({ accepted: false, reason: 'rejected-packet' });
    if (!malformed.accepted) expect(malformed.rejection).toMatchObject({ code: 'missing-required-field', field: 'sections' });
    expect(pipeline.stickyUnknown).toBeUndefined();
    expect(pipeline.globalCause).toBeUndefined();
    expect(pipeline.degradedDomains).toEqual(['blocks']);
    expect(pipeline.state().status).toBe('degraded');
    expect(consumer.toolView()).toMatchObject({ revision: 1, blocks: [] });

    // A classified non-control loss only degrades its domain; other domains keep flowing.
    accept(pipeline, consumer, '3', packet('chat_message', { message: 'local loss did not stop chat' }), 'synthetic-epoch-local');
    expect(consumer.toolView().chat).toHaveLength(1);

    // Losing a control observation is global and sticky: every later projection is withheld.
    pipeline.noteObservationDrop({ control: true, reason: 'queue-overflow' });
    expect(pipeline.stickyUnknown).toContain('observation-control-loss:queue-overflow');
    expect(pipeline.state().status).toBe('unknown');
    expect(feed(pipeline, '4', packet('position', { x: 9, y: 64, z: 9, yawDeg: 0, pitchDeg: 0 }), 'synthetic-epoch-local')).toMatchObject({ accepted: false, reason: 'sticky-unknown' });
    expect(consumer.toolView()).toMatchObject({
      revision: 2,
      position: expect.objectContaining({ x: 1 }),
      chat: [expect.objectContaining({ message: 'local loss did not stop chat' })],
    });
    expect(pipeline.state().lastSequences.downstream).toBe('3');
  });

  it('turns an unclassifiable control-family packet into global unknown', () => {
    const pipeline = new DomainProjectionPipeline({ projectors: createSyntheticProjectors() });
    pipeline.start('synthetic-epoch-control', {}, SYNTHETIC_SCOPE);
    const consumer = new SyntheticConsumerState();

    const control = feed(pipeline, '1', packet('join_game', {}), 'synthetic-epoch-control');
    expect(control).toMatchObject({ accepted: false, reason: 'rejected-packet' });
    if (!control.accepted) expect(control.rejection).toMatchObject({ code: 'missing-required-field', field: 'dimension' });
    expect(pipeline.stickyUnknown).toContain('control-unknown:join_game');
    expect(pipeline.state().status).toBe('unknown');
    expect(feed(pipeline, '2', packet('chat_message', { message: 'must not be applied' }), 'synthetic-epoch-control')).toMatchObject({ accepted: false, reason: 'sticky-unknown' });
    expect(consumer.toolView()).toMatchObject({ revision: 0, chat: [] });
  });

  it('rejects a differing scope without advancing the consumer or the fence', () => {
    const pipeline = new DomainProjectionPipeline({ projectors: createSyntheticProjectors() });
    pipeline.start('synthetic-epoch-scope', {}, SYNTHETIC_SCOPE);
    const consumer = new SyntheticConsumerState();
    const position = (x: number) => packet('position', { x, y: 64, z: 0, yawDeg: 0, pitchDeg: 0 });

    accept(pipeline, consumer, '1', position(1), 'synthetic-epoch-scope');
    expect(consumer.toolView()).toMatchObject({ revision: 1, position: expect.objectContaining({ x: 1 }), scope: SYNTHETIC_SCOPE });

    const mismatches: ProjectionScope[] = [
      { ...SYNTHETIC_SCOPE, dimension: 'minecraft:the_nether' },
      { ...SYNTHETIC_SCOPE, serverProfileId: 'another-profile' },
      { ...SYNTHETIC_SCOPE, worldGenerationId: 'another-world' },
      { ...SYNTHETIC_SCOPE, accountId: 'another-account' },
      { ...SYNTHETIC_SCOPE, accountId: undefined },
    ];
    for (const scope of mismatches) {
      expect(feed(pipeline, '2', position(2), 'synthetic-epoch-scope', scope)).toMatchObject({ accepted: false, reason: 'scope-mismatch' });
      expect(consumer.toolView()).toMatchObject({ revision: 1, position: expect.objectContaining({ x: 1 }), scope: SYNTHETIC_SCOPE });
      expect(pipeline.scope).toEqual(SYNTHETIC_SCOPE);
    }

    // A scope rejection must not consume the sequence: the next in-scope packet still applies.
    accept(pipeline, consumer, '2', position(3), 'synthetic-epoch-scope');
    expect(consumer.toolView()).toMatchObject({ revision: 2, position: expect.objectContaining({ x: 3 }) });
  });

  it('keeps every synthetic result explicitly labelled as assembly-only, never real 26.3/client evidence', () => {
    expect(realProjectionAvailability()).toEqual({
      release: '26.3',
      real26_3Projectors: 'unavailable',
      syntheticFixture: 'assembly-only',
      families: ['position', 'blocks', 'entities', 'inventory', 'chat', 'lifecycle'],
      reason: '26.3-codec-data-unavailable',
    });

    const pipeline = new DomainProjectionPipeline({ projectors: createSyntheticProjectors() });
    pipeline.start(SYNTHETIC_EPOCH, {}, SYNTHETIC_SCOPE);
    const consumer = new SyntheticConsumerState();
    const projections = SYNTHETIC_STREAM.map(step => accept(pipeline, consumer, step.sequence, step.packet));

    for (const projection of projections) {
      expect(projection.source).toBe('synthetic');
      expect(projection.provenance.source).toBe('synthetic');
      expect(projection.provenance.release).toBe('synthetic-fixture');
      expect(projection.provenance.adapterVersion).toBe('synthetic-fixture-v1');
      expect(projection.provenance.release).not.toMatch(/26\.3|client|live/i);
      expect(projection.provenance.adapterVersion).not.toMatch(/26\.3|client|live/i);
      expect(projection.provenance.schemaId).toMatch(/^synthetic\//);
    }

    const view = consumer.toolView();
    expect(view.evidence).toMatchObject({ source: 'synthetic', release: 'synthetic-fixture', assemblyOnly: true });
    expect(view.evidence.schemaIds.every(id => id.startsWith('synthetic/'))).toBe(true);
    expect(consumer.provenanceSources()).toEqual(['synthetic']);
    expect(consumer.provenanceReleases()).toEqual(['synthetic-fixture']);
    expect(consumer.applied()).toHaveLength(SYNTHETIC_STREAM.length);
    expect(consumer.applied().every(record => record.provenance.source === 'synthetic' && record.provenance.release === 'synthetic-fixture')).toBe(true);
    // The tool-visible view must not contain a real-server/client provenance label.
    expect(JSON.stringify(view)).not.toContain('observed-server');
    expect(JSON.stringify(view)).not.toMatch(/"(client|real)"/i);
  });

  it('test-only consumer refuses forged non-synthetic provenance instead of accepting it', () => {
    const pipeline = new DomainProjectionPipeline({ projectors: createSyntheticProjectors() });
    pipeline.start(SYNTHETIC_EPOCH, {}, SYNTHETIC_SCOPE);
    const result = feed(pipeline, '1', packet('chat_message', { message: 'synthetic' }));
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    const consumer = new SyntheticConsumerState();
    expect(() => consumer.apply({ ...result.projection, source: 'fixture' })).toThrow('synthetic-consumer-refused-source:fixture');
    expect(() => consumer.apply({ ...result.projection, provenance: { ...result.projection.provenance, source: 'fixture' } })).toThrow('synthetic-consumer-refused-provenance:fixture/synthetic-fixture');
    expect(consumer.revision).toBe(0);
  });
});
