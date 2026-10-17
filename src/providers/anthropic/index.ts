import type { ModelMessage, ModelResponse, ModelProvider, ToolCall } from '../scripted/index.js';
import { FetchTransport, type HttpTransport, ProviderError, parseSSE, parseToolArguments, type StreamChunk, MAX_TOOL_ARGUMENT_BYTES, REQUEST_DEADLINE_MS, RetryOptions, SSE_DONE } from '../openai/index.js';

export function anthropicTools(tools: unknown[]): unknown[] { return tools.map((tool: any) => tool?.name && tool?.input_schema ? tool : { name: tool.name, description: tool.description, input_schema: tool.parameters ?? { type: 'object', properties: {} } }); }
export function anthropicMessages(messages: ModelMessage[]): { system?: string; messages: unknown[] } {
  const system = messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
  const mapped = messages.filter(m => m.role !== 'system').map(m => {
    const textParts: any[] = typeof m.content === 'string' ? (m.content ? [{ type: 'text', text: m.content }] : []) : (m.content ?? []) as any[];
    const parts: any[] = [...textParts, ...(m.images ?? []).map(image => ({ type: 'image', source: image.ref.startsWith('data:') ? { type: 'base64', media_type: image.mediaType ?? 'image/png', data: image.ref.slice(image.ref.indexOf(',') + 1) } : { type: 'url', url: image.ref } }))];
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content = [...parts, ...m.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: parseToolArguments(call.arguments, 'anthropic') }))];
      return { role: 'assistant', content, ...(m.termination ? { stop_reason: m.termination } : {}) };
    }
    if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId ?? m.toolResult?.toolCallId ?? '', content: typeof m.toolResult?.content === 'string' ? m.toolResult.content : JSON.stringify(m.toolResult?.content ?? m.content), ...(m.toolResult?.isError ? { is_error: true } : {}) }] };
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts, ...(m.termination ? { stop_reason: m.termination } : {}) };
  });
  return { ...(system ? { system } : {}), messages: mapped };
}

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
  private active?: AbortController; private fence = 0;
  constructor(private transport: HttpTransport, private baseUrl: string, private model: string, private key?: string, private version = '2023-06-01', private retry: RetryOptions = {}) {}
  private headers(): Record<string, string> { return this.key ? { 'x-api-key': this.key, 'anthropic-version': this.version } : { 'anthropic-version': this.version }; }
  private async request<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const own = new AbortController(); const generation = ++this.fence; this.active = own; const relay = () => own.abort(); signal?.addEventListener('abort', relay, { once: true }); const started = (this.retry.now ?? Date.now)(); let attempt = 0;
    const deadline = setTimeout(() => own.abort(), REQUEST_DEADLINE_MS);
    try { while (true) { if (own.signal.aborted) throw new ProviderError('provider-request-deadline', undefined, 'anthropic', false); try { const result = await fn(own.signal); if (generation !== this.fence) throw new DOMException('The operation was aborted', 'AbortError'); return result; } catch (error) { if (own.signal.aborted && (this.retry.now ?? Date.now)() - started >= REQUEST_DEADLINE_MS) throw new ProviderError('provider-request-deadline', undefined, 'anthropic', false); if (!(error instanceof ProviderError) || !error.retryable || attempt >= 2 || (this.retry.now ?? Date.now)() - started >= REQUEST_DEADLINE_MS) throw error; const retryAfter = (error as any).retryAfterMs; const delay = Math.min(8000, retryAfter ?? 500 * 2 ** attempt); const remaining = REQUEST_DEADLINE_MS - ((this.retry.now ?? Date.now)() - started); if (remaining <= 0) throw error; await (this.retry.sleep ?? ((ms, s) => new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, ms); s?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('The operation was aborted', 'AbortError')); }, { once: true }); })))(Math.min(delay, remaining), own.signal); attempt++; } } }
    finally { clearTimeout(deadline); signal?.removeEventListener('abort', relay); if (this.active === own) this.active = undefined; }
  }
  async complete(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal): Promise<ModelResponse> { return this.request(async requestSignal => { const mapped = anthropicMessages(messages); const r: any = await this.transport.post(`${this.baseUrl}/messages`, { model: this.model, max_tokens: 4096, ...mapped, tools: anthropicTools(tools) }, this.headers(), requestSignal); const calls = r.content?.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) })) ?? []; calls.forEach((x: ToolCall) => parseToolArguments(x.arguments, 'anthropic')); return { text: r.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || undefined, toolCalls: calls, stopReason: r.stop_reason ?? 'unknown', usage: r.usage ? { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens } : undefined }; }, signal); }
  async stream(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal) { if (!this.transport.postStream) throw new ProviderError('anthropic-stream-unavailable', undefined, 'anthropic'); return this.request(async requestSignal => { const mapped = anthropicMessages(messages); const chunks = await this.transport.postStream!(`${this.baseUrl}/messages`, { model: this.model, max_tokens: 4096, ...mapped, tools: anthropicTools(tools), stream: true }, this.headers(), requestSignal); return new AnthropicStreamDecoder().decode(chunks); }, signal); }
  cancel() { this.fence++; this.active?.abort(); }
}
export { FetchTransport };
