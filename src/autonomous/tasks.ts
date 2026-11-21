import { nextId } from '../contracts/index.js';
import { canonicalScopeKey, resolveStableScope, type StableScope } from '../contracts/context.js';
import type { SQLiteStore } from '../persistence/store.js';
import type { EventHub, Event } from '../diagnostics/events.js';
import { findSkill } from '../skills/registry.js';

export type TaskStatus = 'proposed' | 'ready' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled';
export type TaskNode = { id: string; skill: string; args: Record<string, unknown>; dependsOn?: string[]; status?: TaskStatus };
export type GoalSpec = { goalId: string; text: string; revision: number; nodes: TaskNode[]; priority: number; budget: { maxNodes: number; used: number }; completion?: string };
export type GoalContextInput = { context?: unknown };

/** Detect a dependency cycle across task nodes; a cycle can never make progress. */
function hasCycle(nodes: TaskNode[]): boolean {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const mark = state.get(id) ?? 0;
    if (mark === 1) return true;
    if (mark === 2) return false;
    state.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn ?? []) if (visit(dep)) return true;
    state.set(id, 2);
    return false;
  };
  return nodes.some(node => visit(node.id));
}

/**
 * Resolve the current goal scope. The callback form is resolved on every call so a world or
 * account change cannot keep using a frozen scope (FEC-49). An unresolved identity has no key.
 */
export type GoalScopeResolution =
  | { status: 'resolved'; scope: StableScope; scopeKey: string }
  | { status: 'unresolved'; missing: string[] };
export function resolveGoalScope(value: unknown): GoalScopeResolution {
  let candidate = value;
  if (candidate && typeof candidate === 'object') {
    const record = candidate as Record<string, unknown>;
    if (record.status === 'resolved' && record.scope && typeof record.scope === 'object') candidate = record.scope;
    else if (record.status === 'unresolved') return { status: 'unresolved', missing: Array.isArray(record.missing) ? record.missing.map(String) : ['context'] };
    else if (record.context && typeof record.context === 'object') candidate = record.context;
  }
  const partial = (candidate && typeof candidate === 'object' ? candidate : {}) as Record<string, unknown>;
  const resolved = resolveStableScope({
    serverProfileId: typeof partial.serverProfileId === 'string' ? partial.serverProfileId : undefined,
    accountId: typeof partial.accountId === 'string' ? partial.accountId : undefined,
    worldGenerationId: typeof partial.worldGenerationId === 'string' ? partial.worldGenerationId : undefined,
    dimension: typeof partial.dimensionId === 'string' ? partial.dimensionId : typeof partial.dimension === 'string' ? partial.dimension : undefined,
  } as Record<string, unknown>);
  if (resolved.status === 'unresolved') return resolved;
  return { status: 'resolved', scope: resolved.scope, scopeKey: canonicalScopeKey(resolved.scope) };
}
export function goalScopeKey(scope: unknown): string | undefined {
  const resolution = resolveGoalScope(scope);
  return resolution.status === 'resolved' ? resolution.scopeKey : undefined;
}
export function createGoalScopeResolver(source: () => unknown): () => GoalScopeResolution {
  return () => resolveGoalScope(source());
}

export type ScopedGoalRow = {
  goalId?: string; goal_id?: string;
  scopeKey?: string | null; scope_key?: string | null;
  contextStatus?: string; context_status?: string;
  status?: string;
};
/** A goal may drive autonomy only when its durable scope is resolved and non-null. */
export function goalScopeInfo(goal: ScopedGoalRow): { resolved: boolean; scopeKey?: string; status?: string } {
  const scopeKey = goal.scopeKey ?? goal.scope_key ?? undefined;
  const contextStatus = goal.contextStatus ?? goal.context_status;
  return {
    resolved: contextStatus === 'resolved' && typeof scopeKey === 'string' && scopeKey.length > 0,
    ...(scopeKey ? { scopeKey } : {}),
    ...(goal.status ? { status: goal.status } : {}),
  };
}
/**
 * Wake selection: accept already-loaded goals and keep only active rows whose durable scope key
 * equals the current trusted scope. Unresolved scopes and legacy/null scope keys are rejected;
 * no other world's goal can be selected (FEC-50).
 */
export function selectScopedWakeGoals<T extends ScopedGoalRow>(goals: readonly T[], scope: unknown): T[] {
  const key = goalScopeKey(scope);
  if (!key) return [];
  return goals.filter(goal => {
    const info = goalScopeInfo(goal);
    return info.resolved && info.scopeKey === key && (goal.status === undefined || goal.status === 'active');
  });
}
/** Resolve from a live callback, then select. The callback is not cached across calls. */
export function createScopedGoalSelector<T extends ScopedGoalRow>(goalsSource: () => readonly T[], scopeSource: () => unknown) {
  return () => selectScopedWakeGoals(goalsSource(), scopeSource());
}

export class GoalManager {
  constructor(private readonly store: SQLiteStore, private readonly events: EventHub) {}
  propose(input: { goalId?: string; text: string; nodes?: TaskNode[]; priority?: number; completion?: string; context?: unknown }) {
    const goalId = input.goalId ?? nextId('goal'); const nodes = input.nodes ?? [];
    if (nodes.length > 32) throw new Error('task-budget-exceeded');
    const ids = new Set(nodes.map(node => node.id));
    if (ids.size !== nodes.length || nodes.some(node => (node.dependsOn ?? []).some(dep => !ids.has(dep) || dep === node.id))) throw new Error('invalid-task-dependencies');
    if (hasCycle(nodes)) throw new Error('cyclic-task-dependencies');
    if (nodes.some(node => !findSkill(node.skill))) throw new Error('unknown-task-skill');
    const goal: GoalSpec = { goalId, text: input.text, revision: 0, nodes, priority: input.priority ?? 0, budget: { maxNodes: 32, used: 0 }, completion: input.completion };
    // A scope is saved as provided; an unresolved/absent identity is persisted as unresolved and
    // therefore can never be selected by a scoped wake.
    this.store.saveGoal({ goalId, revision: 0, status: 'active', text: input.text, context: input.context ?? 'simulated' });
    this.events.publish('goal.proposed', goal, true); return goal;
  }
  revise(goalId: string, expectedRevision: number, text: string) { const result = this.store.reviseGoal(goalId, expectedRevision, text); this.events.publish('goal.revised', { goalId, revision: result?.revision }, true); return result; }
  /** Current-scope read. Unresolved identity returns no goals instead of all goals. */
  activeForScope(scope: unknown) {
    const key = goalScopeKey(scope);
    if (!key) return [];
    return this.store.listGoalsScoped(key, 'active').filter(goal => goal.context_status === 'resolved');
  }
}

export class TaskScheduler {
  private pending = new Set<string>(); private timer?: ReturnType<typeof setTimeout>; private running = false;
  private paused = false; private stopped = false; private planGeneration = 0;
  constructor(private readonly events: EventHub, private readonly onWake: (reason: string, generation: number) => Promise<void> | void, private readonly idleMs = 1000) {}
  get generation() { return this.planGeneration; }
  get pausedValue() { return this.paused; }
  get stoppedValue() { return this.stopped; }
  wake(reason: string) {
    if (this.paused || this.stopped) return false;
    this.pending.add(reason);
    if (this.running || this.timer) return true;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, this.idleMs);
    return true;
  }
  /** Selection helper exposed on the scheduler; unresolved scope rejects the wake entirely. */
  selectWakeGoals<T extends ScopedGoalRow>(goals: readonly T[], scope: unknown): T[] {
    return selectScopedWakeGoals(goals, scope);
  }
  /** Scoped wake: an unresolved scope cannot enqueue a plan. */
  wakeForScope(reason: string, scope: unknown): boolean {
    const resolution = resolveGoalScope(scope);
    if (resolution.status !== 'resolved') {
      this.events.publish('scheduler.scope-rejected', { reason, missing: resolution.missing }, false);
      return false;
    }
    return this.wake(reason);
  }
  /**
   * Human control interrupts the old plan: queued wakeups are dropped and the generation is
   * advanced so an in-flight wake cannot publish or reschedule as if it still owned the plan.
   */
  humanControl(reason = 'human-control') {
    this.planGeneration++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.events.publish('scheduler.interrupted', { reason, generation: this.planGeneration }, true);
    return this.planGeneration;
  }
  pause() { this.paused = true; return this.humanControl('pause'); }
  resume() { if (this.stopped) return false; this.paused = false; this.planGeneration++; return true; }
  async flush() {
    if (this.running || !this.pending.size || this.paused || this.stopped) return;
    this.running = true;
    const reasons = [...this.pending]; this.pending.clear();
    const generation = this.planGeneration;
    try {
      await this.onWake(reasons.join(','), generation);
      // A pause/cancel/stop that landed while the model was running invalidates this wake.
      if (generation !== this.planGeneration || this.paused || this.stopped) {
        this.events.publish('scheduler.stale-wake', { generation, current: this.planGeneration, reasons }, false);
        return;
      }
      this.events.publish('scheduler.woke', { reasons, generation }, false);
    } finally {
      this.running = false;
      if (this.pending.size && !this.paused && !this.stopped) this.wake('coalesced');
    }
  }
  observe(event: Event) { if (/goal|execution|effect|session|observation|error/.test(event.kind)) this.wake(event.kind); }
  close() { this.stopped = true; this.planGeneration++; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.pending.clear(); }
}
