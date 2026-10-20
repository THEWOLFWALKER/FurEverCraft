import { z } from 'zod';
import { nextId, type BodyContext } from '../contracts/index.js';
import type { ModelMessage, ModelProvider, ToolCall } from '../providers/scripted/index.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import type { SQLiteStore } from '../persistence/store.js';
import { Executor, type InputArbiter, type Progress } from '../execution/runtime.js';
import type { AdmissionDecision, ExecutionAdmission } from '../execution/admission.js';
import { skillImplementations } from '../skills/skills.js';
import { findSkills, skillManifests } from '../skills/registry.js';
import type { EventHub } from '../diagnostics/events.js';
import { redactError } from '../diagnostics/redaction.js';
import { MemoryService } from '../autonomous/memory.js';
import { syntheticCapture } from '../autonomous/bounds.js';

export const ToolCallResultSchema = z.object({ callId: z.string(), name: z.string(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() });
export type ToolDefinition = { name: string; description: string; parameters: unknown };
const empty = { type: 'object', properties: {}, additionalProperties: false };
export const defaultTools: ToolDefinition[] = [
  { name: 'get_state', description: 'Read current simulated state', parameters: empty },
  { name: 'get_inventory', description: 'Read inventory', parameters: empty },
  { name: 'query_local_world', description: 'Read known local cells', parameters: empty },
  { name: 'capture_view', description: 'Capture synthetic test frame', parameters: empty },
  { name: 'find_skills', description: 'Find available skills', parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false } },
  { name: 'start_skill', description: 'Start a supported skill', parameters: { type: 'object', properties: { skill: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' }, text: { type: 'string' }, ms: { type: 'integer' }, proposalId: { type: 'string' } }, required: ['skill'], additionalProperties: false } },
  { name: 'get_execution', description: 'Read execution status', parameters: { type: 'object', properties: { executionId: { type: 'string' } }, required: ['executionId'], additionalProperties: false } },
  { name: 'cancel_execution', description: 'Cancel execution', parameters: { type: 'object', properties: { executionId: { type: 'string' } }, required: ['executionId'], additionalProperties: false } },
  { name: 'read_events', description: 'Read diagnostic events from a cursor', parameters: { type: 'object', properties: { cursor: { type: 'string' }, filter: { type: 'string' }, limit: { type: 'integer' } }, additionalProperties: false } },
  { name: 'revise_goal', description: 'CAS update a goal', parameters: { type: 'object', properties: { goalId: { type: 'string' }, expectedRevision: { type: 'integer' }, change: { type: 'string' } }, required: ['goalId', 'expectedRevision', 'change'], additionalProperties: false } },
  { name: 'send_chat', description: 'Send chat text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { name: 'query_memory', description: 'Query durable spatial and episodic memory', parameters: { type: 'object', properties: { limit: { type: 'integer' }, cursor: { type: 'string' } }, additionalProperties: false } },
  { name: 'query_knowledge', description: 'Query versioned knowledge rules', parameters: { type: 'object', properties: { predicate: { type: 'string' }, version: { type: 'integer' }, limit: { type: 'integer' }, cursor: { type: 'string' } }, additionalProperties: false } },
  { name: 'remember_place', description: 'Remember an observed place', parameters: { type: 'object', properties: { placeId: { type: 'string' }, payload: { type: 'object' } }, required: ['placeId','payload'], additionalProperties: false } },
];

const argsByTool: Record<string, z.ZodTypeAny> = {
  get_state: z.object({}), get_inventory: z.object({}), query_local_world: z.object({}), capture_view: z.object({}),
  find_skills: z.object({ query: z.string().optional() }),
  start_skill: z.union([
    z.object({ skill: z.literal('navigate_to'), x: z.number().int().finite(), y: z.number().int().finite(), proposalId: z.string().optional() }).strict(),
    z.object({ skill: z.literal('place_one'), x: z.number().int().finite(), y: z.number().int().finite(), proposalId: z.string().optional() }).strict(),
    z.object({ skill: z.literal('send_chat'), text: z.string().min(1), proposalId: z.string().optional() }).strict(),
    z.object({ skill: z.literal('wait_for_condition'), ms: z.number().int().nonnegative().finite(), proposalId: z.string().optional() }).strict(),
    z.object({ skill: z.literal('observe_ui'), proposalId: z.string().optional() }).strict(),
    z.object({ skill: z.literal('look_at'), x: z.number().int().finite(), y: z.number().int().finite(), proposalId: z.string().optional() }).strict(),
    z.object({ skill: z.literal('explore_area'), radius: z.number().int().nonnegative().max(32), proposalId: z.string().optional() }).strict(),
    z.object({ skill: z.literal('dig_one'), x: z.number().int().finite(), y: z.number().int().finite(), proposalId: z.string().optional() }).strict(),
    z.object({ skill: z.literal('collect_nearby'), proposalId: z.string().optional() }).strict(),
    z.object({ skill: z.literal('gather_blocks'), block: z.string().min(1), proposalId: z.string().optional() }).strict(),
    z.object({ skill: z.literal('return_to_place'), placeId: z.string().min(1), proposalId: z.string().optional() }).strict(),
  ]),
  get_execution: z.object({ executionId: z.string() }), cancel_execution: z.object({ executionId: z.string() }),
  read_events: z.object({ cursor: z.string().optional(), filter: z.string().optional(), limit: z.number().int().positive().max(500).optional() }),
  revise_goal: z.object({ goalId: z.string(), expectedRevision: z.number().int().nonnegative(), change: z.string().min(1) }),
  send_chat: z.object({ text: z.string().min(1) }), query_memory: z.object({ limit: z.number().int().positive().max(20).optional(), cursor: z.string().optional() }), query_knowledge: z.object({ predicate: z.string().optional(), version: z.number().int().positive().optional(), limit: z.number().int().positive().max(20).optional(), cursor: z.string().optional() }), remember_place: z.object({ placeId: z.string(), payload: z.record(z.unknown()) }),
};

export class ToolRouter {
  private readonly executor?: Executor;
  private readonly memory?: MemoryService;
  constructor(private readonly bridge: ClientBridgeCapabilities, private readonly store?: SQLiteStore, private readonly events?: EventHub, executor?: Executor, memory?: MemoryService, private readonly clockNow: () => number = () => Date.now(), private readonly admission?: ExecutionAdmission) {
    if (store) { this.executor = executor ?? new Executor(bridge, store); this.memory = memory ?? new MemoryService(store); }
  }
  /** Skills the current body can actually run, derived from capability presence rather than a hard-coded list. */
  availableSkills(): string[] {
    const all = skillManifests.map(manifest => manifest.id as string);
    return all.filter(id => {
      if (id === 'look_at') return Boolean(this.bridge.lookAt);
      if (id === 'dig_one') return Boolean(this.bridge.dig);
      if (id === 'gather_blocks') return Boolean(this.bridge.digBlock && this.bridge.adjacentBlock);
      if (id === 'collect_nearby') return Boolean(this.bridge.collectNearby);
      if (id === 'return_to_place') return Boolean(this.bridge.findPlace);
      return true;
    });
  }
  async invoke(call: ToolCall, admissionContext: { goalId?: string; goalRevision?: number; owner?: string; signal?: AbortSignal } = {}): Promise<z.infer<typeof ToolCallResultSchema>> {
    let raw: unknown;
    try { raw = JSON.parse(call.arguments || '{}'); } catch { return { callId: call.id, name: call.name, ok: false, error: 'invalid-json-arguments' }; }
    try {
      const schema = argsByTool[call.name]; if (!schema) return { callId: call.id, name: call.name, ok: false, error: 'unknown-tool' };
      const parsed = schema.safeParse(raw); if (!parsed.success) return { callId: call.id, name: call.name, ok: false, error: 'invalid-tool-arguments' };
      const args = parsed.data as Record<string, unknown>;
      let result: unknown;
      switch (call.name) {
        case 'get_state': result = this.bridge.snapshot(); break;
        case 'get_inventory': result = { count: this.bridge.inventory, source: 'simulated' }; break;
        case 'query_local_world': result = this.bridge.snapshot().cells; break;
        case 'capture_view': result = syntheticCapture('tool-request', Date.now(), this.bridge.snapshot().revision); break;
        case 'find_skills': result = findSkills(args.query as string | undefined); break;
        // A missing backing service must report failure, not a successful undefined.
        case 'get_execution': if (!this.store) return { callId: call.id, name: call.name, ok: false, error: 'store-unavailable' }; result = this.store.getExecution(String(args.executionId)); if (!result) return { callId: call.id, name: call.name, ok: false, error: 'execution-not-found' }; break;
        case 'read_events': if (!this.events) return { callId: call.id, name: call.name, ok: false, error: 'events-unavailable' }; result = this.events.read(String(args.cursor ?? '0'), Number(args.limit ?? 100), args.filter as string | undefined); break;
        case 'revise_goal': if (!this.store) return { callId: call.id, name: call.name, ok: false, error: 'store-unavailable' }; result = this.store.reviseGoal(String(args.goalId), Number(args.expectedRevision), String(args.change)); break;
        case 'query_memory': if (!this.memory) return { callId: call.id, name: call.name, ok: false, error: 'memory-unavailable' }; result = { spatial: this.memory.querySpatial(args as any), episodic: this.memory.queryEpisodic(args as any) }; break;
        case 'query_knowledge': if (!this.memory) return { callId: call.id, name: call.name, ok: false, error: 'memory-unavailable' }; result = this.memory.queryKnowledge(args as any); break;
        case 'remember_place': if (!this.memory) return { callId: call.id, name: call.name, ok: false, error: 'memory-unavailable' }; result = this.memory.rememberPlace({ placeId: String(args.placeId), context: this.bridge.context, payload: args.payload }); break;
        case 'start_skill': {
          const skill = String(args.skill);
          const implementation = skillImplementations[skill as keyof typeof skillImplementations];
          if (!implementation || !this.executor || !this.store) return { callId: call.id, name: call.name, ok: false, error: 'unsupported-skill' };
          const executeArgs = skill === 'navigate_to' || skill === 'place_one' || skill === 'look_at' || skill === 'dig_one' ? { x: Number(args.x), y: Number(args.y) } : skill === 'send_chat' ? String(args.text) : skill === 'wait_for_condition' ? Number(args.ms) : skill === 'explore_area' ? Number(args.radius) : skill === 'gather_blocks' ? String(args.block) : skill === 'return_to_place' ? String(args.placeId) : undefined;
          // The effect row references the execution, so it is written by the executor hook once the
          // execution exists. Prepared intent is persisted before dispatch; only a confirmed outcome settles it.
          const sideEffect = skill === 'place_one' || skill === 'send_chat' || skill === 'dig_one' || skill === 'gather_blocks';
          const run = await this.runWriteSkill(call, skill, args, executeArgs, sideEffect, admissionContext);
          if (!run.ok) {
            this.events?.publish(`tool.${call.name}`, { callId: call.id, result: run.result }, false);
            return { callId: call.id, name: call.name, ok: false, result: run.result, error: run.error };
          }
          result = run.result;
          break;
        }
        case 'send_chat': {
          if (!this.executor || !this.store) return { callId: call.id, name: call.name, ok: false, error: 'executor-unavailable' };
          const run = await this.runWriteSkill(call, 'send_chat', args, String(args.text), true, admissionContext);
          if (!run.ok) {
            this.events?.publish(`tool.${call.name}`, { callId: call.id, result: run.result }, false);
            return { callId: call.id, name: call.name, ok: false, result: run.result, error: run.error };
          }
          result = run.result;
          break;
        }
        case 'cancel_execution': {
          if (!this.store) return { callId: call.id, name: call.name, ok: false, error: 'store-unavailable' };
          const target = this.store.getExecution(String(args.executionId));
          if (!target) return { callId: call.id, name: call.name, ok: false, error: 'execution-not-found' };
          this.executor?.cancel(String(args.executionId));
          result = { canceled: args.executionId, status: this.store.getExecution(String(args.executionId))?.status };
          break;
        }
      }
      this.events?.publish(`tool.${call.name}`, { callId: call.id, result }, false);
      return { callId: call.id, name: call.name, ok: true, result };
    } catch (error) { return { callId: call.id, name: call.name, ok: false, error: redactError(error) }; }
  }

  private checkAdmission(skillId: string, context: { goalId?: string; goalRevision?: number; owner?: string; signal?: AbortSignal }, admittedContext: BodyContext): AdmissionDecision | undefined {
    if (!this.admission) return undefined;
    return this.admission.check({
      skillId,
      goalId: context.goalId,
      goalRevision: context.goalRevision,
      // Without an explicit caller owner, fence against this runtime's own session owner. A
      // stale finalizer that presents an old owner is rejected instead of dispatching.
      owner: context.owner ?? this.admission.ownerId,
      context: admittedContext,
      signal: context.signal,
    });
  }

  private currentContext() { return this.bridge.context; }

  /**
   * Run a body-input skill through the executor with per-write admission and a durable
   * prepared -> may-have-dispatched barrier. The skill function is not invoked until the
   * prepared effect is persisted; the barrier is persisted before any dispatch report is
   * forwarded to the body. A failed barrier write aborts before the skill can act.
   */
  private async runWriteSkill(
    call: ToolCall,
    skill: string,
    args: Record<string, unknown>,
    executeArgs: unknown,
    sideEffect: boolean,
    admissionContext: { goalId?: string; goalRevision?: number; owner?: string; signal?: AbortSignal },
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    const implementation = skillImplementations[skill as keyof typeof skillImplementations];
    if (!implementation || !this.executor || !this.store) return { ok: false, error: 'unsupported-skill' };
    // Capture the context once and re-check it at each dispatch boundary: a connection/body
    // epoch change between admission and the write must reject the stale plan. Copy the object
    // because a bridge may mutate its context in place instead of replacing it.
    const admittedContext = { ...this.currentContext() };
    const rejected = this.checkAdmission(skill, admissionContext, admittedContext);
    if (rejected && !rejected.ok) return { ok: false, error: rejected.code, result: { code: rejected.code, message: rejected.message } };
    const effectId = sideEffect ? nextId('effect') : undefined;
    let effectPrepared = false;
    const execution = await this.executor.start(admissionContext.goalId ?? 'agent', skill, args, (lease, report, signal) => {
      const early = this.checkAdmission(skill, admissionContext, admittedContext);
      if (early && !early.ok) return { ok: false, outcome: 'failed', reason: early.code };
      if (effectId && !effectPrepared) {
        // Durable prepare must succeed before the skill can reach a dispatch report.
        this.store!.addEffect({
          effectId,
          executionId: lease.owner,
          context: this.bridge.context,
          status: 'prepared',
          intent: {
            kind: skill === 'place_one' ? 'place' : skill === 'send_chat' ? 'chat' : 'dig',
            x: typeof executeArgs === 'object' && executeArgs !== null ? (executeArgs as { x?: number }).x : undefined,
            y: typeof executeArgs === 'object' && executeArgs !== null ? (executeArgs as { y?: number }).y : undefined,
            text: skill === 'send_chat' ? String(executeArgs) : undefined,
            block: skill === 'gather_blocks' ? String(args.block) : undefined,
          },
        });
        effectPrepared = true;
      }
      const guardedReport = (progress: Omit<Progress, 'at'>) => {
        if (effectId && progress.stage === 'dispatch') {
          if (!effectPrepared) throw new Error('effect-not-prepared');
          // Every dispatch report is the last synchronous boundary before the skill body
          // performs input. Admission is re-evaluated, then the durable barrier is written.
          const barrier = this.checkAdmission(skill, { ...admissionContext, signal }, admittedContext);
          if (barrier && !barrier.ok) throw new Error(barrier.code);
          this.store!.updateEffect(effectId, 'may-have-dispatched', { barrier: 'pre-dispatch', goalId: admissionContext.goalId, goalRevision: admissionContext.goalRevision });
        }
        report(progress);
      };
      const result = (implementation as (ctx: Parameters<typeof implementation>[0], arg: any) => unknown)({ bridge: this.bridge, lease, report: guardedReport, isCanceled: () => signal.aborted, clock: { now: this.clockNow, schedule: (at, fn) => { const id = nextId('router-timer'); const timer = setTimeout(fn, Math.max(0, at-this.clockNow())); (this as any)._timers ??= new Map(); (this as any)._timers.set(id,timer); return id; }, cancel: id => { const timers=(this as any)._timers as Map<string,ReturnType<typeof setTimeout>>; const timer=timers?.get(id); if(timer) clearTimeout(timer); timers?.delete(id); } } }, executeArgs);
      if (result instanceof Promise) return result.catch(error => { throw error; });
      return result;
    });
    if (sideEffect && effectId && effectPrepared) {
      const effect = this.store.getEffect(effectId);
      const current = effect?.status;
      // Keep the pre-dispatch barrier evidence: settlement must not erase the audit trail that
      // proves the durable barrier was crossed before any world action.
      const evidence = { ...(effect?.evidence as Record<string, unknown> | undefined), executionId: execution.executionId, outcome: execution.outcome };
      // Only an explicitly confirmed skill settles the effect. A prepared-but-never-dispatched
      // effect stays distinguishable from one that may have reached the body.
      if (execution.outcome === 'confirmed') this.store.updateEffect(effectId, 'confirmed', evidence);
      else if (execution.outcome === 'partial') this.store.updateEffect(effectId, 'partial', evidence);
      else if (current === 'prepared') this.store.updateEffect(effectId, 'prepared', { ...evidence, dispatched: false });
      else this.store.updateEffect(effectId, 'ambiguous', evidence);
    }
    if (execution.outcome === 'ambiguous' || execution.status === 'failed' || execution.status === 'canceled') {
      return { ok: false, result: execution, error: execution.reason ?? execution.outcome ?? execution.status };
    }
    return { ok: true, result: execution };
  }
}

export class AgentLoop {
  constructor(private readonly provider: ModelProvider, private readonly router: ToolRouter, private readonly maxTurns = 8) {}
  async run(messages: ModelMessage[], tools: ToolDefinition[] = defaultTools, signal?: AbortSignal, options: { goalId?: string; goalRevision?: number; owner?: string; store?: SQLiteStore } = {}) {
    const history = messages.map(message => structuredClone(message));
    const trace: unknown[] = [];
    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (signal?.aborted) { this.provider.cancel(); throw new DOMException('The operation was aborted', 'AbortError'); }
      if (options.goalId && options.store) {
        const goal = options.store.getGoal(options.goalId);
        if (!goal || (options.goalRevision !== undefined && goal.revision !== options.goalRevision)) return { response: { stopReason: 'goal-revision-conflict', text: '' }, trace };
      }
      const response = await this.provider.complete(history, tools, signal); trace.push(response);
      if (!response.toolCalls?.length) return { response, trace };
      if (signal?.aborted) { this.provider.cancel(); throw new DOMException('The operation was aborted', 'AbortError'); }
      const byId = new Map<string, Awaited<ReturnType<ToolRouter['invoke']>>>();
      for (const call of response.toolCalls) {
        if (signal?.aborted) { this.provider.cancel(); throw new DOMException('The operation was aborted', 'AbortError'); }
        byId.set(call.id, await this.router.invoke(call, { goalId: options.goalId, goalRevision: options.goalRevision, owner: options.owner, signal }));
      }
      if (signal?.aborted) { this.provider.cancel(); throw new DOMException('The operation was aborted', 'AbortError'); }
      history.push({ role: 'assistant', content: response.text ?? '', toolCalls: response.toolCalls });
      for (const call of response.toolCalls) { const result = byId.get(call.id); if (result) history.push({ role: 'tool', toolCallId: result.callId, content: JSON.stringify(result) }); }
    }
    return { response: { stopReason: 'max-turns', text: '' }, trace };
  }
}
