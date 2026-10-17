import type { FakeClientBridge } from '../bridge/fake/index.js';
import type { Lease, Progress } from '../execution/runtime.js';
import { navigate } from './navigation.js';

export type SkillContext = { bridge: FakeClientBridge; lease: Lease; report: (progress: Omit<Progress, 'at'>) => void; isCanceled?: () => boolean };
export type SkillResult = { ok: boolean; outcome: 'confirmed' | 'ambiguous' | 'failed' | 'canceled'; value?: unknown; reason?: string };
const canceled = (ctx: SkillContext) => { if (ctx.isCanceled?.()) return true; return false; };

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
  ctx.report({ stage: 'dispatch', completed: 0, total: 1 });
  try {
    ctx.bridge.setUi('chat');
    ctx.report({ stage: 'verify', completed: 1, total: 1 });
    ctx.bridge.setUi('gameplay');
    return { ok: true, outcome: 'confirmed', value: { sent: true, text } };
  } catch (error) { return { ok: false, outcome: 'ambiguous', reason: error instanceof Error ? error.message : String(error) }; }
}

export function placeOne(ctx: SkillContext, target: { x: number; y: number }): SkillResult {
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  if (ctx.bridge.inventory < 1) return { ok: false, outcome: 'failed', reason: 'empty-inventory' };
  if (ctx.bridge.cell(target.x, target.y) !== 'free') return { ok: false, outcome: 'failed', reason: 'target-not-free' };
  ctx.report({ stage: 'dispatch', completed: 0, total: 1 });
  try {
    const receipt = ctx.bridge.place(target.x, target.y);
    ctx.report({ stage: 'verify', completed: 1, total: 1 });
    return { ok: true, outcome: receipt.accepted ? 'confirmed' : 'ambiguous', value: receipt };
  } catch (error) { return { ok: false, outcome: 'ambiguous', reason: error instanceof Error ? error.message : String(error) }; }
}

export function waitForCondition(ctx: SkillContext, ms: number, wait: (ms: number) => boolean = () => true): SkillResult {
  if (!Number.isFinite(ms) || ms < 0) return { ok: false, outcome: 'failed', reason: 'invalid-wait' };
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  ctx.report({ stage: 'dispatch', completed: 0, total: ms });
  if (!wait(ms)) return { ok: false, outcome: 'failed', reason: 'condition-not-met' };
  if (canceled(ctx)) return { ok: false, outcome: 'canceled' };
  ctx.report({ stage: 'verify', completed: ms, total: ms });
  return { ok: true, outcome: 'confirmed', value: { waitedMs: ms } };
}

export const skillImplementations = { navigate_to: navigateTo, observe_ui: observeUi, send_chat: sendChat, place_one: placeOne, wait_for_condition: waitForCondition } as const;
