import type { ModelMessage, ModelResponse, ModelProvider, ToolCall } from '../scripted/index.js';
import {
  decodeBytes, MAX_TOOL_ARGUMENT_BYTES, normalizeToolArguments, parseRetryAfter, parseSSE, parseToolArguments, tokenCount,
  ProviderError, ProviderRequestRunner, type RetryOptions, SSE_DONE, utf8Bytes, validateResponseStop,
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

/** Terminal stop reasons that represent a complete Chat Completions answer. */
const OPENAI_SUCCESS_STOPS: ReadonlySet<string> = new Set(['stop', 'tool_calls', 'function_call']);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const invalidResponse = () => new ProviderError('provider-invalid-response', undefined, 'openai');

export class OpenAIStreamDecoder {
  async decode(chunks: AsyncIterable<StreamChunk>): Promise<ModelResponse> {
    let text = '', finish = 'unknown', usage: ModelResponse['usage']; const calls = new Map<number, ToolCall>(); let ended = false;
    for await (const event of parseSSE(chunks, { includeDone: true })) {
      if (event === SSE_DONE) { ended = true; continue; }
      if (!isRecord(event)) throw invalidResponse();
      const e = event as any; if (e.error) throw new ProviderError(e.error.message ?? 'provider-stream-error', e.error.code, 'openai', false);
      if (e.usage !== undefined && !isRecord(e.usage)) throw invalidResponse();
      if (e.usage) usage = { inputTokens: tokenCount(e.usage.prompt_tokens), outputTokens: tokenCount(e.usage.completion_tokens) };
      if (e.choices !== undefined && !Array.isArray(e.choices)) throw invalidResponse();
      const c = e.choices?.[0]; if (!c) continue;
      if (!isRecord(c)) throw invalidResponse();
      if (c.delta !== undefined && !isRecord(c.delta)) throw invalidResponse();
      if (typeof c.delta?.content === 'string') text += c.delta.content;
      if (c.finish_reason !== undefined && c.finish_reason !== null) {
        if (typeof c.finish_reason !== 'string' || !c.finish_reason) throw invalidResponse();
        finish = c.finish_reason;
      }
      if (c.delta?.tool_calls !== undefined && c.delta.tool_calls !== null) {
        if (!Array.isArray(c.delta.tool_calls)) throw invalidResponse();
        for (const part of c.delta.tool_calls) {
          if (!isRecord(part) || (part.function !== undefined && !isRecord(part.function))) throw invalidResponse();
          const i = Number.isInteger(part.index) ? part.index as number : 0;
          const old = calls.get(i) ?? { id: '', name: '', arguments: '' };
          if (part.id !== undefined) {
            if (typeof part.id !== 'string' || !part.id) throw new ProviderError('provider-invalid-tool-call', undefined, 'openai');
            old.id = part.id;
          }
          const fn = part.function as Record<string, unknown> | undefined;
          if (fn?.name !== undefined) {
            if (typeof fn.name !== 'string' || !fn.name) throw new ProviderError('provider-invalid-tool-call', undefined, 'openai');
            old.name = fn.name;
          }
          if (fn?.arguments !== undefined) {
            if (typeof fn.arguments !== 'string') throw new ProviderError('provider-invalid-tool-call', undefined, 'openai');
            old.arguments += fn.arguments;
            if (utf8Bytes(old.arguments) > MAX_TOOL_ARGUMENT_BYTES) throw new ProviderError('provider-tool-arguments-limit', undefined, 'openai');
          }
          calls.set(i, old);
        }
      }
      if (c.usage !== undefined) {
        if (!isRecord(c.usage)) throw invalidResponse();
        usage = { inputTokens: tokenCount(c.usage.prompt_tokens), outputTokens: tokenCount(c.usage.completion_tokens) };
      }
    }
    if (!ended) throw new ProviderError('provider-stream-truncated', undefined, 'openai');
    if (finish === 'unknown') throw new ProviderError('provider-stream-no-termination', undefined, 'openai');
    // Truncation is reported before partial tool arguments are parsed, so callers see the real cause.
    validateResponseStop(finish, OPENAI_SUCCESS_STOPS, 'openai');
    const toolCalls: ToolCall[] = [];
    for (const call of calls.values()) {
      // A streamed tool call without a provider-assigned id is malformed; never fabricate one.
      if (typeof call.id !== 'string' || !call.id) throw new ProviderError('provider-invalid-tool-call', undefined, 'openai');
      if (typeof call.name !== 'string' || !call.name) throw new ProviderError('provider-invalid-tool-call', undefined, 'openai');
      toolCalls.push({ id: call.id, name: call.name, arguments: normalizeToolArguments(call.arguments, 'openai') });
    }
    if (!toolCalls.length && (finish === 'tool_calls' || finish === 'function_call')) throw invalidResponse();
    return { text: text || undefined, toolCalls, stopReason: finish, usage };
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
      const r: unknown = await this.transport.post(`${this.baseUrl}/chat/completions`, { model: this.model, messages: openAIMessages(messages), tools: openAITools(tools) }, this.headers(), requestSignal);
      if (!isRecord(r)) throw invalidResponse();
      if (!Array.isArray(r.choices) || r.choices.length === 0) throw invalidResponse();
      const c = r.choices[0];
      if (!isRecord(c)) throw invalidResponse();
      // Reject truncated/unknown termination instead of returning a silent successful turn.
      const stopReason = validateResponseStop(c.finish_reason, OPENAI_SUCCESS_STOPS, 'openai');
      const message = c.message;
      if (!isRecord(message)) throw invalidResponse();
      if (message.content !== undefined && message.content !== null && typeof message.content !== 'string') throw invalidResponse();
      if (message.tool_calls !== undefined && message.tool_calls !== null && !Array.isArray(message.tool_calls)) throw invalidResponse();
      const calls: ToolCall[] = (message.tool_calls ?? []).map((entry: unknown) => {
        if (!isRecord(entry) || !isRecord(entry.function)) throw invalidResponse();
        if (typeof entry.id !== 'string' || !entry.id) throw new ProviderError('provider-invalid-tool-call', undefined, 'openai');
        if (typeof entry.function.name !== 'string' || !entry.function.name) throw new ProviderError('provider-invalid-tool-call', undefined, 'openai');
        return { id: entry.id, name: entry.function.name, arguments: normalizeToolArguments(entry.function.arguments, 'openai') };
      });
      for (const call of calls) parseToolArguments(call.arguments, 'openai');
      if (!calls.length && (stopReason === 'tool_calls' || stopReason === 'function_call')) throw invalidResponse();
      if (r.usage !== undefined && r.usage !== null && !isRecord(r.usage)) throw invalidResponse();
      return {
        text: typeof message.content === 'string' ? message.content : undefined,
        toolCalls: calls, stopReason,
        usage: isRecord(r.usage) ? { inputTokens: tokenCount(r.usage.prompt_tokens), outputTokens: tokenCount(r.usage.completion_tokens) } : undefined,
      };
    }, signal, 'openai');
  }
  async stream(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal) {
    if (!this.transport.postStream) throw new ProviderError('openai-stream-unavailable', undefined, 'openai');
    return this.runner.run(async requestSignal => new OpenAIStreamDecoder().decode(await this.transport.postStream!(`${this.baseUrl}/chat/completions`, { model: this.model, messages: openAIMessages(messages), tools: openAITools(tools), stream: true, stream_options: { include_usage: true } }, this.headers(), requestSignal)), signal, 'openai');
  }
  cancel() { this.runner.cancel(); }
}
