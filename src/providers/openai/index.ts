import type { ModelMessage, ModelResponse, ModelProvider, ToolCall } from '../scripted/index.js';

export type StreamChunk = string | Uint8Array;
export interface HttpTransport {
  post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown>;
  postStream?(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<AsyncIterable<StreamChunk>>;
}
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly provider?: string, readonly retryable = false) { super(message); this.name = 'ProviderError'; }
}
export class FetchTransport implements HttpTransport {
  constructor(private readonly options: { allowModelNetwork?: boolean } = {}) {}
  private assertNetworkAllowed() { if (!this.options.allowModelNetwork) throw new ProviderError('model-network-disabled', undefined, undefined, false); }
  async post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal) {
    this.assertNetworkAllowed();
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    if (!r.ok) throw new ProviderError(`provider-http-${r.status}`, r.status, undefined, r.status === 408 || r.status === 429 || r.status >= 500);
    return r.json();
  }
  async postStream(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal) {
    this.assertNetworkAllowed();
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers }, body: JSON.stringify(body), signal });
    if (!r.ok) throw new ProviderError(`provider-http-${r.status}`, r.status, undefined, r.status === 408 || r.status === 429 || r.status >= 500);
    if (!r.body) throw new ProviderError('provider-empty-stream');
    return decodeBytes(r.body, signal);
  }
}

export async function* decodeBytes(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader(); const decoder = new TextDecoder();
  try {
    while (true) { if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError'); const n = await reader.read(); if (n.done) break; const text = decoder.decode(n.value, { stream: true }); if (text) yield text; }
    const tail = decoder.decode(); if (tail) yield tail;
  } finally { reader.releaseLock(); }
}

/** Parse SSE using one UTF-8 decoder for the entire byte stream. */
export async function* parseSSE(chunks: AsyncIterable<StreamChunk>): AsyncGenerator<unknown> {
  let buffer = ''; const decoder = new TextDecoder();
  const emit = async function* (record: string): AsyncGenerator<unknown> {
    const data = record.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    try { yield JSON.parse(data); } catch { throw new ProviderError('provider-invalid-sse-json'); }
  };
  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let split: number;
    while ((split = buffer.indexOf('\n\n')) >= 0) { const record = buffer.slice(0, split); buffer = buffer.slice(split + 2); yield* emit(record); }
  }
  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (buffer.trim()) yield* emit(buffer);
}

export function openAIMessages(messages: ModelMessage[]): unknown[] {
  return messages.map(message => {
    if (message.role === 'assistant' && message.toolCalls?.length) return {
      role: 'assistant', content: message.content || null,
      tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
    };
    if (message.role === 'tool') return {
      role: 'tool', tool_call_id: message.toolCallId ?? '', content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    };
    return { role: message.role, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) };
  });
}

export function openAITools(tools: unknown[]): unknown[] {
  return tools.map((tool: any) => tool?.type === 'function' ? tool : { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters ?? { type: 'object', properties: {} } } });
}

export class OpenAIStreamDecoder {
  async decode(chunks: AsyncIterable<StreamChunk>): Promise<ModelResponse> {
    let text = '', finish = 'unknown', usage: ModelResponse['usage']; const calls = new Map<number, ToolCall>();
    for await (const event of parseSSE(chunks)) {
      const e: any = event; if (e.error) throw new ProviderError(e.error.message ?? 'provider-stream-error', e.error.code, 'openai');
      if (e.usage) usage = { inputTokens: e.usage.prompt_tokens, outputTokens: e.usage.completion_tokens };
      const c = e.choices?.[0]; if (!c) continue;
      if (typeof c.delta?.content === 'string') text += c.delta.content; if (c.finish_reason) finish = c.finish_reason;
      for (const part of c.delta?.tool_calls ?? []) { const i = part.index ?? 0; const old = calls.get(i) ?? { id: part.id ?? `call_${i}`, name: '', arguments: '' }; old.id = part.id ?? old.id; old.name = part.function?.name ?? old.name; old.arguments += part.function?.arguments ?? ''; calls.set(i, old); }
      if (c.usage) usage = { inputTokens: c.usage.prompt_tokens, outputTokens: c.usage.completion_tokens };
    }
    return { text: text || undefined, toolCalls: [...calls.values()], stopReason: finish, usage };
  }
}

export class OpenAIProvider implements ModelProvider {
  private active?: AbortController;
  constructor(private transport: HttpTransport, private baseUrl: string, private model: string, private key?: string) {}
  async complete(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal): Promise<ModelResponse> {
    const r: any = await this.transport.post(`${this.baseUrl}/chat/completions`, { model: this.model, messages: openAIMessages(messages), tools: openAITools(tools) }, this.key ? { authorization: `Bearer ${this.key}` } : {}, signal);
    const c = r.choices?.[0]; return { text: c?.message?.content ?? undefined, toolCalls: (c?.message?.tool_calls ?? []).map((x: any) => ({ id: x.id, name: x.function?.name, arguments: x.function?.arguments ?? '' })), stopReason: c?.finish_reason ?? 'unknown', usage: r.usage ? { inputTokens: r.usage.prompt_tokens, outputTokens: r.usage.completion_tokens } : undefined };
  }
  async stream(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal) {
    if (!this.transport.postStream) throw new ProviderError('openai-stream-unavailable', undefined, 'openai');
    const own = new AbortController(); this.active = own; const relay = () => own.abort(); signal?.addEventListener('abort', relay, { once: true });
    try { const chunks = await this.transport.postStream(`${this.baseUrl}/chat/completions`, { model: this.model, messages: openAIMessages(messages), tools: openAITools(tools), stream: true, stream_options: { include_usage: true } }, this.key ? { authorization: `Bearer ${this.key}` } : {}, own.signal); return await new OpenAIStreamDecoder().decode(chunks); }
    finally { signal?.removeEventListener('abort', relay); if (this.active === own) this.active = undefined; }
  }
  cancel() { this.active?.abort(); }
}
