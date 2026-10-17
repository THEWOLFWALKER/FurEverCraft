import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RuntimeAssembly } from '../execution/factory.js';
import { redact } from '../diagnostics/redaction.js';
import {
  CancelPayloadSchema, ChatPayloadSchema, CommandRequestSchema, GoalRevisePayloadSchema, GoalSetPayloadSchema,
  MessagePayloadSchema, type CommandRequest, type CommandResult, type ProviderMetadata,
} from './dto.js';

const canonicalize = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalize)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]))
    : value;

export function canonicalPayloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

const terminal = new Set(['succeeded', 'failed', 'canceled']);

export class ControlService {
  private paused = false;
  private stopping = false;
  private attached?: RuntimeAssembly;
  constructor(runtime?: RuntimeAssembly, private readonly providerMetadata: ProviderMetadata = { provider: 'unknown', configured: true, transport: 'unknown' }) { this.attached = runtime; }
  attach(runtime: RuntimeAssembly) { this.attached = runtime; }
  private get runtime(): RuntimeAssembly { if (!this.attached) throw new Error('control-not-attached'); return this.attached; }

  status() {
    const goal = this.runtime.store.listGoals().find(item => item.status === 'active' || item.status === 'paused');
    return { state: this.stopping ? 'closing' : this.runtime.session.state, paused: this.paused, stopping: this.stopping, goal, executions: this.runtime.store.listExecutions().length, context: this.runtime.bridge.context };
  }
  capabilities() { return { profile: this.runtime.bridge.context.serverProfileId, provider: this.providerMetadata, bridge: redact((this.runtime.bridge as any).capabilities ?? {}), skills: true, limitations: this.providerMetadata.transport === 'unavailable' ? ['provider-unavailable'] : [] }; }
  goals() { return this.runtime.store.listGoals(); }
  executions() { return this.runtime.store.listExecutions(); }
  effects(executionId?: string) { return this.runtime.store.listEffects(executionId); }
  places() { return this.runtime.store.listPlaces(this.runtime.bridge.context); }
  events(cursor = '0', limit = 100, filter?: string) { return this.runtime.session.events.read(cursor, limit, filter); }
  provider() { return redact(this.providerMetadata); }

  async command(input: unknown): Promise<CommandResult> {
    const parsed = CommandRequestSchema.safeParse(input);
    if (!parsed.success) return { requestId: typeof (input as any)?.requestId === 'string' ? (input as any).requestId : 'invalid', command: 'message', state: 'rejected', code: 'invalid-command', payloadHash: canonicalPayloadHash(input) };
    const request = parsed.data;
    const payloadHash = canonicalPayloadHash({ command: request.command, payload: request.payload, expectedRevision: request.expectedRevision });
    const scope = `control:${this.runtime.bridge.context.serverProfileId}`;
    const old = this.runtime.store.getActionReceipt(scope, request.requestId);
    if (old) {
      if (old.payloadHash !== payloadHash) return { requestId: request.requestId, command: request.command, state: 'conflict', code: 'command-payload-conflict', payloadHash };
      return { requestId: request.requestId, command: request.command, state: old.status === 'pending' ? 'accepted' : old.status === 'completed' ? 'terminal' : old.status === 'conflict' ? 'conflict' : old.status === 'rejected' ? 'rejected' : 'unknown', result: old.result, payloadHash };
    }
    this.runtime.store.addActionReceipt({ receiptId: request.requestId, scope, commandId: request.requestId, status: 'pending', payloadHash });
    try {
      const result = await this.execute(request);
      const state = result.state;
      // Conflict/rejected are decisions, not terminal success: persisting them as completed would replay a false terminal.
      const receiptStatus = state === 'accepted' ? 'pending' : state === 'unknown' ? 'unknown' : state === 'terminal' ? 'completed' : state === 'conflict' ? 'conflict' : 'rejected';
      this.runtime.store.updateActionReceipt(scope, request.requestId, receiptStatus, result.result);
      this.runtime.session.events.publish(`control.${request.command}`, { requestId: request.requestId, state, result: result.result }, true);
      return { ...result, requestId: request.requestId, command: request.command, payloadHash };
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      const result: CommandResult = { requestId: request.requestId, command: request.command, state: code.startsWith('goal-revision-conflict') ? 'conflict' : 'rejected', code, payloadHash };
      this.runtime.store.updateActionReceipt(scope, request.requestId, result.state === 'conflict' ? 'conflict' : 'rejected', result);
      return result;
    }
  }

  private async execute(request: CommandRequest): Promise<CommandResult> {
    const payload = request.payload;
    switch (request.command) {
      case 'goal.set': { const p = GoalSetPayloadSchema.parse(payload); const current = this.runtime.store.getGoal(p.goalId); const revision = current ? current.revision + 1 : 1; if (request.expectedRevision !== undefined && (current?.revision ?? 0) !== request.expectedRevision) throw new Error(`goal-revision-conflict:${current?.revision ?? 0}`); this.runtime.store.saveGoal({ goalId: p.goalId, revision, status: p.status ?? 'active', text: p.text, context: this.runtime.bridge.context }); return { requestId: request.requestId, command: request.command, state: 'terminal', result: this.runtime.store.getGoal(p.goalId), payloadHash: '' }; }
      case 'goal.revise': { const p = GoalRevisePayloadSchema.parse(payload); const result = this.runtime.store.reviseGoal(p.goalId, p.expectedRevision ?? request.expectedRevision ?? 0, p.change); return { requestId: request.requestId, command: request.command, state: 'terminal', result, payloadHash: '' }; }
      case 'message': { const p = MessagePayloadSchema.parse(payload); if (this.paused) return { requestId: request.requestId, command: request.command, state: 'accepted', code: 'paused', result: { queued: true }, payloadHash: '' }; const run = await this.runtime.loop.run([{ role: 'user', content: p.text }], undefined, undefined, { goalId: p.goalId, goalRevision: p.goalRevision, store: this.runtime.store }); return { requestId: request.requestId, command: request.command, state: 'terminal', result: run, payloadHash: '' }; }
      case 'chat': { const p = ChatPayloadSchema.parse(payload); const result = await this.runtime.router.invoke({ id: request.requestId, name: 'send_chat', arguments: JSON.stringify({ text: p.text }) }); return { requestId: request.requestId, command: request.command, state: result.ok ? 'terminal' : 'unknown', result, payloadHash: '' }; }
      case 'pause': this.paused = true; this.runtime.session.events.publish('runtime.pausing', {}, true); return { requestId: request.requestId, command: request.command, state: 'terminal', result: { paused: true }, payloadHash: '' };
      case 'resume': this.paused = false; this.stopping = false; return { requestId: request.requestId, command: request.command, state: 'terminal', result: { paused: false }, payloadHash: '' };
      case 'stop': { this.stopping = true; this.paused = true; this.runtime.scheduler.close(); const canceled = await this.cancelActiveExecutions(); this.runtime.session.events.publish('runtime.stopping', { reason: 'stop', canceled }, true); return { requestId: request.requestId, command: request.command, state: 'accepted', result: { stopping: true, canceled }, payloadHash: '' }; }
      case 'cancel': { const p = CancelPayloadSchema.parse(payload); const execution = this.runtime.store.getExecution(p.executionId); if (!execution) return { requestId: request.requestId, command: request.command, state: 'unknown', code: 'execution-not-found', payloadHash: '' }; const invoke = await this.runtime.router.invoke({ id: request.requestId, name: 'cancel_execution', arguments: JSON.stringify(p) }); const after = this.runtime.store.getExecution(p.executionId); return { requestId: request.requestId, command: request.command, state: terminal.has(after?.status ?? '') ? 'terminal' : invoke.ok ? 'accepted' : 'unknown', code: invoke.ok ? undefined : invoke.error, result: after, payloadHash: '' }; }
      case 'save': { const checkpoint = { checkpointId: `runtime-${this.runtime.clock.now()}`, executionId: 'runtime', revision: (this.runtime.store.getLatestCheckpoint('runtime')?.revision ?? 0) + 1, payload: this.status() }; this.runtime.store.saveCheckpoint(checkpoint); return { requestId: request.requestId, command: request.command, state: 'terminal', result: checkpoint, payloadHash: '' }; }
      case 'quit': { this.stopping = true; this.paused = true; this.runtime.session.events.publish('runtime.shutdown-requested', {}, true); return { requestId: request.requestId, command: request.command, state: 'accepted', result: { stopping: true }, payloadHash: '' }; }
    }
  }

  /** Best-effort stop of every non-terminal execution; failures are reported, not thrown. */
  private async cancelActiveExecutions(): Promise<string[]> {
    const canceled: string[] = [];
    for (const execution of this.runtime.store.listExecutions()) {
      if (terminal.has(execution.status)) continue;
      try { await this.runtime.router.invoke({ id: `stop-${execution.executionId}`, name: 'cancel_execution', arguments: JSON.stringify({ executionId: execution.executionId }) }); canceled.push(execution.executionId); }
      catch { /* best-effort: continue stopping the remaining executions */ }
    }
    return canceled;
  }
}

export type { CommandRequest };
export { CommandRequestSchema };
