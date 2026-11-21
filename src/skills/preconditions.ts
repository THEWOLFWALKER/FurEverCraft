import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import type { BodyPort } from '../motor/contracts.js';
import type { SkillManifest } from './registry.js';

/**
 * Pure prerequisite evaluation (FEC-36).
 *
 * This module deliberately has no asynchronous observation path: it never calls
 * `body.observe()`, a bridge RPC or the network. It derives what it can from
 * already-available capabilities, arguments and caller-supplied facts. Anything
 * that would need a fresh observation is `unknown`, and unknown is never
 * treated as satisfied by `SkillLifecycle`.
 *
 * The router will consume this API later; the shape is stable:
 *   evaluatePreconditions(manifest, facts) -> PreconditionResult
 */
export type PreconditionStatus = 'satisfied' | 'unsatisfied' | 'unknown';

export type PreconditionEvaluation = {
  name: string;
  status: PreconditionStatus;
  /** Short machine-readable explanation, never a secret or raw payload. */
  reason?: string;
  /** Where the fact came from (explicit observation, body, bridge, args). */
  source?: 'observation' | 'body' | 'bridge' | 'arguments' | 'place-resolution' | 'none';
};

export type PreconditionResult = {
  manifestId: string;
  evaluations: PreconditionEvaluation[];
  satisfied: string[];
  unsatisfied: string[];
  unknown: string[];
  /** Prerequisites that are not positively satisfied (lifecycle-compatible). */
  missing: string[];
  /** Lifecycle-compatible map: satisfied=true, unsatisfied=false, unknown omitted. */
  observed: Record<string, boolean | undefined>;
  /** True only when every prerequisite is positively satisfied. */
  ok: boolean;
};

/**
 * Facts available without blocking. `observations` is authoritative when a
 * caller already has a fresh, non-blocking answer for a prerequisite name.
 */
export type PreconditionFacts = {
  readonly body?: BodyPort;
  readonly bridge?: Partial<ClientBridgeCapabilities>;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly observations?: Readonly<Record<string, boolean | undefined>>;
  /** Synchronous, scope-checked place lookup (no I/O). */
  readonly hasPlace?: (placeId: string) => boolean | undefined;
  /** Whether a usable clock exists; `undefined` means not yet known. */
  readonly clockAvailable?: boolean;
  /** Inventory count already projected without blocking. */
  readonly inventory?: number;
};

const satisfied = (name: string, reason: string, source: PreconditionEvaluation['source']): PreconditionEvaluation => ({ name, status: 'satisfied', reason, source });
const unsatisfied = (name: string, reason: string, source: PreconditionEvaluation['source']): PreconditionEvaluation => ({ name, status: 'unsatisfied', reason, source });
const unknown = (name: string, reason: string, source: PreconditionEvaluation['source'] = 'none'): PreconditionEvaluation => ({ name, status: 'unknown', reason, source });

const numberArg = (args: Readonly<Record<string, unknown>> | undefined, key: string): number | undefined => {
  const value = args?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

function inventoryFact(facts: PreconditionFacts): number | undefined {
  if (typeof facts.inventory === 'number' && Number.isFinite(facts.inventory)) return facts.inventory;
  if (typeof facts.body?.inventory === 'number' && Number.isFinite(facts.body.inventory)) return facts.body.inventory;
  if (typeof facts.bridge?.inventory === 'number' && Number.isFinite(facts.bridge.inventory)) return facts.bridge.inventory;
  return undefined;
}

function evaluateOne(name: string, facts: PreconditionFacts): PreconditionEvaluation {
  // An explicit non-blocking observation always wins, including "false".
  const explicit = facts.observations?.[name];
  if (explicit === true) return satisfied(name, 'observed-true', 'observation');
  if (explicit === false) return unsatisfied(name, 'observed-false', 'observation');

  const body = facts.body;
  const bridge = facts.bridge;
  const args = facts.args;
  switch (name) {
    case 'current-position': {
      if (body) {
        return body.capabilities.threeDimensional
          ? satisfied(name, '3d-body-context', 'body')
          : unsatisfied(name, 'body-not-3d', 'body');
      }
      // A planar bridge always has a position, but it is not a 3D pose.
      return bridge && typeof bridge.context === 'object' ? satisfied(name, 'planar-position', 'bridge') : unknown(name, 'no-body-position');
    }
    case 'ui-observation': {
      if (!bridge) return unknown(name, 'no-bridge');
      return typeof bridge.snapshot === 'function' ? satisfied(name, 'snapshot-capable', 'bridge') : unsatisfied(name, 'snapshot-unavailable', 'bridge');
    }
    case 'chat-ui': {
      if (!bridge) return unknown(name, 'no-bridge');
      return typeof bridge.dispatchChat === 'function' ? satisfied(name, 'chat-dispatch-capable', 'bridge') : unsatisfied(name, 'chat-dispatch-unavailable', 'bridge');
    }
    case 'free-target': {
      const x = numberArg(args, 'x');
      const y = numberArg(args, 'y');
      if (x === undefined || y === undefined || !bridge || typeof bridge.cell !== 'function') return unknown(name, 'target-or-cell-not-available', args ? 'arguments' : 'none');
      const cell = bridge.cell(x, y);
      if (cell === 'free') return satisfied(name, 'observed-free', 'bridge');
      if (cell === 'blocked') return unsatisfied(name, 'target-blocked', 'bridge');
      return unknown(name, 'target-unknown', 'bridge');
    }
    case 'inventory': {
      const inventory = inventoryFact(facts);
      if (inventory === undefined) return unknown(name, 'inventory-not-projected');
      return inventory > 0 ? satisfied(name, 'inventory-positive', typeof facts.inventory === 'number' ? 'observation' : body?.inventory !== undefined ? 'body' : 'bridge') : unsatisfied(name, 'inventory-empty', 'body');
    }
    case 'clock': {
      if (facts.clockAvailable === true) return satisfied(name, 'clock-available', 'observation');
      if (facts.clockAvailable === false) return unsatisfied(name, 'clock-unavailable', 'observation');
      return unknown(name, 'clock-not-evaluated');
    }
    case 'orientation': {
      if (body?.capabilities.turn) return satisfied(name, 'body-can-turn', 'body');
      if (typeof bridge?.lookAt === 'function') return satisfied(name, 'bridge-look-at', 'bridge');
      return body || bridge ? unsatisfied(name, 'orientation-capability-unavailable', body ? 'body' : 'bridge') : unknown(name, 'no-body');
    }
    case 'local-observation': {
      if (body) return body.capabilities.threeDimensional ? satisfied(name, '3d-observation-capable', 'body') : unsatisfied(name, 'body-not-3d', 'body');
      return typeof bridge?.snapshot === 'function' ? satisfied(name, 'snapshot-capable', 'bridge') : unknown(name, 'no-observation-source');
    }
    case 'reachable-target': {
      const x = numberArg(args, 'x');
      const y = numberArg(args, 'y');
      if (x === undefined || y === undefined) return unknown(name, 'target-not-supplied');
      if (bridge && typeof bridge.cell === 'function' && bridge.position) {
        const distance = Math.abs(x - bridge.position.x) + Math.abs(y - bridge.position.y);
        if (distance !== 1) return unsatisfied(name, 'target-not-adjacent', 'bridge');
        const cell = bridge.cell(x, y);
        if (cell === 'blocked') return satisfied(name, 'adjacent-blocked-target', 'bridge');
        if (cell === 'free') return unsatisfied(name, 'target-already-free', 'bridge');
        return unknown(name, 'target-unknown', 'bridge');
      }
      // A 3D body can reach a target only after a fresh observation; capability
      // presence alone is not adjacency evidence.
      return body ? unknown(name, 'requires-fresh-observation', 'body') : unknown(name, 'no-position-source');
    }
    case 'tool': {
      // No tool/inventory projection exists in this batch; guessing would be dishonest.
      return unknown(name, 'tool-state-not-projected');
    }
    case 'entity-observation': {
      if (!bridge) return unknown(name, 'no-bridge');
      return typeof bridge.collectNearby === 'function' ? satisfied(name, 'collection-capable', 'bridge') : unsatisfied(name, 'collection-unavailable', 'bridge');
    }
    case 'known-target': {
      const block = typeof args?.block === 'string' ? args.block : undefined;
      if (!block) return unknown(name, 'block-not-supplied');
      if (bridge && typeof bridge.adjacentBlock === 'function') {
        return bridge.adjacentBlock(block) ? satisfied(name, 'adjacent-block-known', 'bridge') : unsatisfied(name, 'no-adjacent-block', 'bridge');
      }
      // `body.findBlock` is asynchronous; calling it here would block evaluation.
      return unknown(name, 'requires-fresh-block-search', body ? 'body' : 'none');
    }
    case 'remembered-place': {
      const placeId = typeof args?.placeId === 'string' ? args.placeId : undefined;
      if (!placeId) return unknown(name, 'place-not-supplied');
      if (facts.hasPlace) {
        const present = facts.hasPlace(placeId);
        if (present === true) return satisfied(name, 'place-present', 'place-resolution');
        if (present === false) return unsatisfied(name, 'place-unknown', 'place-resolution');
        return unknown(name, 'place-lookup-unknown', 'place-resolution');
      }
      if (bridge && typeof bridge.findPlace === 'function') {
        return bridge.findPlace(placeId) ? satisfied(name, 'bridge-place-present', 'bridge') : unsatisfied(name, 'place-unknown', 'bridge');
      }
      return unknown(name, 'no-place-resolver');
    }
    default:
      return unknown(name, 'no-non-blocking-rule');
  }
}

/**
 * Evaluate every manifest prerequisite without blocking. Unknown is preserved
 * as unknown; it is never coerced to satisfied.
 */
export function evaluatePreconditions(manifest: SkillManifest, facts: PreconditionFacts = {}): PreconditionResult {
  const evaluations = manifest.prerequisites.map(name => evaluateOne(name, facts));
  const satisfiedNames = evaluations.filter(item => item.status === 'satisfied').map(item => item.name);
  const unsatisfiedNames = evaluations.filter(item => item.status === 'unsatisfied').map(item => item.name);
  const unknownNames = evaluations.filter(item => item.status === 'unknown').map(item => item.name);
  const observed: Record<string, boolean | undefined> = {};
  for (const item of evaluations) observed[item.name] = item.status === 'satisfied' ? true : item.status === 'unsatisfied' ? false : undefined;
  const missing = evaluations.filter(item => item.status !== 'satisfied').map(item => item.name);
  return {
    manifestId: manifest.id,
    evaluations,
    satisfied: satisfiedNames,
    unsatisfied: unsatisfiedNames,
    unknown: unknownNames,
    missing,
    observed,
    ok: missing.length === 0,
  };
}
