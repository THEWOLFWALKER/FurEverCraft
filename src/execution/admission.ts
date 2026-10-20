import type { BodyContext } from '../contracts/index.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import type { SQLiteStore } from '../persistence/store.js';

/** Skills that submit input to the body. Read-only observation skills are not listed. */
export const INPUT_SKILLS: ReadonlySet<string> = new Set([
  'navigate_to', 'send_chat', 'place_one', 'look_at', 'dig_one', 'collect_nearby', 'gather_blocks', 'return_to_place',
]);

export type AdmissionCode =
  | 'goal-revision-conflict'
  | 'owner-mismatch'
  | 'epoch-changed'
  | 'capability-unavailable'
  | 'input-disabled'
  | 'aborted';
export type AdmissionDecision = { ok: true } | { ok: false; code: AdmissionCode; message: string };
export type AdmissionRequest = {
  skillId: string;
  goalId?: string;
  goalRevision?: number;
  owner?: string;
  context?: BodyContext;
  signal?: AbortSignal;
};

export const sameBodyContext = (left: BodyContext, right: BodyContext) =>
  left.serverProfileId === right.serverProfileId &&
  left.worldGenerationId === right.worldGenerationId &&
  left.connectionEpoch === right.connectionEpoch &&
  left.bodyEpoch === right.bodyEpoch &&
  left.dimension === right.dimension;

/** Missing capability of the concrete body for a skill, if any. */
export function missingSkillCapability(body: ClientBridgeCapabilities, skillId: string): string | undefined {
  switch (skillId) {
    case 'look_at': return body.lookAt ? undefined : 'orientation-unavailable';
    case 'dig_one': return body.dig ? undefined : 'dig-capability-unavailable';
    case 'gather_blocks': return body.digBlock && body.adjacentBlock ? undefined : 'gather-capability-unavailable';
    case 'collect_nearby': return body.collectNearby ? undefined : 'collection-capability-unavailable';
    case 'return_to_place': return body.findPlace ? undefined : 'place-navigation-capability-unavailable';
    case 'send_chat': return body.dispatchChat ? undefined : 'chat-dispatch-unavailable';
    case 'navigate_to': return typeof body.walk === 'function' ? undefined : 'movement-unavailable';
    case 'place_one': return typeof body.place === 'function' ? undefined : 'place-unavailable';
    default: return undefined;
  }
}

/**
 * Per-write admission gate. Every body-input skill must pass this before its effect is
 * prepared and again immediately before the may-have-dispatched barrier is crossed.
 */
export class ExecutionAdmission {
  constructor(
    private readonly store: SQLiteStore,
    private readonly body: ClientBridgeCapabilities,
    readonly ownerId: string,
    private readonly inputsEnabled: () => boolean,
  ) {}

  check(request: AdmissionRequest): AdmissionDecision {
    // Goal CAS: stale model output must not drive a write against a revised goal.
    if (request.goalId !== undefined) {
      const goal = this.store.getGoal(request.goalId);
      if (!goal) return { ok: false, code: 'goal-revision-conflict', message: `goal-not-found:${request.goalId}` };
      if (request.goalRevision !== undefined && goal.revision !== request.goalRevision) {
        return { ok: false, code: 'goal-revision-conflict', message: `goal-revision-conflict:${goal.revision}` };
      }
    }
    // Ownership fencing: a finalizer/runtime that no longer owns this session cannot dispatch.
    if (request.owner !== undefined && request.owner !== this.ownerId) {
      return { ok: false, code: 'owner-mismatch', message: `owner-mismatch:${request.owner}` };
    }
    // Connection/body/world epoch fencing against the context captured at admission.
    if (request.context && !sameBodyContext(request.context, this.body.context)) {
      return { ok: false, code: 'epoch-changed', message: 'connection-or-body-epoch-changed' };
    }
    const missing = missingSkillCapability(this.body, request.skillId);
    if (missing) return { ok: false, code: 'capability-unavailable', message: missing };
    if (INPUT_SKILLS.has(request.skillId) && !this.inputsEnabled()) {
      return { ok: false, code: 'input-disabled', message: 'input-disabled' };
    }
    if (request.signal?.aborted) return { ok: false, code: 'aborted', message: 'execution-aborted' };
    return { ok: true };
  }
}
