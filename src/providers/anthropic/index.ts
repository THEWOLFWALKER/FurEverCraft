import type { ModelMessage, ModelResponse, ModelProvider, ToolCall } from '../scripted/index.js';
import { FetchTransport, type HttpTransport, ProviderError, parseSSE, type StreamChunk } from '../openai/index.js';

export function anthropicTools(tools: unknown[]): unknown[] {
  return tools.map((tool: any) => tool?.name && tool?.input_schema ? tool : { name: tool.name, description: tool.description, input_schema: tool.parameters ?? { type: 'object', properties: {} } });
}
function anthropicMessages(messages: ModelMessage[]): { system?: string; messages: unknown[] } {
  const system = messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
  const mapped = messages.filter(m => m.role !== 'system').map(m => {
    if (m.role === 'assistant' && m.toolCalls?.length) return { role: 'assistant', content: [...(m.content ? [{ type: 'text', text: String(m.content) }] : []), ...m.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments || '{}') }))] };
    if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] };
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
  });
  return { ...(system ? { system } : {}), messages: mapped };
}

export class AnthropicStreamDecoder {
  async decode(chunks: AsyncIterable<StreamChunk>): Promise<ModelResponse> {
    let text = '', stop = 'unknown', usage: ModelResponse['usage']; const calls = new Map<number, ToolCall>();
    for await (const event of parseSSE(chunks)) {
      const e: any = event; if (e.type === 'error') throw new ProviderError(e.error?.message ?? 'provider-stream-error', undefined, 'anthropic');
      if (e.type === 'content_block_start') { const b = e.content_block; if (b?.type === 'text' && typeof b.text === 'string') text += b.text; if (b?.type === 'tool_use') calls.set(e.index ?? calls.size, { id: b.id, name: b.name, arguments: '' }); }
      else if (e.type === 'content_block_delta') { if (e.delta?.type === 'text_delta') text += e.delta.text ?? ''; if (e.delta?.type === 'input_json_delta') { const call = calls.get(e.index); if (call) call.arguments += e.delta.partial_json ?? ''; } }
      else if (e.type === 'message_delta') { stop = e.delta?.stop_reason ?? stop; if (e.usage) usage = { inputTokens: e.usage.input_tokens ?? usage?.inputTokens ?? 0, outputTokens: e.usage.output_tokens ?? usage?.outputTokens ?? 0 }; }
      else if (e.type === 'message_start' && e.message?.usage) usage = { inputTokens: e.message.usage.input_tokens ?? 0, outputTokens: e.message.usage.output_tokens ?? 0 };
    }
    return { text: text || undefined, toolCalls: [...calls.values()], stopReason: stop, usage };
  }
}

export class AnthropicProvider implements ModelProvider {
  private active?: AbortController;
  constructor(private transport: HttpTransport, private baseUrl: string, private model: string, private key?: string, private version = '2023-06-01') {}
  private headers(): Record<string, string> { return this.key ? { 'x-api-key': this.key, 'anthropic-version': this.version } : { 'anthropic-version': this.version }; }
  async complete(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal): Promise<ModelResponse> {
    const mapped = anthropicMessages(messages); const r: any = await this.transport.post(`${this.baseUrl}/messages`, { model: this.model, max_tokens: 4096, ...mapped, tools: anthropicTools(tools) }, this.headers(), signal);
    return { text: r.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || undefined, toolCalls: r.content?.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) })) ?? [], stopReason: r.stop_reason ?? 'unknown', usage: r.usage ? { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens } : undefined };
  }
  async stream(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal) {
    if (!this.transport.postStream) throw new ProviderError('anthropic-stream-unavailable', undefined, 'anthropic');
    const own = new AbortController(); this.active = own; const relay = () => own.abort(); signal?.addEventListener('abort', relay, { once: true });
    try { const mapped = anthropicMessages(messages); const chunks = await this.transport.postStream(`${this.baseUrl}/messages`, { model: this.model, max_tokens: 4096, ...mapped, tools: anthropicTools(tools), stream: true }, this.headers(), own.signal); return await new AnthropicStreamDecoder().decode(chunks); }
    finally { signal?.removeEventListener('abort', relay); if (this.active === own) this.active = undefined; }
  }
  cancel() { this.active?.abort(); }
}
export { FetchTransport };
