import { nextId } from '../contracts/index.js';
import type { SQLiteStore } from '../persistence/store.js';
import type { EventHub, Event } from '../diagnostics/events.js';
import { findSkill } from '../skills/registry.js';

export type TaskStatus = 'proposed' | 'ready' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'canceled';
export type TaskNode = { id: string; skill: string; args: Record<string, unknown>; dependsOn?: string[]; status?: TaskStatus };
export type GoalSpec = { goalId: string; text: string; revision: number; nodes: TaskNode[]; priority: number; budget: { maxNodes: number; used: number }; completion?: string };

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

export class GoalManager {
  constructor(private readonly store: SQLiteStore, private readonly events: EventHub) {}
  propose(input: { goalId?: string; text: string; nodes?: TaskNode[]; priority?: number; completion?: string }) {
    const goalId = input.goalId ?? nextId('goal'); const nodes = input.nodes ?? [];
    if (nodes.length > 32) throw new Error('task-budget-exceeded');
    const ids = new Set(nodes.map(node => node.id));
    if (ids.size !== nodes.length || nodes.some(node => (node.dependsOn ?? []).some(dep => !ids.has(dep) || dep === node.id))) throw new Error('invalid-task-dependencies');
    if (hasCycle(nodes)) throw new Error('cyclic-task-dependencies');
    if (nodes.some(node => !findSkill(node.skill))) throw new Error('unknown-task-skill');
    const goal: GoalSpec = { goalId, text: input.text, revision: 0, nodes, priority: input.priority ?? 0, budget: { maxNodes: 32, used: 0 }, completion: input.completion };
    this.store.saveGoal({ goalId, revision: 0, status: 'active', text: input.text, context: 'simulated' });
    this.events.publish('goal.proposed', goal, true); return goal;
  }
  revise(goalId: string, expectedRevision: number, text: string) { const result = this.store.reviseGoal(goalId, expectedRevision, text); this.events.publish('goal.revised', { goalId, revision: result?.revision }, true); return result; }
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
