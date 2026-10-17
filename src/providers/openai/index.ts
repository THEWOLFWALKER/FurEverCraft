import type { ModelMessage, ModelResponse, ModelProvider, ToolCall, CanonicalMessage } from '../scripted/index.js';

export type StreamChunk = string | Uint8Array;
export interface HttpTransport {
  post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown>;
  postStream?(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<AsyncIterable<StreamChunk>>;
}
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly provider?: string, readonly retryable = false) { super(message); this.name = 'ProviderError'; }
}

export const MAX_SSE_RECORD_BYTES = 1024 * 1024;
export const MAX_SSE_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_TOOL_ARGUMENT_BYTES = 256 * 1024;
export const REQUEST_DEADLINE_MS = 60_000;

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const jsonText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);
export function parseToolArguments(value: string, provider?: string): unknown {
  if (utf8Bytes(value) > MAX_TOOL_ARGUMENT_BYTES) throw new ProviderError('provider-tool-arguments-limit', undefined, provider);
  try { return JSON.parse(value || '{}'); } catch { throw new ProviderError('provider-incomplete-tool-json', undefined, provider); }
}

export class FetchTransport implements HttpTransport {
  constructor(private readonly options: { allowModelNetwork?: boolean } = {}) {}
  private assertNetworkAllowed() { if (!this.options.allowModelNetwork) throw new ProviderError('model-network-disabled', undefined, undefined, false); }
  private async responseError(r: Response, provider?: string): Promise<never> {
    const retryAfter = r.headers.get('retry-after');
    const error = new ProviderError(`provider-http-${r.status}`, r.status, provider, r.status === 408 || r.status === 429 || r.status >= 500);
    Object.defineProperty(error, 'retryAfterMs', { value: retryAfter ? parseRetryAfter(retryAfter) : undefined });
    throw error;
  }
  async post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal) {
    this.assertNetworkAllowed();
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    if (!r.ok) await this.responseError(r);
    return r.json();
  }
  async postStream(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal) {
    this.assertNetworkAllowed();
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers }, body: JSON.stringify(body), signal });
    if (!r.ok) await this.responseError(r);
    if (!r.body) throw new ProviderError('provider-empty-stream');
    return decodeBytes(r.body, signal);
  }
}

export async function* decodeBytes(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader(); const decoder = new TextDecoder();
  try { while (true) { if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError'); const n = await reader.read(); if (n.done) break; const text = decoder.decode(n.value, { stream: true }); if (text) yield text; } const tail = decoder.decode(); if (tail) yield tail; }
  finally { reader.releaseLock(); }
}

export const SSE_DONE = Symbol('sse-done');
export function parseRetryAfter(value: string): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Parse SSE with one UTF-8 decoder, bounded records, and bounded response bytes. */
export async function* parseSSE(chunks: AsyncIterable<StreamChunk>, options: { includeDone?: boolean } = {}): AsyncGenerator<unknown | typeof SSE_DONE> {
  let buffer = ''; const decoder = new TextDecoder(); let total = 0;
  const emit = async function* (record: string): AsyncGenerator<unknown | typeof SSE_DONE> {
    if (utf8Bytes(record) > MAX_SSE_RECORD_BYTES) throw new ProviderError('provider-sse-record-limit');
    const data = record.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data === '[DONE]') { if (options.includeDone) yield SSE_DONE; return; }
    try { yield JSON.parse(data); } catch { throw new ProviderError('provider-invalid-sse-json'); }
  };
  for await (const chunk of chunks) {
    total += typeof chunk === 'string' ? utf8Bytes(chunk) : chunk.byteLength;
    if (total > MAX_SSE_RESPONSE_BYTES) throw new ProviderError('provider-sse-response-limit');
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let split: number; while ((split = buffer.indexOf('\n\n')) >= 0) { const record = buffer.slice(0, split); buffer = buffer.slice(split + 2); yield* emit(record); }
    if (utf8Bytes(buffer) > MAX_SSE_RECORD_BYTES) throw new ProviderError('provider-sse-record-limit');
  }
  buffer += decoder.decode(); buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (buffer.trim()) throw new ProviderError('provider-stream-truncated');
}

export function openAIMessages(messages: ModelMessage[]): unknown[] {
  return messages.map(message => {
    const content = message.images?.length ? [ ...(typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : (message.content ?? [])), ...message.images.map(image => ({ type: 'image_url', image_url: { url: image.ref, detail: image.detail } })) ] : (typeof message.content === 'string' ? message.content : message.content ?? null);
    if (message.role === 'assistant' && message.toolCalls?.length) return { role: 'assistant', content: content === '' ? null : content, tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) };
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId ?? message.toolResult?.toolCallId ?? '', content: jsonText(message.toolResult?.content ?? message.content), ...(message.toolResult?.isError ? { is_error: true } : {}) };
    return { role: message.role, content, ...(message.termination ? { termination: message.termination } : {}) };
  });
}
export function openAITools(tools: unknown[]): unknown[] { return tools.map((tool: any) => tool?.type === 'function' ? tool : { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters ?? tool.input_schema ?? { type: 'object', properties: {} } } }); }

export class OpenAIStreamDecoder {
  async decode(chunks: AsyncIterable<StreamChunk>): Promise<ModelResponse> {
    let text = '', finish = 'unknown', usage: ModelResponse['usage']; const calls = new Map<number, ToolCall>(); let ended = false;
    for await (const event of parseSSE(chunks, { includeDone: true })) {
      if (event === SSE_DONE) { ended = true; continue; }
      const e: any = event; if (e.error) throw new ProviderError(e.error.message ?? 'provider-stream-error', e.error.code, 'openai', false);
      if (e.usage) usage = { inputTokens: e.usage.prompt_tokens ?? 0, outputTokens: e.usage.completion_tokens ?? 0 };
      const c = e.choices?.[0]; if (!c) continue;
      if (typeof c.delta?.content === 'string') text += c.delta.content; if (c.finish_reason) finish = c.finish_reason;
      for (const part of c.delta?.tool_calls ?? []) { const i = part.index ?? 0; const old = calls.get(i) ?? { id: part.id ?? `call_${i}`, name: '', arguments: '' }; old.id = part.id ?? old.id; old.name = part.function?.name ?? old.name; old.arguments += part.function?.arguments ?? ''; if (utf8Bytes(old.arguments) > MAX_TOOL_ARGUMENT_BYTES) throw new ProviderError('provider-tool-arguments-limit', undefined, 'openai'); calls.set(i, old); }
      if (c.usage) usage = { inputTokens: c.usage.prompt_tokens ?? 0, outputTokens: c.usage.completion_tokens ?? 0 };
    }
    if (!ended) throw new ProviderError('provider-stream-truncated', undefined, 'openai');
    for (const call of calls.values()) parseToolArguments(call.arguments, 'openai');
    if (finish === 'unknown') throw new ProviderError('provider-stream-no-termination', undefined, 'openai');
    return { text: text || undefined, toolCalls: [...calls.values()], stopReason: finish, usage };
  }
}

export type RetryOptions = { sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number };
const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('The operation was aborted', 'AbortError')); }, { once: true }); });
const isRetryable = (error: unknown) => error instanceof ProviderError && error.retryable;

export class OpenAIProvider implements ModelProvider {
  private active?: AbortController; private fence = 0;
  constructor(private transport: HttpTransport, private baseUrl: string, private model: string, private key?: string, private retry: RetryOptions = {}) {}
  private headers(): Record<string, string> { return this.key ? { authorization: `Bearer ${this.key}` } : {}; }
  private async request<T>(fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const own = new AbortController(); const generation = ++this.fence; this.active = own; const relay = () => own.abort(); signal?.addEventListener('abort', relay, { once: true }); const started = (this.retry.now ?? Date.now)(); let attempt = 0;
    try { while (true) { if (own.signal.aborted) throw new DOMException('The operation was aborted', 'AbortError'); try { const result = await fn(own.signal); if (generation !== this.fence) throw new DOMException('The operation was aborted', 'AbortError'); return result; } catch (error) { if (!isRetryable(error) || attempt >= 2 || (this.retry.now ?? Date.now)() - started >= REQUEST_DEADLINE_MS) throw error; const retryAfter = (error as any).retryAfterMs; const delay = Math.min(8000, retryAfter ?? 500 * 2 ** attempt); const remaining = REQUEST_DEADLINE_MS - ((this.retry.now ?? Date.now)() - started); if (remaining <= 0) throw error; await (this.retry.sleep ?? defaultSleep)(Math.min(delay, remaining), own.signal); attempt++; } } }
    finally { signal?.removeEventListener('abort', relay); if (this.active === own) this.active = undefined; }
  }
  async complete(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal): Promise<ModelResponse> { return this.request(async requestSignal => { const r: any = await this.transport.post(`${this.baseUrl}/chat/completions`, { model: this.model, messages: openAIMessages(messages), tools: openAITools(tools) }, this.headers(), requestSignal); const c = r.choices?.[0]; const calls = (c?.message?.tool_calls ?? []).map((x: any) => ({ id: x.id, name: x.function?.name, arguments: x.function?.arguments ?? '' })); calls.forEach((x: ToolCall) => parseToolArguments(x.arguments, 'openai')); return { text: c?.message?.content ?? undefined, toolCalls: calls, stopReason: c?.finish_reason ?? 'unknown', usage: r.usage ? { inputTokens: r.usage.prompt_tokens, outputTokens: r.usage.completion_tokens } : undefined }; }, signal); }
  async stream(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal) { if (!this.transport.postStream) throw new ProviderError('openai-stream-unavailable', undefined, 'openai'); return this.request(async requestSignal => new OpenAIStreamDecoder().decode(await this.transport.postStream!(`${this.baseUrl}/chat/completions`, { model: this.model, messages: openAIMessages(messages), tools: openAITools(tools), stream: true, stream_options: { include_usage: true } }, this.headers(), requestSignal)), signal); }
  cancel() { this.fence++; this.active?.abort(); }
}
