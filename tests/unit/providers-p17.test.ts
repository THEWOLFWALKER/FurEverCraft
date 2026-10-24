import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelMessage, ModelResponse } from '../../src/providers/scripted/index.js';
import { OpenAIProvider, openAIMessages, type HttpTransport } from '../../src/providers/openai/index.js';
import { AnthropicProvider, anthropicMessages } from '../../src/providers/anthropic/index.js';
import { ProviderSession } from '../../src/providers/session.js';
import { ToolExecutionLedger } from '../../src/providers/canonical.js';
import { ProviderError, SharedProviderRuntime } from '../../src/providers/shared.js';
import { createConfiguredProvider } from '../../src/providers/index.js';
import { UnavailableProvider } from '../../src/providers/scripted/index.js';

const fixture = <T>(name: string): T => JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/providers', name), 'utf8')) as T;

type RecordedRequest = { url: string; body: any; headers: Record<string, string>; signal?: AbortSignal };
class RecordingTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = [];
  constructor(private readonly handler: (body: any, index: number) => unknown = () => ({})) {}
  async post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal) {
    this.requests.push({ url, body, headers, signal });
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    return this.handler(body, this.requests.length - 1);
  }
}
const completion = (text = 'ok', toolCalls: Array<{ id: string; name: string; arguments: string }> = []): unknown => ({ choices: [{ message: { content: text, tool_calls: toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }] });

describe('P17 canonical history and provider conversions', () => {
  it('uses the offline image fixture for both provider-native image blocks', () => {
    const data = fixture<{ history: ModelMessage[]; openai: unknown; anthropic: unknown }>('canonical-images.json');
    expect(openAIMessages(data.history)).toEqual((data.openai as { messages: unknown[] }).messages);
    expect(anthropicMessages(data.history)).toEqual(data.anthropic);
  });

  it('keeps parallel tool call order and pairs grouped Anthropic results', () => {
    const history: ModelMessage[] = [
      { role: 'user', content: 'check two targets' },
      { role: 'assistant', content: 'working', toolCalls: [
        { id: 'call-b', name: 'inspect', arguments: '{"target":"b"}' },
        { id: 'call-a', name: 'inspect', arguments: '{"target":"a"}' },
      ] },
      { role: 'tool', toolCallId: 'call-b', content: '{"b":true}' },
      { role: 'tool', toolCallId: 'call-a', content: '{"a":true}' },
    ];
    const openai = openAIMessages(history) as any[];
    expect(openai[1].tool_calls.map((call: any) => call.id)).toEqual(['call-b', 'call-a']);
    expect(openai.slice(2).map((message: any) => message.tool_call_id)).toEqual(['call-b', 'call-a']);
    const anthropic = anthropicMessages(history) as any;
    expect(anthropic.messages[1].content.filter((block: any) => block.type === 'tool_use').map((block: any) => block.id)).toEqual(['call-b', 'call-a']);
    expect(anthropic.messages[2]).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-b', content: '{"b":true}' },
      { type: 'tool_result', tool_use_id: 'call-a', content: '{"a":true}' },
    ] });
  });

  it('rejects duplicate ids, unpaired results, and incomplete canonical tool arguments', () => {
    expect(() => openAIMessages([{ role: 'assistant', toolCalls: [{ id: 'x', name: 'read', arguments: '{}' }, { id: 'x', name: 'read', arguments: '{}' }] }])).toThrow('provider-duplicate-tool-call-id');
    expect(() => anthropicMessages([{ role: 'tool', toolCallId: 'missing', content: 'x' }])).toThrow('provider-tool-result-before-call');
    expect(() => openAIMessages([{ role: 'assistant', toolCalls: [{ id: 'x', name: 'read', arguments: '{"half":' }] }])).toThrow('provider-incomplete-tool-json');
  });
});

describe('P17 shared bounded request runtime', () => {
  it('records the actual OpenAI and Anthropic requests and preserves canonical pairing after a switch', async () => {
    const openaiTransport = new RecordingTransport((_body, index) => index === 0
      ? completion(null as unknown as string, [{ id: 'w1', name: 'place_one', arguments: '{"x":1,"y":2}' }])
      : completion('openai-done'));
    const anthropicTransport = new RecordingTransport(() => ({ content: [{ type: 'text', text: 'anthropic-done' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 3 } }));
    const openai = new OpenAIProvider(openaiTransport, 'http://offline/openai', 'o-model');
    const anthropic = new AnthropicProvider(anthropicTransport, 'http://offline/anthropic', 'a-model');
    let executions = 0;
    const session = new ProviderSession({
      providers: { openai, anthropic }, initialProvider: 'openai',
      tools: [{ name: 'place_one', description: 'place', parameters: { type: 'object' } }],
      writeTools: ['place_one'],
      execute: async call => { executions++; return { accepted: true, call: call.id }; },
    });
    const first = await session.run('first');
    expect(first.response.text).toBe('openai-done');
    expect(executions).toBe(1);
    expect(openaiTransport.requests[1]!.body.messages[1].tool_calls[0].id).toBe('w1');

    session.switchProvider('anthropic');
    const second = await session.run('second');
    expect(second.response.text).toBe('anthropic-done');
    // The canonical tool result crossed the provider boundary; no OpenAI-private block is sent.
    const sent = anthropicTransport.requests[0]!.body;
    expect(sent.messages).toContainEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: JSON.stringify({ accepted: true, call: 'w1' }) }] });
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'second' });
    expect(JSON.stringify(sent)).not.toContain('providerSource');
  });

  it('never executes a write tool twice when the model retries it with a different id', async () => {
    const transport = new RecordingTransport((_body, index) => index === 0
      ? completion(null as unknown as string, [{ id: 'write-a', name: 'place_one', arguments: '{"x":1,"y":2}' }])
      : index === 1
        ? completion(null as unknown as string, [{ id: 'write-b', name: 'place_one', arguments: '{ "y": 2, "x": 1 }' }])
        : completion('finished'));
    const provider = new OpenAIProvider(transport, 'http://offline', 'model');
    let executions = 0;
    const session = new ProviderSession({
      providers: { openai: provider }, tools: [],
      writeTools: ['place_one'],
      execute: async () => { executions++; return { accepted: true }; },
    });
    const result = await session.run('place it');
    expect(executions).toBe(1);
    expect(result.turns[0]!.executed).toEqual(['write-a']);
    expect(result.turns[1]!.replayed).toEqual(['write-b']);
    expect(result.turns[1]!.executed).toEqual([]);
  });

  it('shares the retry budget between OpenAI and Anthropic and honors Retry-After', async () => {
    let openaiAttempts = 0, anthropicAttempts = 0; const waits: number[] = [];
    const shared = new SharedProviderRuntime({ maxRetries: 1, maxConcurrent: 2, maxQueued: 4 });
    const failingOpenAI: HttpTransport = { async post() { openaiAttempts++; const error = new ProviderError('busy', 429, 'openai', true); (error as any).retryAfterMs = 700; throw error; } };
    const failingAnthropic: HttpTransport = { async post() { anthropicAttempts++; throw new ProviderError('busy', 503, 'anthropic', true); } };
    const openai = new OpenAIProvider(failingOpenAI, 'http://offline', 'm', undefined, { shared, sleep: async ms => { waits.push(ms); } });
    const anthropic = new AnthropicProvider(failingAnthropic, 'http://offline', 'm', undefined, '2023-06-01', { shared, sleep: async ms => { waits.push(ms); } });
    await expect(openai.complete([], [])).rejects.toThrow('busy');
    await expect(anthropic.complete([], [])).rejects.toThrow('busy');
    expect(openaiAttempts).toBe(2); // one retry allowed
    expect(anthropicAttempts).toBe(1); // shared budget exhausted
    expect(waits).toEqual([700]);
    expect(shared.sharedRetriesUsed).toBe(1);
  });

  it('caps the queue and aborts queued/in-flight work on cancellation', async () => {
    const runtime = new SharedProviderRuntime({ maxConcurrent: 1, maxQueued: 1, maxRetries: 0 });
    const pending: Array<(value: unknown) => void> = [];
    const transport: HttpTransport = { post() { return new Promise(resolve => pending.push(resolve)); } };
    const provider = new OpenAIProvider(transport, 'http://offline', 'm', undefined, { shared: runtime });
    const first = provider.complete([], []);
    expect(runtime.inFlight).toBe(1);
    const second = provider.complete([], []);
    await Promise.resolve();
    expect(runtime.queued).toBe(1);
    await expect(provider.complete([], [])).rejects.toThrow('provider-queue-full');
    provider.cancel();
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    // Resolve the abandoned transport so the test leaves no dangling promise.
    pending.forEach(resolve => resolve(completion()));
  });

  it('enforces the deadline and rejects malformed/truncated streams', async () => {
    const stuck: HttpTransport = { post: () => new Promise(() => undefined) };
    await expect(new OpenAIProvider(stuck, 'http://offline', 'm', undefined, { timeoutMs: 20 }).complete([], [])).rejects.toThrow('provider-request-deadline');

    const malformed: HttpTransport = { async post() { return {}; }, async postStream() { return (async function* () { yield 'data: {not-json}\n\n'; })(); } };
    await expect(new OpenAIProvider(malformed, 'http://offline', 'm').stream([], [])).rejects.toThrow('provider-invalid-sse-json');

    const truncatedAnthropic: HttpTransport = { async post() { return {}; }, async postStream() { return (async function* () { yield 'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'; })(); } };
    await expect(new AnthropicProvider(truncatedAnthropic, 'http://offline', 'm').stream([], [])).rejects.toThrow('provider-stream-truncated');
  });

  it('refuses a provider switch with an open tool turn and fences goal revision changes', async () => {
    const transport = new RecordingTransport(() => completion('ok'));
    const provider = new OpenAIProvider(transport, 'http://offline', 'm');
    const session = new ProviderSession({ providers: { openai: provider, anthropic: provider }, initialProvider: 'openai', execute: async () => ({}) });
    session.history.append({ role: 'assistant', content: '', toolCalls: [{ id: 'open', name: 'read', arguments: '{}' }] });
    expect(() => session.switchProvider('anthropic')).toThrow('provider-switch-tool-turn-open');

    const clean = new ProviderSession({ providers: { openai: provider }, initialProvider: 'openai', execute: async () => ({}) });
    await expect(clean.run('go', { goalId: 'g', expectedRevision: 1, getGoalRevision: () => 2 })).rejects.toThrow('goal-revision-conflict:2');
    expect(transport.requests).toHaveLength(0);
  });

  it('gates configured providers from factory options to the transport', async () => {
    const disabled = createConfiguredProvider({ provider: 'openai', allowModelNetwork: false, apiKey: 'sk-secret' });
    expect(disabled.provider).toBeInstanceOf(UnavailableProvider);
    expect(disabled).toMatchObject({ configured: false, networkEnabled: false, reason: 'model-network-disabled' });
    const missingKey = createConfiguredProvider({ provider: 'anthropic', allowModelNetwork: true });
    expect(missingKey.provider).toBeInstanceOf(UnavailableProvider);
    expect(missingKey.configured).toBe(false);
    const injected = new RecordingTransport(() => ({}));
    const fixture = createConfiguredProvider({ provider: 'openai', allowModelNetwork: false, transport: injected, model: 'fixture' });
    expect(fixture).toMatchObject({ configured: true, networkEnabled: false });
    expect(fixture.provider).toBeInstanceOf(OpenAIProvider);
    const live = createConfiguredProvider({ provider: 'anthropic', allowModelNetwork: true, apiKey: 'sk-secret' });
    expect(live).toMatchObject({ configured: true, networkEnabled: true });
    expect(live.provider).toBeInstanceOf(AnthropicProvider);
    // No request is issued by construction; the live transport is only ever reached through complete().
    expect(injected.requests).toHaveLength(0);
  });

  it('deduplicates write fingerprints only for writes', () => {
    const ledger = new ToolExecutionLedger(new Set(['place_one']));
    ledger.record({ id: 'a', name: 'place_one', arguments: '{"x":1}' }, { ok: true });
    expect(ledger.reuse({ id: 'b', name: 'place_one', arguments: '{ "x" : 1 }' })).toEqual({ replayed: true, result: { ok: true } });
    const readLedger = new ToolExecutionLedger();
    readLedger.record({ id: 'r', name: 'get_state', arguments: '{}' }, { ok: true });
    expect(readLedger.reuse({ id: 'other', name: 'get_state', arguments: '{}' }).replayed).toBe(false);
  });
});
