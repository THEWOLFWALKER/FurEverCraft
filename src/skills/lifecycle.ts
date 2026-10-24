import { nextId } from '../contracts/index.js';
import type { SkillResult } from './skills.js';
import { findSkill, missingPreconditions, type SkillLifecycleState, type SkillManifest } from './registry.js';

export type SkillProgress = { stage: 'prepare' | 'dispatch' | 'observe' | 'verify' | 'complete'; completed: number; total?: number; message?: string; at: number };
export type SkillRunSnapshot = {
  runId: string;
  skillId: string;
  version: string;
  state: SkillLifecycleState;
  outcome?: SkillResult['outcome'] | 'paused';
  reason?: string;
  progress: SkillProgress[];
  generation: number;
  writes: boolean;
  suspendable: boolean;
  value?: unknown;
  createdAt: number;
  updatedAt: number;
};
export type SkillLifecycleOptions = {
  preconditions?: Readonly<Record<string, boolean | undefined>>;
  /** Generation of the plan that requested this run. A human control action advances it. */
  generation?: number;
  now?: () => number;
};
export type SkillProgram = (signal: AbortSignal, report: (progress: Omit<SkillProgress, 'at'>) => void) => SkillResult | Promise<SkillResult>;

const terminal = new Set<SkillLifecycleState>(['succeeded', 'failed', 'canceled']);
const active = (state: SkillLifecycleState) => state === 'queued' || state === 'running' || state === 'verifying' || state === 'stopping';

/**
 * Bounded lifecycle wrapper for every skill. It owns pause/cancel/human-control fencing and
 * separate progress; the skill result is mapped, but a non-confirmed result is never upgraded.
 */
export class SkillLifecycle {
  private readonly runs = new Map<string, { snapshot: SkillRunSnapshot; manifest: SkillManifest; controller: AbortController; mode?: 'pause' | 'cancel' }>();
  private generation = 0;
  private readonly now: () => number;
  constructor(private readonly manifestFor: (id: string) => SkillManifest | undefined = findSkill, options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }
  get generationValue() { return this.generation; }
  list(): SkillRunSnapshot[] { return [...this.runs.values()].map(run => structuredClone(run.snapshot)); }
  snapshot(runId: string): SkillRunSnapshot | undefined { const run = this.runs.get(runId); return run ? structuredClone(run.snapshot) : undefined; }

  /** Every human control action interrupts old plans; later runs must use the new generation. */
  humanControl(reason = 'human-control'): SkillRunSnapshot[] {
    this.generation++;
    const interrupted: SkillRunSnapshot[] = [];
    for (const run of this.runs.values()) {
      if (!active(run.snapshot.state)) continue;
      run.mode = 'cancel';
      run.controller.abort();
      run.snapshot.state = 'canceled';
      run.snapshot.outcome = 'canceled';
      run.snapshot.reason = reason;
      run.snapshot.updatedAt = this.now();
      interrupted.push(structuredClone(run.snapshot));
    }
    return interrupted;
  }

  pause(runId: string): SkillRunSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run || !run.manifest.suspendable || terminal.has(run.snapshot.state) || run.snapshot.state === 'suspended') return run?.snapshot;
    run.mode = 'pause';
    run.controller.abort();
    run.snapshot.state = 'suspended';
    run.snapshot.outcome = 'paused';
    run.snapshot.reason = 'paused';
    run.snapshot.updatedAt = this.now();
    return structuredClone(run.snapshot);
  }

  /**
   * Resume moves a paused run back to queued for a fresh dispatch. The interrupted program is
   * never continued in place: the caller must call run() again with the returned generation.
   */
  resume(runId: string): SkillRunSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run || run.snapshot.state !== 'suspended' || run.snapshot.outcome !== 'paused') return run?.snapshot;
    this.generation++;
    run.snapshot.state = 'queued';
    run.snapshot.outcome = undefined;
    run.snapshot.reason = 'resume-queued';
    run.snapshot.generation = this.generation;
    run.snapshot.updatedAt = this.now();
    return structuredClone(run.snapshot);
  }

  cancel(runId: string, reason = 'canceled'): SkillRunSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run || terminal.has(run.snapshot.state)) return run?.snapshot;
    run.mode = 'cancel';
    run.controller.abort();
    run.snapshot.state = 'stopping';
    run.snapshot.reason = reason;
    run.snapshot.updatedAt = this.now();
    return structuredClone(run.snapshot);
  }

  async run(skillId: string, program: SkillProgram, options: SkillLifecycleOptions = {}): Promise<SkillRunSnapshot> {
    const manifest = this.manifestFor(skillId);
    const createdAt = this.now();
    const runId = nextId('skillrun');
    const base: SkillRunSnapshot = { runId, skillId, version: manifest?.version ?? '0.0.0', state: 'queued', progress: [], generation: options.generation ?? this.generation, writes: manifest?.writes ?? false, suspendable: manifest?.suspendable ?? false, createdAt, updatedAt: createdAt };
    const controller = new AbortController();
    const run = { snapshot: base, manifest: manifest ?? { id: skillId, version: '0.0.0', resources: [], cancellable: true, parameters: {}, prerequisites: [], progress: [], terminalOutcomes: [], cancellation: 'cooperative', writes: false, suspendable: false, evidence: [] }, controller, mode: undefined } as { snapshot: SkillRunSnapshot; manifest: SkillManifest; controller: AbortController; mode?: 'pause' | 'cancel' };
    this.runs.set(runId, run);
    if (!manifest) { base.state = 'failed'; base.reason = 'unknown-skill'; base.updatedAt = this.now(); return structuredClone(base); }
    if (options.generation !== undefined && options.generation !== this.generation) { base.state = 'failed'; base.reason = 'stale-generation'; base.updatedAt = this.now(); return structuredClone(base); }
    const missing = missingPreconditions(manifest, options.preconditions);
    if (missing.length) { base.state = 'failed'; base.reason = `precondition:${missing.join(',')}`; base.updatedAt = this.now(); return structuredClone(base); }
    base.state = 'running'; base.updatedAt = this.now();
    const report = (progress: Omit<SkillProgress, 'at'>) => {
      if (terminal.has(base.state) || base.state === 'suspended') return;
      run.snapshot.progress.push({ ...progress, at: this.now() });
      run.snapshot.updatedAt = this.now();
    };
    try {
      report({ stage: 'prepare', completed: 0, total: 1 });
      const result = await program(controller.signal, report);
      if (controller.signal.aborted) {
        const interrupted = run.mode === 'pause';
        base.state = interrupted ? 'suspended' : 'canceled';
        base.outcome = interrupted ? 'paused' : 'canceled';
        base.reason = interrupted ? 'paused' : 'canceled';
        base.updatedAt = this.now();
        return structuredClone(base);
      }
      base.state = 'verifying'; base.updatedAt = this.now();
      report({ stage: 'verify', completed: 1, total: 1 });
      base.outcome = result.outcome;
      base.value = result.value;
      base.reason = result.reason;
      // Partial/ambiguous work remains suspended for follow-up instead of being promoted to success.
      base.state = result.outcome === 'confirmed' ? 'succeeded' : result.outcome === 'failed' ? 'failed' : result.outcome === 'canceled' ? 'canceled' : 'suspended';
      if (result.outcome === 'partial' || result.outcome === 'ambiguous') base.reason ??= result.outcome;
      base.updatedAt = this.now();
      return structuredClone(base);
    } catch (error) {
      if (controller.signal.aborted) {
        base.state = run.mode === 'pause' ? 'suspended' : 'canceled';
        base.outcome = run.mode === 'pause' ? 'paused' : 'canceled';
        base.reason = run.mode === 'pause' ? 'paused' : 'canceled';
      } else {
        base.state = 'failed'; base.outcome = 'failed';
        base.reason = error instanceof Error ? error.message : String(error);
      }
      base.updatedAt = this.now();
      return structuredClone(base);
    }
  }
}
