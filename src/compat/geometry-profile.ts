import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GeometryPhysicsPort } from './ports.js';

/** Axis-aligned box `[minX, minY, minZ, maxX, maxY, maxZ]`. */
export type GeometryBox = readonly [number, number, number, number, number, number];
export type GeometryShapeResult =
  | {
      status: 'known';
      boxes: ReadonlyArray<GeometryBox>;
      /** Rosegold inherits many 26.3 shapes by block name from older exports. */
      inherited: boolean;
      blockName: string;
      sourceVersion: string;
      evidenceRefs: string[];
    }
  | { status: 'unknown'; reason: string }
  | { status: 'unsupported'; reason: string; feature?: string };

export type GeometryFileLock = {
  /** Relative path in the upstream repository, e.g. `data/26.3/blockCollisionShapes.json`. */
  path: string;
  sha256: string;
  sourceVersion?: string;
  inherited?: boolean;
};
export type RosegoldGeometryLock = {
  commit?: string;
  sourceVersion?: string;
  /** One entry for blocks.json and one for blockCollisionShapes.json at minimum. */
  files: GeometryFileLock[];
};

export type RosegoldGeometryLoadResult =
  | { status: 'loaded'; profile: RosegoldGeometryProfile }
  | { status: 'failed'; error: string; details?: unknown };

/**
 * Blocks that cannot be represented by one static AABB per state. They are explicitly
 * unsupported rather than silently answered with a full cube.
 */
export const DEFAULT_CONTEXTUAL_BLOCKS: ReadonlySet<string> = new Set([
  'water', 'lava', 'bubble_column', 'powder_snow', 'moving_piston', 'scaffolding', 'vine',
]);

type BlockRecord = { name: string; minStateId: number; maxStateId: number; inherited: boolean; shapeRefs?: string[] };

export class RosegoldGeometryProfile {
  private readonly stateToBlock = new Map<number, string>();
  private readonly blocksByName = new Map<string, BlockRecord>();
  private readonly shapesById = new Map<string, ReadonlyArray<GeometryBox>>();
  private readonly contextual: ReadonlySet<string>;
  private readonly inheritedNames: ReadonlySet<string>;
  readonly sourceVersion: string;
  readonly commit?: string;
  readonly blockCount: number;
  readonly stateCount: number;
  readonly shapeCount: number;

  constructor(input: {
    blocks: BlockRecord[];
    shapes: Map<string, ReadonlyArray<GeometryBox>>;
    contextual: ReadonlySet<string>;
    inheritedNames: ReadonlySet<string>;
    sourceVersion: string;
    commit?: string;
  }) {
    this.sourceVersion = input.sourceVersion;
    this.commit = input.commit;
    this.contextual = input.contextual;
    this.inheritedNames = input.inheritedNames;
    this.shapesById = input.shapes;
    for (const block of input.blocks) {
      this.blocksByName.set(block.name, block);
      for (let state = block.minStateId; state <= block.maxStateId; state++) this.stateToBlock.set(state, block.name);
    }
    this.blockCount = input.blocks.length;
    this.stateCount = this.stateToBlock.size;
    this.shapeCount = input.shapes.size;
  }

  blockForState(stateId: number): string | undefined { return this.stateToBlock.get(stateId); }
  isInherited(blockName: string): boolean {
    const block = this.blocksByName.get(normalizeBlockName(blockName));
    return this.inheritedNames.has(normalizeBlockName(blockName)) || block?.inherited === true;
  }

  /**
   * Look up a static collision shape. Missing state/shape is `unknown`; contextual blocks and
   * unverified interaction shapes are `unsupported`. There is no full-cube fallback.
   */
  shape(input: { registryEpoch?: string; stateId: number; kind: 'collision' | 'interaction' }): GeometryShapeResult {
    if (!input || typeof input.stateId !== 'number' || !Number.isInteger(input.stateId) || input.stateId < 0) return { status: 'unknown', reason: 'invalid-state-id' };
    if (input.kind === 'interaction') return { status: 'unsupported', reason: 'interaction-shape-not-verified', feature: 'interaction-shape' };
    if (input.kind !== 'collision') return { status: 'unsupported', reason: 'unknown-shape-kind', feature: String(input.kind) };
    const blockName = this.stateToBlock.get(input.stateId);
    if (!blockName) return { status: 'unknown', reason: 'state-not-found' };
    const shortName = normalizeBlockName(blockName);
    if (this.contextual.has(shortName)) return { status: 'unsupported', reason: 'contextual-collision', feature: shortName };
    const block = this.blocksByName.get(blockName);
    const refs = shapeRefsForState(block, input.stateId);
    if (!refs || refs.length === 0) return { status: 'unknown', reason: 'shape-not-found' };
    const boxes: GeometryBox[] = [];
    const evidenceRefs: string[] = [];
    for (const ref of refs) {
      const shape = this.shapesById.get(ref);
      if (!shape) return { status: 'unknown', reason: `shape-reference-missing:${ref}` };
      boxes.push(...shape);
      evidenceRefs.push(`rosegold:${this.commit ?? 'unknown'}:${blockName}:${ref}`);
    }
    return {
      status: 'known', boxes, inherited: this.isInherited(blockName), blockName,
      sourceVersion: this.sourceVersion, evidenceRefs,
    };
  }

  /** GeometryPhysicsPort adapter. Identity is supplied by the caller's module reference. */
  asPort(ref: { id: string; version: string; digest: string }): GeometryPhysicsPort {
    return { ...ref, shape: input => this.shape(input) };
  }
}

function normalizeBlockName(name: string): string {
  return name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
}
function shapeRefsForState(block: BlockRecord | undefined, stateId: number): string[] | undefined {
  if (!block?.shapeRefs) return undefined;
  // A per-state array is state-specific when its length equals the state range.
  const length = block.maxStateId - block.minStateId + 1;
  if (block.shapeRefs.length === length && length > 1) return [block.shapeRefs[stateId - block.minStateId]!];
  return block.shapeRefs;
}

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

function bytesOf(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
}

function findLockFile(lock: RosegoldGeometryLock, basename: string): GeometryFileLock | undefined {
  return lock.files.find(file => file.path === basename || file.path.endsWith(`/${basename}`));
}

/**
 * Verify both hash-locked files *before* parsing either. A missing or mismatched file fails
 * closed; no partial profile is returned.
 */
export function loadRosegoldGeometryProfile(input: {
  files: Record<string, Uint8Array | string>;
  lock: RosegoldGeometryLock;
  contextualBlocks?: Iterable<string>;
  inheritedBlocks?: Iterable<string>;
}): RosegoldGeometryLoadResult {
  const blocksLock = findLockFile(input.lock, 'blocks.json');
  const shapesLock = findLockFile(input.lock, 'blockCollisionShapes.json');
  if (!blocksLock || !shapesLock) return { status: 'failed', error: 'geometry-lock-incomplete', details: { files: input.lock.files.map(file => file.path) } };
  const blocksBytes = input.files[blocksLock.path] ?? input.files['blocks.json'];
  const shapesBytes = input.files[shapesLock.path] ?? input.files['blockCollisionShapes.json'];
  if (!blocksBytes) return { status: 'failed', error: 'geometry-file-missing', details: { path: blocksLock.path } };
  if (!shapesBytes) return { status: 'failed', error: 'geometry-file-missing', details: { path: shapesLock.path } };
  const checks = [
    { file: blocksLock, bytes: bytesOf(blocksBytes) },
    { file: shapesLock, bytes: bytesOf(shapesBytes) },
  ];
  for (const check of checks) {
    if (!/^[a-f0-9]{64}$/.test(check.file.sha256)) return { status: 'failed', error: 'geometry-lock-invalid', details: { path: check.file.path } };
    const actual = hash(check.bytes);
    if (actual !== check.file.sha256) return { status: 'failed', error: 'geometry-integrity-failed', details: { path: check.file.path, expected: check.file.sha256, actual } };
  }
  let blocksJson: unknown; let shapesJson: unknown;
  try {
    blocksJson = JSON.parse(Buffer.from(checks[0]!.bytes).toString('utf8'));
    shapesJson = JSON.parse(Buffer.from(checks[1]!.bytes).toString('utf8'));
  } catch { return { status: 'failed', error: 'geometry-parse-failed' }; }
  const parsedBlocks = parseBlocks(blocksJson);
  if (typeof parsedBlocks === 'string') return { status: 'failed', error: 'geometry-blocks-invalid', details: parsedBlocks };
  const parsedShapes = parseShapes(shapesJson);
  if ('error' in parsedShapes) return { status: 'failed', error: 'geometry-shapes-invalid', details: parsedShapes.error };
  // The Rosegold collision file carries the block -> shape-id map. Merge it only when the
  // blocks file did not already provide per-block refs.
  for (const block of parsedBlocks) {
    if (block.shapeRefs === undefined) {
      const refs = parsedShapes.blockRefs.get(block.name) ?? parsedShapes.blockRefs.get(normalizeBlockName(block.name));
      if (refs) block.shapeRefs = refs;
    }
  }
  const contextual = new Set([...DEFAULT_CONTEXTUAL_BLOCKS].map(normalizeBlockName));
  for (const name of input.contextualBlocks ?? []) contextual.add(normalizeBlockName(name));
  const inheritedNames = new Set<string>();
  for (const name of input.inheritedBlocks ?? []) inheritedNames.add(normalizeBlockName(name));
  for (const block of parsedBlocks) if (block.inherited) inheritedNames.add(normalizeBlockName(block.name));
  return {
    status: 'loaded',
    profile: new RosegoldGeometryProfile({
      blocks: parsedBlocks,
      shapes: parsedShapes.shapes,
      contextual,
      inheritedNames,
      sourceVersion: input.lock.sourceVersion ?? blocksLock.sourceVersion ?? 'unknown',
      ...(input.lock.commit ? { commit: input.lock.commit } : {}),
    }),
  };
}

/** Directory variant: lock paths are resolved under `rootDir`; basename fallback is explicit. */
export function loadRosegoldGeometryProfileFromDirectory(input: {
  rootDir: string;
  lock: RosegoldGeometryLock;
  contextualBlocks?: Iterable<string>;
  inheritedBlocks?: Iterable<string>;
}): RosegoldGeometryLoadResult {
  const blocksLock = findLockFile(input.lock, 'blocks.json');
  const shapesLock = findLockFile(input.lock, 'blockCollisionShapes.json');
  if (!blocksLock || !shapesLock) return { status: 'failed', error: 'geometry-lock-incomplete' };
  const files: Record<string, Uint8Array> = {};
  for (const lock of [blocksLock, shapesLock]) {
    try { files[lock.path] = readFileSync(join(input.rootDir, lock.path)); }
    catch {
      try { files[lock.path] = readFileSync(join(input.rootDir, lock.path.split('/').pop()!)); }
      catch { return { status: 'failed', error: 'geometry-file-missing', details: { path: lock.path } }; }
    }
  }
  return loadRosegoldGeometryProfile({ files, lock: input.lock, ...(input.contextualBlocks ? { contextualBlocks: input.contextualBlocks } : {}), ...(input.inheritedBlocks ? { inheritedBlocks: input.inheritedBlocks } : {}) });
}

function parseBlocks(value: unknown): BlockRecord[] | string {
  const records: BlockRecord[] = [];
  const add = (name: unknown, record: Record<string, unknown>) => {
    if (typeof name !== 'string' || !name) return 'block-name-invalid';
    const min = record.minStateId ?? record.min_state_id ?? record.min;
    const max = record.maxStateId ?? record.max_state_id ?? record.max;
    if (typeof min !== 'number' || typeof max !== 'number' || !Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) return `block-state-range-invalid:${name}`;
    if (max > 1_000_000) return `block-state-range-too-large:${name}`;
    const rawShapes = record.shapes;
    const shapeRefs = Array.isArray(rawShapes) ? rawShapes.map(item => String(item)) : typeof rawShapes === 'string' || typeof rawShapes === 'number' ? [String(rawShapes)] : undefined;
    records.push({ name, minStateId: min, maxStateId: max, inherited: record.inherited === true, ...(shapeRefs ? { shapeRefs } : {}) });
    return undefined;
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') return 'block-entry-invalid';
      const record = item as Record<string, unknown>;
      const error = add(record.name ?? record.id, record);
      if (error) return error;
    }
  } else if (value && typeof value === 'object') {
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      if (!item || typeof item !== 'object') return `block-entry-invalid:${name}`;
      const error = add(name, item as Record<string, unknown>);
      if (error) return error;
    }
  } else return 'blocks-root-invalid';
  return records;
}

function parseShapes(value: unknown): { shapes: Map<string, ReadonlyArray<GeometryBox>>; blockRefs: Map<string, string[]> } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'shapes-root-invalid' };
  const root = value as Record<string, unknown>;
  const rawShapes = (root.shapes ?? (root.blocks ? {} : root)) as Record<string, unknown> | unknown[];
  const shapes = new Map<string, ReadonlyArray<GeometryBox>>();
  const readBoxes = (input: unknown): GeometryBox[] | string => {
    if (!Array.isArray(input)) return 'shape-not-array';
    const boxes: GeometryBox[] = [];
    for (const box of input) {
      if (!Array.isArray(box) || box.length !== 6 || box.some(item => typeof item !== 'number' || !Number.isFinite(item))) return 'shape-box-invalid';
      const [x1, y1, z1, x2, y2, z2] = box as number[];
      if (x1! > x2! || y1! > y2! || z1! > z2!) return 'shape-box-inverted';
      boxes.push([x1!, y1!, z1!, x2!, y2!, z2!] as const);
    }
    return boxes;
  };
  if (Array.isArray(rawShapes)) {
    for (let index = 0; index < rawShapes.length; index++) {
      const boxes = readBoxes(rawShapes[index]);
      if (typeof boxes === 'string') return { error: `shape-invalid:${index}:${boxes}` };
      shapes.set(String(index), boxes);
    }
  } else {
    for (const [id, input] of Object.entries(rawShapes as Record<string, unknown>)) {
      const boxes = readBoxes(input);
      if (typeof boxes === 'string') return { error: `shape-invalid:${id}:${boxes}` };
      shapes.set(id, boxes);
    }
  }
  const blockRefs = new Map<string, string[]>();
  if (root.blocks && typeof root.blocks === 'object' && !Array.isArray(root.blocks)) {
    for (const [name, input] of Object.entries(root.blocks as Record<string, unknown>)) {
      let refs: string[] | undefined;
      if (Array.isArray(input)) refs = input.map(item => String(item));
      else if (typeof input === 'number' || typeof input === 'string') refs = [String(input)];
      else if (input && typeof input === 'object') {
        const record = input as Record<string, unknown>;
        const raw = record.shapes ?? record.shape ?? record.id;
        if (Array.isArray(raw)) refs = raw.map(item => String(item));
        else if (typeof raw === 'number' || typeof raw === 'string') refs = [String(raw)];
      }
      if (refs) blockRefs.set(name, refs);
    }
  }
  return { shapes, blockRefs };
}
