import { z } from 'zod';
import { nextId } from '../contracts/index.js';
import type { ModelMessage, ModelProvider, ToolCall } from '../providers/scripted/index.js';
import type { FakeClientBridge } from '../bridge/fake/index.js';
import type { SQLiteStore } from '../persistence/store.js';
import { navigate } from '../skills/navigation.js';
import { findSkills } from '../skills/registry.js';
import type { EventHub } from '../diagnostics/events.js';
import { redactError } from '../diagnostics/redaction.js';

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
  { name: 'query_memory', description: 'Query durable places and episodes', parameters: empty },
  { name: 'query_knowledge', description: 'Query durable places and episodes', parameters: empty },
];

const argsByTool: Record<string, z.ZodTypeAny> = {
  get_state: z.object({}), get_inventory: z.object({}), query_local_world: z.object({}), capture_view: z.object({}),
  find_skills: z.object({ query: z.string().optional() }),
  start_skill: z.object({ skill: z.string(), x: z.number().int().optional(), y: z.number().int().optional(), text: z.string().optional(), ms: z.number().int().nonnegative().optional(), proposalId: z.string().optional() }),
  get_execution: z.object({ executionId: z.string() }), cancel_execution: z.object({ executionId: z.string() }),
  read_events: z.object({ cursor: z.string().optional(), filter: z.string().optional(), limit: z.number().int().positive().max(500).optional() }),
  revise_goal: z.object({ goalId: z.string(), expectedRevision: z.number().int().nonnegative(), change: z.string().min(1) }),
  send_chat: z.object({ text: z.string().min(1) }), query_memory: z.object({}), query_knowledge: z.object({}),
};

export class ToolRouter {
  constructor(private readonly bridge: FakeClientBridge, private readonly store?: SQLiteStore, private readonly events?: EventHub) {}
  async invoke(call: ToolCall): Promise<z.infer<typeof ToolCallResultSchema>> {
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
        case 'capture_view': result = { synthetic: true, mimeType: 'image/png', data: 'c2ltdWxhdGVk', captureReason: 'tool-request', sequence: this.bridge.snapshot().revision }; break;
        case 'find_skills': result = findSkills(args.query as string | undefined); break;
        case 'get_execution': result = this.store?.getExecution(String(args.executionId)); break;
        case 'read_events': result = this.events?.read(String(args.cursor ?? '0'), Number(args.limit ?? 100), args.filter as string | undefined); break;
        case 'revise_goal': result = this.store?.reviseGoal(String(args.goalId), Number(args.expectedRevision), String(args.change)); break;
        case 'query_memory': case 'query_knowledge': result = { places: this.store?.listPlaces() ?? [], episodes: this.store?.listEpisodes() ?? [] }; break;
        case 'start_skill': {
          const skill = String(args.skill);
          if (skill === 'navigate_to') result = navigate(this.bridge, { x: Number(args.x), y: Number(args.y) });
          else if (skill === 'observe_ui') result = this.bridge.snapshot();
          else if (skill === 'send_chat') { this.bridge.setUi('chat'); this.bridge.setUi('gameplay'); result = { sent: true, text: args.text }; }
          else if (skill === 'place_one') result = this.bridge.place(Number(args.x), Number(args.y));
          else if (skill === 'wait_for_condition') result = { waitedMs: Number(args.ms) };
          else return { callId: call.id, name: call.name, ok: false, error: 'unsupported-skill' };
          break;
        }
        case 'send_chat': this.bridge.setUi('chat'); this.bridge.setUi('gameplay'); result = { sent: true, text: args.text }; break;
        case 'cancel_execution': this.store?.updateExecutionStatus(String(args.executionId), 'canceled', 'tool-cancel'); result = { canceled: args.executionId }; break;
      }
      this.events?.publish(`tool.${call.name}`, { callId: call.id, result }, false);
      return { callId: call.id, name: call.name, ok: true, result };
    } catch (error) { return { callId: call.id, name: call.name, ok: false, error: redactError(error) }; }
  }
}

export class AgentLoop {
  constructor(private readonly provider: ModelProvider, private readonly router: ToolRouter, private readonly maxTurns = 8) {}
  async run(messages: ModelMessage[], tools: ToolDefinition[] = defaultTools, signal?: AbortSignal) {
    const trace: unknown[] = [];
    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      const response = await this.provider.complete(messages, tools, signal); trace.push(response);
      if (!response.toolCalls?.length) return { response, trace };
      const reads = response.toolCalls.filter(call => ['get_state','get_inventory','query_local_world','capture_view','find_skills','get_execution','read_events','query_memory','query_knowledge'].includes(call.name));
      const writes = response.toolCalls.filter(call => !reads.includes(call));
      const results = [...await Promise.all(reads.map(call => this.router.invoke(call))), ...await writes.reduce(async (chain, call) => [...await chain, await this.router.invoke(call)], Promise.resolve([] as Awaited<ReturnType<ToolRouter['invoke']>>[]))];
      messages.push({ role: 'assistant', content: response.text ?? '', });
      for (const result of results) messages.push({ role: 'tool', content: JSON.stringify(result) });
    }
    return { response: { stopReason: 'max-turns', text: '' }, trace };
  }
}
