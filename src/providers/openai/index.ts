import type { ModelMessage, ModelResponse, ModelProvider, ToolCall } from '../scripted/index.js';
import {
  decodeBytes, MAX_TOOL_ARGUMENT_BYTES, parseRetryAfter, parseSSE, parseToolArguments,
  ProviderError, ProviderRequestRunner, type RetryOptions, SSE_DONE, utf8Bytes,
  type HttpTransport, type StreamChunk,
} from '../shared.js';
import { openAIMessages } from '../canonical.js';

export {
  decodeBytes, jsonText, MAX_SSE_RECORD_BYTES, MAX_SSE_RESPONSE_BYTES, MAX_TOOL_ARGUMENT_BYTES,
  parseRetryAfter, parseSSE, parseToolArguments, ProviderError, REQUEST_DEADLINE_MS, SSE_DONE,
  SharedProviderRuntime, ProviderRequestRunner,
  type HttpTransport, type RetryOptions, type StreamChunk,
} from '../shared.js';
export { openAIMessages, anthropicMessages, validateCanonicalHistory, admitToolCalls, CanonicalHistory, ToolExecutionLedger, toolFingerprint } from '../canonical.js';
export { ProviderSession } from '../session.js';
export type { ProviderSessionOptions, ProviderSessionRunOptions } from '../session.js';

export class FetchTransport implements HttpTransport {
  constructor(private readonly options: { allowModelNetwork?: boolean; now?: () => number } = {}) {}
  private assertNetworkAllowed() { if (!this.options.allowModelNetwork) throw new ProviderError('model-network-disabled', undefined, undefined, false); }
  private async responseError(r: Response, provider?: string): Promise<never> {
    const retryAfter = r.headers.get('retry-after');
    const error = new ProviderError(`provider-http-${r.status}`, r.status, provider, r.status === 408 || r.status === 429 || r.status >= 500);
    Object.defineProperty(error, 'retryAfterMs', { value: retryAfter ? parseRetryAfter(retryAfter, (this.options.now ?? Date.now)()) : undefined });
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

export class OpenAIProvider implements ModelProvider {
  private readonly runner: ProviderRequestRunner;
  constructor(private transport: HttpTransport, private baseUrl: string, private model: string, private key?: string, retry: RetryOptions = {}) {
    this.runner = new ProviderRequestRunner(retry);
  }
  private headers(): Record<string, string> { return this.key ? { authorization: `Bearer ${this.key}` } : {}; }
  async complete(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal): Promise<ModelResponse> {
    return this.runner.run(async requestSignal => {
      const r: any = await this.transport.post(`${this.baseUrl}/chat/completions`, { model: this.model, messages: openAIMessages(messages), tools: openAITools(tools) }, this.headers(), requestSignal);
      const c = r.choices?.[0]; const calls = (c?.message?.tool_calls ?? []).map((x: any) => ({ id: x.id, name: x.function?.name, arguments: x.function?.arguments ?? '' }));
      calls.forEach((x: ToolCall) => parseToolArguments(x.arguments, 'openai'));
      return { text: c?.message?.content ?? undefined, toolCalls: calls, stopReason: c?.finish_reason ?? 'unknown', usage: r.usage ? { inputTokens: r.usage.prompt_tokens, outputTokens: r.usage.completion_tokens } : undefined };
    }, signal, 'openai');
  }
  async stream(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal) {
    if (!this.transport.postStream) throw new ProviderError('openai-stream-unavailable', undefined, 'openai');
    return this.runner.run(async requestSignal => new OpenAIStreamDecoder().decode(await this.transport.postStream!(`${this.baseUrl}/chat/completions`, { model: this.model, messages: openAIMessages(messages), tools: openAITools(tools), stream: true, stream_options: { include_usage: true } }, this.headers(), requestSignal)), signal, 'openai');
  }
  cancel() { this.runner.cancel(); }
}
