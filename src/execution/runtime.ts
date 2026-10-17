import { hashProposal, nextId, type Clock, type Execution } from '../contracts/index.js';
import { ManualClock } from '../contracts/index.js';
import type { FakeClientBridge } from '../bridge/fake/index.js';
import type { SQLiteStore } from '../persistence/store.js';
import { findSkill, type SkillId } from '../skills/registry.js';

export type Lease = { leaseId: string; owner: string; resources: string[]; until: number; generation: number };
export type ExecutionStage = 'prepare' | 'dispatch' | 'verify' | 'complete';
export type Progress = { stage: ExecutionStage; completed: number; total?: number; message?: string; at: number };
export type ExecutorOptions = { clock?: Clock; leaseTtl?: number; watchdogTtl?: number };

export class InputArbiter {
  private leases = new Map<string, Lease>();
  private generation = 0;
  constructor(private readonly now: () => number = () => Date.now()) {}
  acquire(owner: string, resources: string[], ttl = 1000): Lease {
    this.releaseExpired();
    for (const lease of this.leases.values()) {
      if (lease.resources.some(r => resources.includes(r))) throw new Error('resource-busy');
    }
    const lease = { leaseId: nextId('lease'), owner, resources: [...new Set(resources)], until: this.now() + ttl, generation: ++this.generation };
    this.leases.set(lease.leaseId, lease);
    return lease;
  }
  validate(leaseId: string, owner: string): Lease {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.owner !== owner || lease.until <= this.now() || lease.generation !== this.generation) throw new Error('lease-invalid');
    return lease;
  }
  renew(leaseId: string, owner: string, ttl: number): Lease {
    const lease = this.validate(leaseId, owner);
    lease.until = this.now() + ttl;
    return lease;
  }
  release(leaseId: string) { this.leases.delete(leaseId); }
  preempt(owner: string) {
    this.generation++;
    for (const [id, lease] of this.leases) if (lease.owner !== owner) this.leases.delete(id);
  }
  private releaseExpired() { for (const [id, lease] of this.leases) if (lease.until <= this.now()) this.leases.delete(id); }
}

export class Executor {
  private readonly clock: Clock;
  private readonly leaseTtl: number;
  private readonly watchdogTtl: number;
  private readonly progressByExecution = new Map<string, Progress>();
  private readonly active = new Map<string, { lease: Lease; watchdog?: string; canceled: boolean }>();

  constructor(
    private readonly bridge: FakeClientBridge,
    private readonly store: SQLiteStore,
    private readonly arbiter = new InputArbiter(),
    options: ExecutorOptions = {},
  ) {
    this.clock = options.clock ?? new ManualClock();
    this.leaseTtl = options.leaseTtl ?? 1000;
    this.watchdogTtl = options.watchdogTtl ?? this.leaseTtl;
  }

  resourcesFor(skillId: string): string[] {
    return findSkill(skillId)?.resources ?? (skillId === 'send_chat' ? ['ui', 'textEntry'] : ['movement', 'view', 'hands']);
  }

  start(goalId: string, skillId: string, args: Record<string, unknown>, fn: (lease: Lease, report: (p: Omit<Progress, 'at'>) => void) => unknown): Execution {
    const proposalId = String(args.proposalId ?? nextId('proposal'));
    const proposalHash = hashProposal({ skillId, args });
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
    const active: { lease: Lease; watchdog?: string; canceled: boolean } = { lease, canceled: false };
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
        if (this.active.has(execution.executionId)) { active.canceled = true; execution.status = 'failed'; execution.reason = 'watchdog-timeout'; this.store.saveExecution(execution); this.arbiter.release(lease.leaseId); this.active.delete(execution.executionId); }
      });
      fn(lease, report);
      this.assertLive(execution.executionId);
      execution.status = 'verifying'; this.store.saveExecution(execution); report({ stage: 'verify', completed: 1, total: 1 });
      execution.status = 'succeeded'; execution.outcome = 'confirmed';
    } catch (error) {
      if (execution.status === 'failed') { /* watchdog or external failure already recorded */ }
      else if (active.canceled || (error instanceof Error && error.message === 'execution-canceled')) { execution.status = 'canceled'; execution.reason = 'canceled'; }
      else { execution.status = 'failed'; execution.reason = error instanceof Error ? error.message : String(error); }
    } finally {
      if (active.watchdog) this.clock.cancel(active.watchdog);
      this.arbiter.release(lease.leaseId); this.active.delete(execution.executionId); this.store.saveExecution(execution);
    }
    return execution;
  }

  cancel(executionId: string) {
    const active = this.active.get(executionId);
    if (active) { active.canceled = true; this.store.updateExecutionStatus?.(executionId, 'stopping', 'cancel-requested'); }
    this.store.updateExecutionStatus?.(executionId, 'canceled', 'canceled');
  }
  progress(executionId: string) { return this.progressByExecution.get(executionId); }
  watchdog(executionId: string) { const active = this.active.get(executionId); if (active) { active.canceled = true; this.arbiter.release(active.lease.leaseId); this.active.delete(executionId); this.store.updateExecutionStatus?.(executionId, 'failed', 'watchdog-timeout'); } }
  reconcile(executionId: string, outcome: 'confirmed' | 'partial' | 'ambiguous') { this.store.updateExecutionStatus?.(executionId, 'succeeded', outcome); return outcome; }
  private assertLive(executionId: string) { const active = this.active.get(executionId); if (!active || active.canceled) throw new Error('execution-canceled'); this.arbiter.validate(active.lease.leaseId, executionId); }
}
