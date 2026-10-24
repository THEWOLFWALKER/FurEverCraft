import type { CanonicalImagePart, CanonicalMessage, CanonicalToolCall, ModelMessage, ModelResponse, ToolCall } from './scripted/index.js';
import { jsonText, parseToolArguments, ProviderError } from './shared.js';

export type ProviderName = 'openai' | 'anthropic';

const toolResultId = (message: ModelMessage) => message.toolCallId ?? message.toolResult?.toolCallId;

/**
 * Validate the canonical contract before either provider serializes it. The check is about
 * pairing/order, not about provider-private blocks: canonical history is the only thing a
 * provider ever sees, so switching providers cannot leak a foreign private payload.
 */
export function validateCanonicalHistory(messages: readonly CanonicalMessage[], provider?: string): void {
  const calls = new Map<string, { index: number; resultSeen: boolean }>();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === 'assistant' && message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        if (!call || typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' || !call.name) throw new ProviderError('provider-invalid-tool-call', undefined, provider);
        if (calls.has(call.id)) throw new ProviderError(`provider-duplicate-tool-call-id:${call.id}`, undefined, provider);
        if (!Number.isInteger(index)) throw new ProviderError('provider-invalid-history', undefined, provider);
        // The empty string is a valid JSON object only when parsed; reject obviously incomplete args.
        parseToolArguments(call.arguments ?? '', provider);
        calls.set(call.id, { index, resultSeen: false });
      }
    }
    if (message.role === 'tool') {
      const id = toolResultId(message);
      if (!id) throw new ProviderError('provider-tool-result-without-call', undefined, provider);
      const call = calls.get(id);
      if (!call) throw new ProviderError(`provider-tool-result-before-call:${id}`, undefined, provider);
      if (call.resultSeen) throw new ProviderError(`provider-duplicate-tool-result:${id}`, undefined, provider);
      call.resultSeen = true;
    }
  }
}

/** True when the final assistant tool calls all have results. */
export function isToolHistoryComplete(messages: readonly CanonicalMessage[]): boolean {
  const seen = new Set<string>();
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls ?? []) { pending.add(call.id); seen.add(call.id); }
    if (message.role === 'tool') { const id = toolResultId(message); if (id) pending.delete(id); }
  }
  return pending.size === 0;
}

const imageToOpenAI = (image: CanonicalImagePart) => ({ type: 'image_url', image_url: { url: image.ref, ...(image.detail ? { detail: image.detail } : {}) } });
const textParts = (message: CanonicalMessage): unknown[] => {
  if (typeof message.content === 'string') return message.content ? [{ type: 'text', text: message.content }] : [];
  return (message.content ?? []).map(part => ({ type: 'text', text: part.text }));
};

/** OpenAI Chat Completions serialization from canonical history. */
export function openAIMessages(messages: ModelMessage[]): unknown[] {
  validateCanonicalHistory(messages, 'openai');
  return messages.map(message => {
    const content = message.images?.length
      ? [...textParts(message), ...message.images.map(imageToOpenAI)]
      : (typeof message.content === 'string' ? message.content : (message.content ?? null));
    if (message.role === 'assistant' && message.toolCalls?.length) {
      // Tool call order is preserved exactly; ids are the canonical ids used for pairing.
      return {
        role: 'assistant',
        content: content === '' || (Array.isArray(content) && content.length === 0) ? null : content,
        tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
      };
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: toolResultId(message) ?? '', content: jsonText(message.toolResult?.content ?? message.content ?? '') };
    }
    return { role: message.role, content };
  });
}

function imageToAnthropic(image: CanonicalImagePart): unknown {
  if (image.ref.startsWith('data:')) {
    const comma = image.ref.indexOf(',');
    const header = comma >= 0 ? image.ref.slice(5, comma) : '';
    const mediaType = image.mediaType ?? (header.split(';')[0] || 'image/png');
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: comma >= 0 ? image.ref.slice(comma + 1) : '' } };
  }
  return { type: 'image', source: { type: 'url', url: image.ref } };
}

/**
 * Anthropic Messages serialization. Consecutive canonical tool results are grouped into one
 * user message, which is the only shape Anthropic accepts for parallel tool_use blocks.
 */
export function anthropicMessages(messages: ModelMessage[]): { system?: string; messages: unknown[] } {
  validateCanonicalHistory(messages, 'anthropic');
  const system = messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text).join('\n')).filter(Boolean).join('\n');
  const mapped: unknown[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const results: unknown[] = [];
      // Consume the contiguous run of tool results, preserving canonical order.
      while (index < messages.length && messages[index]!.role === 'tool') {
        const result = messages[index]!;
        results.push({
          type: 'tool_result',
          tool_use_id: toolResultId(result) ?? '',
          content: typeof result.toolResult?.content === 'string' ? result.toolResult.content : jsonText(result.toolResult?.content ?? result.content ?? ''),
          ...(result.toolResult?.isError ? { is_error: true } : {}),
        });
        index++;
      }
      index--;
      mapped.push({ role: 'user', content: results });
      continue;
    }
    const parts: unknown[] = [...textParts(message).map(part => ({ ...(part as object), type: 'text' as const })), ...(message.images ?? []).map(imageToAnthropic)];
    if (message.role === 'assistant' && message.toolCalls?.length) {
      // tool_use blocks are emitted in assistant order after any text, matching the response shape.
      mapped.push({ role: 'assistant', content: [...parts, ...message.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: parseToolArguments(call.arguments, 'anthropic') }))] });
      continue;
    }
    if (message.role === 'assistant') { mapped.push({ role: 'assistant', content: singleText(parts) }); continue; }
    mapped.push({ role: 'user', content: singleText(parts) });
  }
  return { ...(system ? { system } : {}), messages: mapped };
}

const singleText = (parts: unknown[]) => parts.length === 1 && (parts[0] as { type?: string }).type === 'text' ? (parts[0] as { text: string }).text : parts;

export type ToolCallAdmission = { calls: ToolCall[]; maxParallel: number };
/** Reject duplicate/empty tool call ids and cap one model turn's parallel fan-out. */
export function admitToolCalls(response: Pick<ModelResponse, 'toolCalls'>, maxParallel = 8): ToolCall[] {
  const calls = response.toolCalls ?? [];
  if (!Number.isInteger(maxParallel) || maxParallel < 1) throw new ProviderError('provider-parallel-limit');
  if (calls.length > maxParallel) throw new ProviderError('provider-parallel-limit', undefined, undefined, false);
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.id || !call.name) throw new ProviderError('provider-invalid-tool-call');
    if (ids.has(call.id)) throw new ProviderError(`provider-duplicate-tool-call-id:${call.id}`);
    ids.add(call.id);
    parseToolArguments(call.arguments);
  }
  return calls;
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
};
export function toolFingerprint(call: ToolCall): string {
  let args: unknown = call.arguments;
  try { args = JSON.parse(call.arguments || '{}'); } catch { /* keep raw argument text */ }
  return `${call.name}:${stableJson(args)}`;
}

/**
 * Durable-in-process replay guard for one conversation. Read tools are reused by call id;
 * write tools are reused by semantic fingerprint even if the model invents a new id on a
 * retry, so a write that already executed is never executed twice.
 */
export class ToolExecutionLedger {
  private readonly byId = new Map<string, unknown>();
  private readonly writes = new Map<string, unknown>();
  constructor(private readonly writeTools: ReadonlySet<string> = new Set()) {}
  isWrite(name: string) { return this.writeTools.has(name); }
  reuse(call: ToolCall): { replayed: boolean; result?: unknown } {
    if (this.isWrite(call.name)) {
      const key = toolFingerprint(call);
      if (this.writes.has(key)) return { replayed: true, result: this.writes.get(key) };
    }
    if (this.byId.has(call.id)) return { replayed: true, result: this.byId.get(call.id) };
    return { replayed: false };
  }
  record(call: ToolCall, result: unknown) {
    this.byId.set(call.id, result);
    if (this.isWrite(call.name)) this.writes.set(toolFingerprint(call), result);
  }
  get size() { return this.byId.size; }
}

/** Immutable canonical transcript. Provider-private response data is never stored. */
export class CanonicalHistory {
  private readonly entries: CanonicalMessage[] = [];
  append(message: CanonicalMessage): void {
    const copy = structuredClone(message) as CanonicalMessage;
    // providerSource is provenance only; both serializers ignore it.
    this.entries.push(copy);
    validateCanonicalHistory(this.entries);
  }
  appendUser(text: string, images?: CanonicalImagePart[]): void { this.append({ role: 'user', content: text, ...(images?.length ? { images } : {}) }); }
  appendAssistant(response: ModelResponse, providerSource: string): void {
    this.append({ role: 'assistant', content: response.text ?? '', ...(response.toolCalls?.length ? { toolCalls: structuredClone(response.toolCalls) } : {}), providerSource });
  }
  appendToolResults(calls: readonly ToolCall[], results: ReadonlyMap<string, unknown>): void {
    for (const call of calls) {
      const result = results.get(call.id);
      this.append({ role: 'tool', content: typeof result === 'string' ? result : JSON.stringify(result ?? null), toolResult: { toolCallId: call.id, content: result } });
    }
  }
  snapshot(): CanonicalMessage[] { return structuredClone(this.entries); }
  get length() { return this.entries.length; }
  validate(provider?: string) { validateCanonicalHistory(this.entries, provider); }
  /**
   * Drop old non-tool entries while keeping every assistant tool call and its result. This is
   * the only safe point to trim a provider context.
   */
  trim(maxEntries = 200): void {
    while (this.entries.length > maxEntries) {
      const index = this.entries.findIndex(entry => entry.role !== 'tool' && !(entry.role === 'assistant' && entry.toolCalls?.length));
      if (index < 0) break;
      this.entries.splice(index, 1);
    }
  }
}
