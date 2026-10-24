import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import type { Lease, Progress } from '../execution/runtime.js';
import { navigate } from './navigation.js';

export type SkillContext = { bridge: ClientBridgeCapabilities; lease: Lease; report: (progress: Omit<Progress, 'at'>) => void; isCanceled?: () => boolean; clock?: import('../contracts/index.js').Clock };
export type SkillResult = { ok: boolean; outcome: 'confirmed' | 'partial' | 'ambiguous' | 'failed' | 'canceled'; value?: unknown; reason?: string };
const canceled = (ctx: SkillContext) => { if (ctx.isCanceled?.()) return true; return false; };
/** A receipt is evidence only when it is accepted, non-ambiguous, and carries a command id. */
const acceptedReceipt = (receipt: unknown): boolean => {
  if (!receipt || typeof receipt !== 'object') return false;
  const value = receipt as { accepted?: unknown; ambiguous?: unknown; commandId?: unknown };
  return value.accepted === true && value.ambiguous !== true && typeof value.commandId === 'string' && value.commandId.length > 0;
};

export function navigateTo(ctx: SkillContext, target: { x: number; y: number }, budget = 3): SkillResult {
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  ctx.report({ stage: 'dispatch', completed: 0, message: 'planning' });
  const result = navigate(ctx.bridge, target, budget);
  ctx.report({ stage: 'dispatch', completed: result.path.length, total: result.path.length, message: result.status });
  return result.status === 'succeeded' ? { ok: true, outcome: 'confirmed', value: result } : { ok: false, outcome: 'failed', reason: result.reason, value: result };
}

export function observeUi(ctx: SkillContext): SkillResult {
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  ctx.report({ stage: 'dispatch', completed: 0, total: 1 });
  const snapshot = ctx.bridge.snapshot();
  ctx.report({ stage: 'verify', completed: 1, total: 1 });
  return { ok: true, outcome: 'confirmed', value: snapshot };
}

export function sendChat(ctx: SkillContext, text: string): SkillResult {
  if (!text) return { ok: false, outcome: 'failed', reason: 'text-required' };
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  // Remember the mode the player was in so the UI is restored, not forced to gameplay.
  const previousUi = ctx.bridge.snapshot().ui;
  ctx.report({ stage: 'dispatch', completed: 0, total: 1 });
  let enteredChat = false;
  try {
    // Without a real dispatch path the text is never sent; switching the UI alone is not a send.
    if (!ctx.bridge.dispatchChat) return { ok: false, outcome: 'failed', reason: 'chat-dispatch-unavailable' };
    const receipt: { accepted: boolean; ambiguous?: boolean; commandId: string; seq: number; text?: string } = ctx.bridge.dispatchChat(text);
    enteredChat = true;
    ctx.report({ stage: 'verify', completed: 1, total: 1 });
    // Delivery acceptance is not world confirmation: only an explicit non-ambiguous receipt is confirmed.
    if (!acceptedReceipt(receipt)) return { ok: false, outcome: 'ambiguous', reason: 'chat-delivery-unconfirmed', value: receipt };
    return { ok: true, outcome: 'confirmed', value: receipt };
  } catch (error) { return { ok: false, outcome: 'ambiguous', reason: error instanceof Error ? error.message : String(error) }; }
  finally { if (enteredChat) { try { ctx.bridge.setUi(previousUi); } catch { /* preserve ambiguous result */ } } }
}

export function placeOne(ctx: SkillContext, target: { x: number; y: number }): SkillResult {
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  if (ctx.bridge.inventory < 1) return { ok: false, outcome: 'failed', reason: 'empty-inventory' };
  if (ctx.bridge.cell(target.x, target.y) !== 'free') return { ok: false, outcome: 'failed', reason: 'target-not-free' };
  ctx.report({ stage: 'dispatch', completed: 0, total: 1 });
  try {
    const receipt = ctx.bridge.place(target.x, target.y);
    ctx.report({ stage: 'verify', completed: 1, total: 1 });
    // The bridge receipt only proves acceptance/injection; the world effect is verified by the
    // target cell changing, otherwise the outcome stays ambiguous.
    if (!acceptedReceipt(receipt)) return { ok: false, outcome: 'ambiguous', reason: 'place-delivery-unconfirmed', value: receipt };
    const placed = ctx.bridge.cell(target.x, target.y) === 'blocked';
    return placed ? { ok: true, outcome: 'confirmed', value: receipt } : { ok: false, outcome: 'ambiguous', reason: 'target-not-observed-blocked', value: receipt };
  } catch (error) { return { ok: false, outcome: 'ambiguous', reason: error instanceof Error ? error.message : String(error) }; }
}

export function waitForCondition(ctx: SkillContext, ms: number, wait?: (ms: number) => boolean | Promise<boolean>): SkillResult | Promise<SkillResult> {
  if (!Number.isFinite(ms) || ms < 0) return { ok: false, outcome: 'failed', reason: 'invalid-wait' };
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  ctx.report({ stage: 'dispatch', completed: 0, total: ms });
  // With an injected clock the wait must span the requested deadline; resolve it asynchronously
  // instead of pretending the condition was met immediately.
  if (!wait && ctx.clock) {
    return new Promise<SkillResult>(resolve => {
      const timer = ctx.clock!.schedule(ctx.clock!.now() + ms, () => {
        if (canceled(ctx)) { resolve({ ok: false, outcome: 'canceled' }); return; }
        ctx.report({ stage: 'verify', completed: ms, total: ms });
        resolve({ ok: true, outcome: 'confirmed', value: { waitedMs: ms } });
      });
      void timer;
    });
  }
  const met = wait ? wait(ms) : true;
  if (met instanceof Promise) {
    return met.then(result => result
      ? finishWait(ctx, ms)
      : ({ ok: false, outcome: 'failed', reason: 'condition-not-met' } as SkillResult));
  }
  if (!met) return { ok: false, outcome: 'failed', reason: 'condition-not-met' };
  return finishWait(ctx, ms);
}
function finishWait(ctx: SkillContext, ms: number): SkillResult {
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  ctx.report({ stage: 'verify', completed: ms, total: ms });
  return { ok: true, outcome: 'confirmed', value: { waitedMs: ms } };
}

export function lookAt(ctx: SkillContext, target: { x: number; y: number }): SkillResult {
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  if (!ctx.bridge.lookAt) return { ok: false, outcome: 'failed', reason: `orientation-unavailable:${target.x},${target.y}` };
  ctx.report({ stage: 'dispatch', completed: 0, total: 1 });
  try {
    const result = ctx.bridge.lookAt(target.x, target.y);
    ctx.report({ stage: 'verify', completed: 1, total: 1 });
    return { ok: result.accepted, outcome: result.accepted ? 'confirmed' : 'ambiguous', value: result };
  } catch (error) { return { ok: false, outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }; }
}
export function exploreArea(ctx: SkillContext, radius: number): SkillResult {
  if (!Number.isInteger(radius) || radius < 0 || radius > 32) return { ok: false, outcome: 'failed', reason: 'invalid-radius' };
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  const snapshot = ctx.bridge.snapshot();
  ctx.report({ stage: 'dispatch', completed: 1, total: 1, message: 'observed-local-area' });
  return { ok: true, outcome: 'confirmed', value: { radius, position: snapshot.position, observed: Object.keys(snapshot.cells).length, source: snapshot.source } };
}
export function digOne(ctx: SkillContext, target: { x: number; y: number }): SkillResult {
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  if (ctx.bridge.cell(target.x, target.y) !== 'blocked') return { ok: false, outcome: 'failed', reason: 'target-not-observed-blocked' };
  if (!ctx.bridge.dig) return { ok: false, outcome: 'failed', reason: 'dig-capability-unavailable' };
  ctx.report({ stage: 'dispatch', completed: 0, total: 1 });
  try {
    const result = ctx.bridge.dig(target.x, target.y);
    ctx.report({ stage: 'verify', completed: 1, total: 1 });
    if (!acceptedReceipt(result)) return { ok: false, outcome: 'ambiguous', value: result, reason: 'dig-delivery-unconfirmed' };
    // Only an observed free cell proves the dig; unknown is not cleared.
    const cleared = ctx.bridge.cell(target.x, target.y) === 'free';
    return cleared ? { ok: true, outcome: 'confirmed', value: result } : { ok: false, outcome: 'ambiguous', value: result, reason: 'target-not-observed-free' };
  } catch (error) { return { ok: false, outcome: 'ambiguous', reason: error instanceof Error ? error.message : String(error) }; }
}
export function collectNearby(ctx: SkillContext): SkillResult {
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  if (!ctx.bridge.collectNearby) return { ok: false, outcome: 'failed', reason: 'collection-capability-unavailable' };
  const inventoryBefore = ctx.bridge.inventory;
  ctx.report({ stage: 'dispatch', completed: 0, total: 1 });
  try {
    const result = ctx.bridge.collectNearby();
    const inventoryAfter = ctx.bridge.inventory;
    ctx.report({ stage: 'verify', completed: 1, total: 1 });
    if (!acceptedReceipt(result)) return { ok: false, outcome: 'ambiguous', reason: 'collection-delivery-unconfirmed', value: result };
    // A disappeared entity is not proof that this body picked it up. Require a positive
    // collected count, per-item evidence, and an inventory delta that accounts for it.
    const collected = Number(result.collected);
    if (!Number.isInteger(collected) || collected <= 0) return { ok: false, outcome: 'partial', reason: 'no-entities-observed', value: result };
    if (!Array.isArray(result.items) || result.items.length !== collected) return { ok: false, outcome: 'ambiguous', reason: 'collection-items-unverified', value: result };
    if (inventoryAfter - inventoryBefore < collected) return { ok: false, outcome: 'ambiguous', reason: 'inventory-delta-unconfirmed', value: result };
    return { ok: true, outcome: 'confirmed', value: result };
  } catch (error) { return { ok: false, outcome: 'failed', reason: error instanceof Error ? error.message : String(error) }; }
}
export function gatherBlocks(ctx: SkillContext, block: string, count = 1): SkillResult {
  if (!block) return { ok: false, outcome: 'failed', reason: 'block-required' };
  if (!Number.isInteger(count) || count < 1 || count > 16) return { ok: false, outcome: 'failed', reason: 'invalid-gather-count' };
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  if (!ctx.bridge.digBlock || !ctx.bridge.adjacentBlock) return { ok: false, outcome: 'failed', reason: 'gather-capability-unavailable' };
  ctx.report({ stage: 'dispatch', completed: 0, total: count });
  let gathered = 0;
  let consecutiveFailures = 0;
  const inventoryBefore = ctx.bridge.inventory;
  for (let index = 0; index < count; index++) {
    if (canceled(ctx)) return { ok: false, outcome: 'canceled', value: { gathered, requested: count } };
    const target = ctx.bridge.adjacentBlock(block);
    if (!target) {
      if (gathered > 0) break;
      return { ok: false, outcome: 'failed', reason: `no-adjacent-block:${block}` };
    }
    const wasBlocked = ctx.bridge.cell(target.x, target.y) === 'blocked';
    if (!wasBlocked) { consecutiveFailures++; if (consecutiveFailures >= 3) return { ok: false, outcome: 'failed', reason: 'gather-budget-exhausted', value: { gathered, requested: count } }; continue; }
    try {
      const result = ctx.bridge.digBlock(target.x, target.y, block);
      const cleared = ctx.bridge.cell(target.x, target.y) === 'free';
      // A free cell alone is not causal evidence. The receipt must identify an accepted command;
      // the pre-state must have been observed blocked; the post-state must be observed free.
      if (!acceptedReceipt(result) || !cleared) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) return { ok: false, outcome: 'failed', reason: 'gather-budget-exhausted', value: { gathered, requested: count } };
        continue;
      }
      gathered++;
      ctx.report({ stage: 'verify', completed: gathered, total: count });
    } catch (error) {
      consecutiveFailures++;
      if (consecutiveFailures >= 3) return { ok: false, outcome: 'ambiguous', reason: 'gather-budget-exhausted', value: { gathered, requested: count, error: error instanceof Error ? error.message : String(error) } };
    }
  }
  if (gathered === count) {
    // The inventory delta is secondary evidence that the material reached this body.
    const delta = ctx.bridge.inventory - inventoryBefore;
    if (delta < gathered) return { ok: false, outcome: 'ambiguous', reason: 'inventory-delta-unconfirmed', value: { gathered, requested: count } };
    return { ok: true, outcome: 'confirmed', value: { gathered, requested: count } };
  }
  if (gathered > 0) return { ok: false, outcome: 'partial', reason: 'gather-count-incomplete', value: { gathered, requested: count } };
  return { ok: false, outcome: 'failed', reason: 'gather-count-unmet', value: { gathered, requested: count } };
}
export function returnToPlace(ctx: SkillContext, placeId: string, budget = 3): SkillResult {
  if (!placeId) return { ok: false, outcome: 'failed', reason: 'place-required' };
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  if (!ctx.bridge.findPlace) return { ok: false, outcome: 'failed', reason: 'place-navigation-capability-unavailable' };
  const target = ctx.bridge.findPlace(placeId);
  if (!target) return { ok: false, outcome: 'failed', reason: `unknown-place:${placeId}` };
  return navigateTo(ctx, target, budget);
}

export const skillImplementations = { navigate_to: navigateTo, observe_ui: observeUi, send_chat: sendChat, place_one: placeOne, wait_for_condition: waitForCondition, look_at: lookAt, explore_area: exploreArea, dig_one: digOne, collect_nearby: collectNearby, gather_blocks: gatherBlocks, return_to_place: returnToPlace } as const;
