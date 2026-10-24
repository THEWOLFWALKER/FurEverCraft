import { nextId, type Clock, type Execution, SystemClock } from '../contracts/index.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import type { SQLiteStore } from '../persistence/store.js';
import { findSkill, type SkillId } from '../skills/registry.js';
import { INPUT_SKILLS } from './admission.js';

export type Lease = { leaseId: string; owner: string; resources: string[]; until: number; generation: number; contextEpoch: string };
export type ExecutionStage = 'prepare' | 'dispatch' | 'verify' | 'complete';
export type Progress = { stage: ExecutionStage; completed: number; total?: number; message?: string; at: number };
export type ExecutorOptions = { clock?: Clock; leaseTtl?: number; watchdogTtl?: number; inputsEnabled?: () => boolean };
const executionTerminal = new Set(['succeeded', 'failed', 'canceled']);

export class InputArbiter {
  private leases = new Map<string, Lease>();
  private resourceGeneration = new Map<string, number>();
  private generation = 0;
  constructor(private readonly now: () => number = () => Date.now(), private readonly contextEpoch: () => string = () => '') {}
  acquire(owner: string, resources: string[], ttl = 1000): Lease {
    this.releaseExpired();
    const unique = [...new Set(resources)];
    for (const lease of this.leases.values()) {
      if (lease.resources.some(r => unique.includes(r))) throw new Error('resource-busy');
    }
    const lease = { leaseId: nextId('lease'), owner, resources: unique, until: this.now() + ttl, generation: ++this.generation, contextEpoch: this.contextEpoch() };
    this.leases.set(lease.leaseId, lease);
    return lease;
  }
  validate(leaseId: string, owner: string): Lease {
    const lease = this.leases.get(leaseId);
    // A reconnect to a different body/world invalidates every prior lease.
    if (!lease || lease.owner !== owner || lease.until <= this.now() || lease.contextEpoch !== this.contextEpoch() || lease.resources.some(r => (this.resourceGeneration.get(r) ?? 0) > lease.generation)) throw new Error('lease-invalid');
    return lease;
  }
  renew(leaseId: string, owner: string, ttl: number): Lease {
    const lease = this.validate(leaseId, owner);
    lease.until = this.now() + ttl;
    return lease;
  }
  /** Only the lease owner may release it; a stale finalizer must not drop a new owner's lease. */
  release(leaseId: string, owner?: string) { const lease = this.leases.get(leaseId); if (!lease) return; if (owner !== undefined && lease.owner !== owner) return; this.leases.delete(leaseId); }
  preempt(owner: string) {
    for (const [id, lease] of this.leases) {
      if (lease.owner !== owner) {
        this.leases.delete(id);
        for (const resource of lease.resources) this.resourceGeneration.set(resource, (this.resourceGeneration.get(resource) ?? 0) + 1);
      }
    }
  }
  private releaseExpired() { for (const [id, lease] of this.leases) if (lease.until <= this.now()) this.leases.delete(id); }
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]));
  return value;
};
const canonicalProposalHash = (value: unknown) => JSON.stringify(canonicalize(value));

export class Executor {
  private readonly clock: Clock;
  private readonly leaseTtl: number;
  private readonly watchdogTtl: number;
  private readonly inputsEnabled: () => boolean;
  private readonly progressByExecution = new Map<string, Progress>();
  private readonly active = new Map<string, { lease: Lease; watchdog?: string; canceled: boolean; controller: AbortController; token: symbol }>();

  constructor(
    private readonly bridge: ClientBridgeCapabilities,
    private readonly store: SQLiteStore,
    arbiter: InputArbiter | undefined = undefined,
    options: ExecutorOptions = {},
  ) {
    this.clock = options.clock ?? new SystemClock();
    this.arbiter = arbiter ?? new InputArbiter(() => this.clock.now());
    this.leaseTtl = options.leaseTtl ?? 1000;
    this.watchdogTtl = options.watchdogTtl ?? this.leaseTtl;
    this.inputsEnabled = options.inputsEnabled ?? (() => true);
  }

  private readonly arbiter: InputArbiter;

  resourcesFor(skillId: string): string[] {
    return findSkill(skillId)?.resources ?? (skillId === 'send_chat' ? ['ui', 'textEntry'] : ['movement', 'view', 'hands']);
  }

  async start(goalId: string, skillId: string, args: Record<string, unknown>, fn: (lease: Lease, report: (p: Omit<Progress, 'at'>) => void, signal: AbortSignal) => unknown | Promise<unknown>): Promise<Execution> {
    const proposalId = String(args.proposalId ?? nextId('proposal'));
    const proposalHash = canonicalProposalHash({ skillId, args });
    const existing = this.store.getExecution?.(proposalId);
    if (existing) {
      if (existing.proposalHash !== proposalHash) throw new Error('proposal-id-conflict');
      return existing as Execution;
    }
    const execution: Execution = { executionId: nextId('execution'), proposalId, proposalHash, goalId, skillId, skillVersion: findSkill(skillId)?.version ?? '1.0.0', status: 'queued' };
    // Input-disabled profiles must fail before any lease, effect or sink side effect exists.
    if (INPUT_SKILLS.has(skillId) && !this.inputsEnabled()) {
      execution.status = 'failed'; execution.reason = 'input-disabled';
      this.store.saveExecution(execution);
      return execution;
    }
    this.store.saveExecution(execution);
    let lease: Lease;
    try { lease = this.arbiter.acquire(execution.executionId, this.resourcesFor(skillId), this.leaseTtl); }
    catch (error) { execution.status = 'failed'; execution.reason = error instanceof Error ? error.message : String(error); this.store.saveExecution(execution); return execution; }
    const active: { lease: Lease; watchdog?: string; canceled: boolean; controller: AbortController; token: symbol } = { lease, canceled: false, controller: new AbortController(), token: Symbol(execution.executionId) };
    this.active.set(execution.executionId, active);
    const armWatchdog = () => {
      if (active.watchdog) this.clock.cancel(active.watchdog);
      active.watchdog = this.clock.schedule(this.clock.now() + this.watchdogTtl, () => {
        // Timeout must abort the in-flight work, not just flip a flag: the skill keeps
        // performing writes otherwise and the released lease could be re-acquired.
        // A timeout never overwrites an execution that already reached a terminal status.
        const persisted = this.store.getExecution(execution.executionId);
        if (executionTerminal.has(execution.status) || (persisted && executionTerminal.has(persisted.status))) return;
        if (this.active.get(execution.executionId)?.token === active.token) { active.canceled = true; active.controller.abort(); execution.status = 'failed'; execution.outcome = 'unknown'; execution.reason = 'watchdog-timeout'; this.store.saveExecution(execution); this.arbiter.release(lease.leaseId, execution.executionId); this.active.delete(execution.executionId); }
      });
    };
    const report = (p: Omit<Progress, 'at'>) => {
      this.assertLive(execution.executionId);
      // A progress report must not resurrect an execution the operator has asked to stop.
      if (execution.status !== 'stopping') execution.status = 'running';
      const progress = { ...p, at: this.clock.now() };
      this.progressByExecution.set(execution.executionId, progress);
      this.store.saveExecution({ ...execution, checkpoint: progress });
      // Progress renews the lease and resets the no-progress watchdog; long-running work is not failed for being slow.
      this.arbiter.renew(lease.leaseId, execution.executionId, this.leaseTtl);
      armWatchdog();
    };
    try {
      execution.status = 'running'; this.store.saveExecution(execution); report({ stage: 'prepare', completed: 0 });
      const skillResult = await fn(lease, report, active.controller.signal);
      // Only a closed set of outcomes may settle an execution; an absent or unknown outcome is
      // not success and must not be promoted to confirmed.
      const outcome = skillResult && typeof skillResult === 'object' && 'outcome' in skillResult ? String((skillResult as { outcome: string }).outcome) : 'ambiguous';
      const skillReason = skillResult && typeof skillResult === 'object' && typeof (skillResult as { reason?: unknown }).reason === 'string'
        ? String((skillResult as { reason: string }).reason) : undefined;
      if (outcome === 'canceled') throw new Error('execution-canceled');
      if (outcome === 'failed') throw new Error(String((skillResult as { reason?: string }).reason ?? 'skill-failed'));
      if (!['confirmed', 'partial', 'ambiguous'].includes(outcome)) execution.outcome = 'ambiguous';
      else execution.outcome = outcome;
      // Preserve why a non-confirmed result is suspended; otherwise the distinguishing
      // evidence (e.g. collection-not-observed) exists only in an ephemeral skill object.
      if (execution.reason === undefined && skillReason !== undefined) execution.reason = skillReason;
      this.assertLive(execution.executionId);
      execution.status = 'verifying'; this.store.saveExecution(execution); report({ stage: 'verify', completed: 1, total: 1 });
      if (execution.outcome === 'ambiguous' || execution.outcome === 'partial') {
        execution.status = 'suspended';
      } else if (execution.outcome === 'confirmed') {
        execution.status = 'succeeded';
      } else {
        // An unknown outcome is observable ambiguity, never a silent success.
        execution.status = 'suspended'; execution.outcome = 'ambiguous';
      }
    } catch (error) {
      if (execution.status === 'failed') { /* watchdog or external failure already recorded */ }
      else if (active.canceled || (error instanceof Error && error.message === 'execution-canceled')) { execution.status = 'canceled'; execution.reason = 'canceled'; }
      else { execution.status = 'failed'; execution.reason = error instanceof Error ? error.message : String(error); }
    } finally {
      if (active.watchdog) this.clock.cancel(active.watchdog);
      if (this.active.get(execution.executionId)?.token === active.token) {
        this.arbiter.release(lease.leaseId, execution.executionId); this.active.delete(execution.executionId); this.store.saveExecution(execution);
      }
    }
    return execution;
  }

  cancel(executionId: string) {
    const execution = this.store.getExecution(executionId);
    if (!execution || ['succeeded', 'failed', 'canceled'].includes(execution.status)) return execution;
    const active = this.active.get(executionId);
    if (!active) { this.store.updateExecutionStatus?.(executionId, 'canceled', 'cancel-requested-no-active-owner'); return this.store.getExecution(executionId); }
    active.canceled = true;
    active.controller.abort();
    this.store.updateExecutionStatus?.(executionId, 'stopping', 'cancel-requested');
    return this.store.getExecution(executionId);
  }
  progress(executionId: string) { return this.progressByExecution.get(executionId); }
  watchdog(executionId: string) { const execution = this.store.getExecution(executionId); if (execution && executionTerminal.has(execution.status)) return; const active = this.active.get(executionId); if (active) { active.canceled = true; active.controller.abort(); this.arbiter.release(active.lease.leaseId, executionId); this.active.delete(executionId); this.store.updateExecutionStatus?.(executionId, 'failed', 'watchdog-timeout', 'unknown'); } }
  /** Reconcile an effect result without ever promoting an unknown outcome to success. */
  reconcile(executionId: string, outcome: 'confirmed' | 'partial' | 'ambiguous') {
    const status = outcome === 'confirmed' ? 'succeeded' : outcome === 'partial' ? 'suspended' : 'failed';
    this.store.updateExecutionStatus?.(executionId, status, undefined, outcome);
    return outcome;
  }
  private assertLive(executionId: string) { const active = this.active.get(executionId); if (!active || active.canceled) throw new Error('execution-canceled'); this.arbiter.validate(active.lease.leaseId, executionId); }
}
