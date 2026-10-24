import type { ModelMessage, ModelResponse, ModelProvider, ToolCall } from '../scripted/index.js';
import {
  MAX_TOOL_ARGUMENT_BYTES, normalizeToolArguments, parseSSE, parseToolArguments, tokenCount,
  ProviderError, ProviderRequestRunner, type RetryOptions, SSE_DONE, validateResponseStop, type HttpTransport, type StreamChunk,
} from '../shared.js';
import { anthropicMessages } from '../canonical.js';

export { anthropicMessages } from '../canonical.js';
export { FetchTransport } from '../openai/index.js';

export function anthropicTools(tools: unknown[]): unknown[] { return tools.map((tool: any) => tool?.name && tool?.input_schema ? tool : { name: tool.name, description: tool.description, input_schema: tool.parameters ?? { type: 'object', properties: {} } }); }

/** Terminal stop reasons that represent a complete Messages answer. */
const ANTHROPIC_SUCCESS_STOPS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence', 'tool_use']);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const invalidResponse = () => new ProviderError('provider-invalid-response', undefined, 'anthropic');

export class AnthropicStreamDecoder {
  async decode(chunks: AsyncIterable<StreamChunk>): Promise<ModelResponse> {
    let text = '', stop = 'unknown', usage: ModelResponse['usage']; const calls = new Map<number, ToolCall>(); let ended = false;
    for await (const event of parseSSE(chunks, { includeDone: true })) {
      if (event === SSE_DONE) { ended = true; continue; }
      if (!isRecord(event)) throw invalidResponse();
      const e: any = event; if (e.type === 'error') throw new ProviderError(e.error?.message ?? 'provider-stream-error', undefined, 'anthropic', false);
      if (e.type === 'content_block_start') {
        if (!isRecord(e.content_block)) throw invalidResponse();
        const b = e.content_block;
        if (b.type === 'text') {
          if (typeof b.text !== 'string') throw invalidResponse();
          text += b.text;
        } else if (b.type === 'tool_use') {
          // A streamed tool_use without a provider id/name cannot be paired; never invent one.
          if (typeof b.id !== 'string' || !b.id) throw new ProviderError('provider-invalid-tool-call', undefined, 'anthropic');
          if (typeof b.name !== 'string' || !b.name) throw new ProviderError('provider-invalid-tool-call', undefined, 'anthropic');
          calls.set(Number.isInteger(e.index) ? e.index : calls.size, { id: b.id, name: b.name, arguments: '' });
        }
      } else if (e.type === 'content_block_delta') {
        if (!isRecord(e.delta)) throw invalidResponse();
        if (e.delta.type === 'text_delta') {
          if (typeof e.delta.text !== 'string') throw invalidResponse();
          text += e.delta.text;
        }
        if (e.delta.type === 'input_json_delta') {
          const call = calls.get(e.index);
          if (call) {
            if (typeof e.delta.partial_json !== 'string') throw invalidResponse();
            call.arguments += e.delta.partial_json;
            if (new TextEncoder().encode(call.arguments).byteLength > MAX_TOOL_ARGUMENT_BYTES) throw new ProviderError('provider-tool-arguments-limit', undefined, 'anthropic');
          }
        }
      } else if (e.type === 'message_delta') {
        if (!isRecord(e.delta)) throw invalidResponse();
        if (e.delta.stop_reason !== undefined && e.delta.stop_reason !== null) {
          if (typeof e.delta.stop_reason !== 'string' || !e.delta.stop_reason) throw invalidResponse();
          stop = e.delta.stop_reason;
        }
        if (e.usage !== undefined && !isRecord(e.usage)) throw invalidResponse();
        if (e.usage) usage = { inputTokens: tokenCount(e.usage.input_tokens) || usage?.inputTokens || 0, outputTokens: tokenCount(e.usage.output_tokens) || usage?.outputTokens || 0 };
      } else if (e.type === 'message_start') {
        if (e.message?.usage !== undefined && !isRecord(e.message.usage)) throw invalidResponse();
        if (e.message?.usage) usage = { inputTokens: tokenCount(e.message.usage.input_tokens), outputTokens: tokenCount(e.message.usage.output_tokens) };
      } else if (e.type === 'message_stop') ended = true;
    }
    if (!ended) throw new ProviderError('provider-stream-truncated', undefined, 'anthropic');
    if (stop === 'unknown') throw new ProviderError('provider-stream-no-termination', undefined, 'anthropic');
    validateResponseStop(stop, ANTHROPIC_SUCCESS_STOPS, 'anthropic');
    const toolCalls: ToolCall[] = [];
    for (const call of calls.values()) {
      if (typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name) throw new ProviderError('provider-invalid-tool-call', undefined, 'anthropic');
      toolCalls.push({ id: call.id, name: call.name, arguments: normalizeToolArguments(call.arguments, 'anthropic') });
    }
    if (!toolCalls.length && stop === 'tool_use') throw invalidResponse();
    return { text: text || undefined, toolCalls, stopReason: stop, usage };
  }
}

export class AnthropicProvider implements ModelProvider {
  private readonly runner: ProviderRequestRunner;
  private readonly maxTokens: number;
  constructor(private transport: HttpTransport, private baseUrl: string, private model: string, private key?: string, private version = '2023-06-01', retry: RetryOptions = {}, maxTokens = 4096) {
    this.runner = new ProviderRequestRunner(retry);
    this.maxTokens = Math.max(1, maxTokens);
  }
  private headers(): Record<string, string> { return this.key ? { 'x-api-key': this.key, 'anthropic-version': this.version } : { 'anthropic-version': this.version }; }
  async complete(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal): Promise<ModelResponse> {
    return this.runner.run(async requestSignal => {
      const mapped = anthropicMessages(messages);
      const r: unknown = await this.transport.post(`${this.baseUrl}/messages`, { model: this.model, max_tokens: this.maxTokens, ...mapped, tools: anthropicTools(tools) }, this.headers(), requestSignal);
      if (!isRecord(r)) throw invalidResponse();
      if (!Array.isArray(r.content)) throw invalidResponse();
      // Reject max_tokens/unknown termination instead of accepting a partial turn as complete.
      const stopReason = validateResponseStop(r.stop_reason, ANTHROPIC_SUCCESS_STOPS, 'anthropic');
      const textParts: string[] = [];
      const calls: ToolCall[] = [];
      for (const block of r.content) {
        if (!isRecord(block)) throw invalidResponse();
        if (block.type === 'text') {
          if (typeof block.text !== 'string') throw invalidResponse();
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          if (typeof block.id !== 'string' || !block.id) throw new ProviderError('provider-invalid-tool-call', undefined, 'anthropic');
          if (typeof block.name !== 'string' || !block.name) throw new ProviderError('provider-invalid-tool-call', undefined, 'anthropic');
          if (block.input !== undefined && block.input !== null && !isRecord(block.input)) throw new ProviderError('provider-invalid-tool-call', undefined, 'anthropic');
          const args = JSON.stringify(block.input ?? {});
          parseToolArguments(args, 'anthropic');
          calls.push({ id: block.id, name: block.name, arguments: args });
        }
      }
      if (!calls.length && stopReason === 'tool_use') throw invalidResponse();
      if (r.usage !== undefined && r.usage !== null && !isRecord(r.usage)) throw invalidResponse();
      return {
        text: textParts.join('') || undefined, toolCalls: calls, stopReason,
        usage: isRecord(r.usage) ? { inputTokens: tokenCount(r.usage.input_tokens), outputTokens: tokenCount(r.usage.output_tokens) } : undefined,
      };
    }, signal, 'anthropic');
  }
  async stream(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal) {
    if (!this.transport.postStream) throw new ProviderError('anthropic-stream-unavailable', undefined, 'anthropic');
    return this.runner.run(async requestSignal => {
      const mapped = anthropicMessages(messages);
      const chunks = await this.transport.postStream!(`${this.baseUrl}/messages`, { model: this.model, max_tokens: this.maxTokens, ...mapped, tools: anthropicTools(tools), stream: true }, this.headers(), requestSignal);
      return new AnthropicStreamDecoder().decode(chunks);
    }, signal, 'anthropic');
  }
  cancel() { this.runner.cancel(); }
}
