import { nextId, type Clock, type Execution, SystemClock } from '../contracts/index.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import type { SQLiteStore } from '../persistence/store.js';
import { findSkill, type SkillId } from '../skills/registry.js';

export type Lease = { leaseId: string; owner: string; resources: string[]; until: number; generation: number };
export type ExecutionStage = 'prepare' | 'dispatch' | 'verify' | 'complete';
export type Progress = { stage: ExecutionStage; completed: number; total?: number; message?: string; at: number };
export type ExecutorOptions = { clock?: Clock; leaseTtl?: number; watchdogTtl?: number };

export class InputArbiter {
  private leases = new Map<string, Lease>();
  private resourceGeneration = new Map<string, number>();
  private generation = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}
  acquire(owner: string, resources: string[], ttl = 1000): Lease {
    this.releaseExpired();
    const unique = [...new Set(resources)];
    for (const lease of this.leases.values()) {
      if (lease.resources.some(r => unique.includes(r))) throw new Error('resource-busy');
    }
    const lease = { leaseId: nextId('lease'), owner, resources: unique, until: this.now() + ttl, generation: ++this.generation };
    this.leases.set(lease.leaseId, lease);
    return lease;
  }
  validate(leaseId: string, owner: string): Lease {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.owner !== owner || lease.until <= this.now() || lease.resources.some(r => (this.resourceGeneration.get(r) ?? 0) > lease.generation)) throw new Error('lease-invalid');
    return lease;
  }
  renew(leaseId: string, owner: string, ttl: number): Lease {
    const lease = this.validate(leaseId, owner);
    lease.until = this.now() + ttl;
    return lease;
  }
  release(leaseId: string) { this.leases.delete(leaseId); }
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
    this.store.saveExecution(execution);
    let lease: Lease;
    try { lease = this.arbiter.acquire(execution.executionId, this.resourcesFor(skillId), this.leaseTtl); }
    catch (error) { execution.status = 'failed'; execution.reason = error instanceof Error ? error.message : String(error); this.store.saveExecution(execution); return execution; }
    const active: { lease: Lease; watchdog?: string; canceled: boolean; controller: AbortController; token: symbol } = { lease, canceled: false, controller: new AbortController(), token: Symbol(execution.executionId) };
    this.active.set(execution.executionId, active);
    const report = (p: Omit<Progress, 'at'>) => {
      this.assertLive(execution.executionId);
      const progress = { ...p, at: this.clock.now() };
      this.progressByExecution.set(execution.executionId, progress);
      this.store.saveExecution({ ...execution, checkpoint: progress });
    };
    try {
      execution.status = 'running'; this.store.saveExecution(execution); report({ stage: 'prepare', completed: 0 });
      active.watchdog = this.clock.schedule(this.clock.now() + this.watchdogTtl, () => {
        if (this.active.get(execution.executionId)?.token === active.token) { active.canceled = true; execution.status = 'failed'; execution.reason = 'watchdog-timeout'; this.store.saveExecution(execution); this.arbiter.release(lease.leaseId); this.active.delete(execution.executionId); }
      });
      const skillResult = await fn(lease, report, active.controller.signal);
      if (skillResult && typeof skillResult === 'object' && 'outcome' in skillResult) {
        const outcome = String((skillResult as { outcome: string }).outcome);
        if (outcome === 'canceled') throw new Error('execution-canceled');
        if (outcome === 'failed') throw new Error(String((skillResult as { reason?: string }).reason ?? 'skill-failed'));
        execution.outcome = outcome;
      }
      this.assertLive(execution.executionId);
      execution.status = 'verifying'; this.store.saveExecution(execution); report({ stage: 'verify', completed: 1, total: 1 });
      if (execution.outcome === 'ambiguous' || execution.outcome === 'partial') {
        execution.status = 'suspended';
      } else if (execution.outcome === 'confirmed') {
        execution.status = 'succeeded';
      } else {
        execution.status = 'succeeded'; execution.outcome = 'not-applicable';
      }
    } catch (error) {
      if (execution.status === 'failed') { /* watchdog or external failure already recorded */ }
      else if (active.canceled || (error instanceof Error && error.message === 'execution-canceled')) { execution.status = 'canceled'; execution.reason = 'canceled'; }
      else { execution.status = 'failed'; execution.reason = error instanceof Error ? error.message : String(error); }
    } finally {
      if (active.watchdog) this.clock.cancel(active.watchdog);
      if (this.active.get(execution.executionId)?.token === active.token) {
        this.arbiter.release(lease.leaseId); this.active.delete(execution.executionId); this.store.saveExecution(execution);
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
  watchdog(executionId: string) { const active = this.active.get(executionId); if (active) { active.canceled = true; this.arbiter.release(active.lease.leaseId); this.active.delete(executionId); this.store.updateExecutionStatus?.(executionId, 'failed', 'watchdog-timeout'); } }
  reconcile(executionId: string, outcome: 'confirmed' | 'partial' | 'ambiguous') { this.store.updateExecutionStatus?.(executionId, 'succeeded', outcome); return outcome; }
  private assertLive(executionId: string) { const active = this.active.get(executionId); if (!active || active.canceled) throw new Error('execution-canceled'); this.arbiter.validate(active.lease.leaseId, executionId); }
}
