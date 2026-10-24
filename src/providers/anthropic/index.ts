import type { ModelMessage, ModelResponse, ModelProvider, ToolCall } from '../scripted/index.js';
import {
  MAX_TOOL_ARGUMENT_BYTES, parseSSE, parseToolArguments,
  ProviderError, ProviderRequestRunner, type RetryOptions, SSE_DONE, type HttpTransport, type StreamChunk,
} from '../shared.js';
import { anthropicMessages } from '../canonical.js';

export { anthropicMessages } from '../canonical.js';
export { FetchTransport } from '../openai/index.js';

export function anthropicTools(tools: unknown[]): unknown[] { return tools.map((tool: any) => tool?.name && tool?.input_schema ? tool : { name: tool.name, description: tool.description, input_schema: tool.parameters ?? { type: 'object', properties: {} } }); }

export class AnthropicStreamDecoder {
  async decode(chunks: AsyncIterable<StreamChunk>): Promise<ModelResponse> {
    let text = '', stop = 'unknown', usage: ModelResponse['usage']; const calls = new Map<number, ToolCall>(); let ended = false;
    for await (const event of parseSSE(chunks, { includeDone: true })) {
      if (event === SSE_DONE) { ended = true; continue; }
      const e: any = event; if (e.type === 'error') throw new ProviderError(e.error?.message ?? 'provider-stream-error', undefined, 'anthropic', false);
      if (e.type === 'content_block_start') { const b = e.content_block; if (b?.type === 'text' && typeof b.text === 'string') text += b.text; if (b?.type === 'tool_use') calls.set(e.index ?? calls.size, { id: b.id, name: b.name, arguments: '' }); }
      else if (e.type === 'content_block_delta') { if (e.delta?.type === 'text_delta') text += e.delta.text ?? ''; if (e.delta?.type === 'input_json_delta') { const call = calls.get(e.index); if (call) { call.arguments += e.delta.partial_json ?? ''; if (new TextEncoder().encode(call.arguments).byteLength > MAX_TOOL_ARGUMENT_BYTES) throw new ProviderError('provider-tool-arguments-limit', undefined, 'anthropic'); } } }
      else if (e.type === 'message_delta') { stop = e.delta?.stop_reason ?? stop; if (e.usage) usage = { inputTokens: e.usage.input_tokens ?? usage?.inputTokens ?? 0, outputTokens: e.usage.output_tokens ?? usage?.outputTokens ?? 0 }; }
      else if (e.type === 'message_start' && e.message?.usage) usage = { inputTokens: e.message.usage.input_tokens ?? 0, outputTokens: e.message.usage.output_tokens ?? 0 };
      else if (e.type === 'message_stop') ended = true;
    }
    if (!ended) throw new ProviderError('provider-stream-truncated', undefined, 'anthropic');
    for (const call of calls.values()) parseToolArguments(call.arguments, 'anthropic');
    if (stop === 'unknown') throw new ProviderError('provider-stream-no-termination', undefined, 'anthropic');
    return { text: text || undefined, toolCalls: [...calls.values()], stopReason: stop, usage };
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
      const r: any = await this.transport.post(`${this.baseUrl}/messages`, { model: this.model, max_tokens: this.maxTokens, ...mapped, tools: anthropicTools(tools) }, this.headers(), requestSignal);
      const calls = r.content?.filter((block: any) => block.type === 'tool_use').map((block: any) => ({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) })) ?? [];
      calls.forEach((call: ToolCall) => parseToolArguments(call.arguments, 'anthropic'));
      return { text: r.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('') || undefined, toolCalls: calls, stopReason: r.stop_reason ?? 'unknown', usage: r.usage ? { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens } : undefined };
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
