import type { CanonicalImagePart, CanonicalMessage, CanonicalToolCall, ModelMessage, ModelResponse, ToolCall } from './scripted/index.js';
import { jsonText, parseToolArguments, ProviderError, utf8Bytes } from './shared.js';

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

/**
 * Hash of the call's arguments for logical-identity conflict detection. It is never used
 * as a replay key: two independent decisions that happen to send the same text/arguments
 * must both execute (FEC-39).
 */
export function toolArgumentsHash(call: ToolCall): string {
  let args: unknown = call.arguments;
  try { args = JSON.parse(call.arguments || '{}'); } catch { /* keep raw argument text */ }
  return stableJson(args);
}

/** Backwards-compatible name: name + canonical arguments, useful for diagnostics only. */
export function toolFingerprint(call: ToolCall): string {
  return `${call.name}:${toolArgumentsHash(call)}`;
}

export type LogicalToolCallId = {
  sessionId: string;
  decisionId: string;
  responseAttemptId: string;
  toolCallId: string;
};
export type ToolExecutionEntry = { name: string; payloadHash: string; result: unknown };
export type LedgerCheck =
  | { status: 'new' }
  | { status: 'replay'; result: unknown }
  | { status: 'conflict'; name: string; payloadHash: string };

/**
 * Durable-in-process replay guard keyed by the logical call identity
 * (sessionId + decisionId + responseAttemptId + toolCallId).
 *
 * It deliberately does NOT suppress writes by argument fingerprint:
 *   - a new decision with identical text/arguments is a new legitimate action;
 *   - the same logical call with the same name/arguments replays its recorded result;
 *   - the same logical call with a changed name/arguments is a conflict, never a silent
 *     replay of the old result (FEC-39/40);
 *   - a failed call is only replayed for the same logical identity, so a later decision
 *     may legitimately retry it.
 */
export class ToolExecutionLedger {
  private readonly entries = new Map<string, ToolExecutionEntry>();
  static logicalId(parts: LogicalToolCallId): string {
    return JSON.stringify([parts.sessionId, parts.decisionId, parts.responseAttemptId, parts.toolCallId]);
  }
  check(logicalId: string, call: ToolCall): LedgerCheck {
    const entry = this.entries.get(logicalId);
    if (!entry) return { status: 'new' };
    const payloadHash = toolArgumentsHash(call);
    if (entry.name !== call.name || entry.payloadHash !== payloadHash) {
      return { status: 'conflict', name: entry.name, payloadHash: entry.payloadHash };
    }
    return { status: 'replay', result: entry.result };
  }
  record(logicalId: string, call: ToolCall, result: unknown): void {
    this.entries.set(logicalId, { name: call.name, payloadHash: toolArgumentsHash(call), result });
  }
  get size() { return this.entries.size; }
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
      const isError = Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === false);
      this.append({ role: 'tool', content: typeof result === 'string' ? result : JSON.stringify(result ?? null), toolResult: { toolCallId: call.id, content: result, ...(isError ? { isError } : {}) } });
    }
  }
  snapshot(): CanonicalMessage[] { return structuredClone(this.entries); }
  get length() { return this.entries.length; }
  validate(provider?: string) { validateCanonicalHistory(this.entries, provider); }
  /** Drop entries appended at/after `length` (used to roll back a conflicted turn). */
  truncate(length: number): void {
    if (length < 0 || length >= this.entries.length) return;
    this.entries.splice(length);
    validateCanonicalHistory(this.entries);
  }
  /**
   * Trim whole units, never splitting an assistant tool_calls message from its results.
   *
   * A unit is either one non-tool message or an assistant tool-call message plus the
   * contiguous tool-result messages that answer it. The oldest units are removed until both
   * the message count and the serialized UTF-8 budget fit. A single remaining unit that is
   * still over budget is an explicit error: fabricating a truncated tool pair or silently
   * dropping the newest response would corrupt the provider contract (FEC-44).
   */
  trim(maxEntries = 200, maxBytes = 256 * 1024): void {
    validateCanonicalHistory(this.entries);
    while (this.entries.length > maxEntries || this.serializedBytes() > maxBytes) {
      const units = this.units();
      if (units.length <= 1) throw new ProviderError('canonical-history-budget-exceeded');
      const oldest = units[0]!;
      this.entries.splice(0, oldest.length);
    }
    // A trim that leaves a dangling tool result or duplicate id would be worse than an
    // explicit error; validate the post-trim transcript before any provider sees it.
    validateCanonicalHistory(this.entries);
  }
  private serializedBytes(): number {
    return this.entries.reduce((total, entry) => total + utf8Bytes(JSON.stringify(entry)), 0);
  }
  private units(): CanonicalMessage[][] {
    const units: CanonicalMessage[][] = [];
    for (let index = 0; index < this.entries.length; index++) {
      const message = this.entries[index]!;
      if (message.role === 'assistant' && message.toolCalls?.length) {
        const unit: CanonicalMessage[] = [message];
        const ids = new Set(message.toolCalls.map(call => call.id));
        let next = index + 1;
        // Every result answering this assistant turn is part of the same indivisible unit.
        while (next < this.entries.length) {
          const candidate = this.entries[next]!;
          if (candidate.role !== 'tool') break;
          const id = toolResultId(candidate);
          if (id && !ids.has(id)) break;
          unit.push(candidate);
          next++;
        }
        units.push(unit);
        index = next - 1;
      } else {
        units.push([message]);
      }
    }
    return units;
  }
}
