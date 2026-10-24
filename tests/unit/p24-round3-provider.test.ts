import { describe, expect, it } from 'vitest';
import type { ModelProvider, ModelResponse } from '../../src/providers/scripted/index.js';
import { OpenAIProvider, type HttpTransport } from '../../src/providers/openai/index.js';
import { AnthropicProvider } from '../../src/providers/anthropic/index.js';
import { ProviderSession } from '../../src/providers/session.js';
import { CanonicalHistory, isToolHistoryComplete, validateCanonicalHistory } from '../../src/providers/canonical.js';
import { ProviderError, SharedProviderRuntime } from '../../src/providers/shared.js';
import { createRuntime } from '../../src/execution/factory.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ManualClock } from '../../src/contracts/index.js';

type RecordedRequest = { url: string; body: any; headers: Record<string, string> };

class SequenceTransport implements HttpTransport {
  readonly requests: RecordedRequest[] = [];
  constructor(private readonly responses: unknown[] | ((body: any, index: number) => unknown)) {}
  async post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal) {
    this.requests.push({ url, body, headers });
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    const index = this.requests.length - 1;
    if (typeof this.responses === 'function') return this.responses(body, index);
    return this.responses[index] ?? this.responses[this.responses.length - 1];
  }
}

const openAIText = (text: string, finish = 'stop') => ({ choices: [{ message: { content: text }, finish_reason: finish }] });
const openAIToolCalls = (calls: Array<{ id?: string; name?: string; args?: string; omitArgs?: boolean }>, finish = 'tool_calls') => ({
  choices: [{
    message: {
      content: null,
      tool_calls: calls.map(call => ({
        ...(call.id === undefined ? {} : { id: call.id }),
        type: 'function',
        function: {
          ...(call.name === undefined ? {} : { name: call.name }),
          ...(call.omitArgs ? {} : { arguments: call.args ?? '{}' }),
        },
      })),
    },
    finish_reason: finish,
  }],
});
const anthropicText = (text: string, stopReason = 'end_turn') => ({ content: [{ type: 'text', text }], stop_reason: stopReason });

async function* chunks(values: string[]) { for (const value of values) yield value; }

describe('Round 3 — malformed and truncated provider responses are not terminal success', () => {
  it('validates non-streaming OpenAI/Anthropic response shape', async () => {
    await expect(new OpenAIProvider({ async post() { return {}; } }, 'http://offline', 'm').complete([], [])).rejects.toThrow('provider-invalid-response');
    await expect(new OpenAIProvider(new SequenceTransport([{ choices: [] }]), 'http://offline', 'm').complete([], [])).rejects.toThrow('provider-invalid-response');
    // Missing finish_reason used to become a silent `unknown` success.
    await expect(new OpenAIProvider(new SequenceTransport([{ choices: [{ message: { content: 'x' } }] }]), 'http://offline', 'm').complete([], [])).rejects.toThrow('provider-invalid-response');
    await expect(new AnthropicProvider({ async post() { return {}; } }, 'http://offline', 'm').complete([], [])).rejects.toThrow('provider-invalid-response');
    await expect(new AnthropicProvider(new SequenceTransport([{ content: [{ type: 'text', text: 'x' }] }]), 'http://offline', 'm').complete([], [])).rejects.toThrow('provider-invalid-response');
  });

  it('maps truncation/limit and unexpected stop reasons to non-retryable errors', async () => {
    const openaiLength = new OpenAIProvider(new SequenceTransport([openAIText('partial', 'length')]), 'http://offline', 'm');
    await expect(openaiLength.complete([], [])).rejects.toThrow('provider-response-truncated');
    const openaiUnknown = new OpenAIProvider(new SequenceTransport([{ choices: [{ message: { content: 'x' }, finish_reason: 'mystery' }] }]), 'http://offline', 'm');
    await expect(openaiUnknown.complete([], [])).rejects.toThrow('provider-response-unexpected-stop');

    const anthropicMax = new AnthropicProvider(new SequenceTransport([anthropicText('partial', 'max_tokens')]), 'http://offline', 'm');
    await expect(anthropicMax.complete([], [])).rejects.toThrow('provider-response-truncated');
    const anthropicUnknown = new AnthropicProvider(new SequenceTransport([anthropicText('x', 'mystery')]), 'http://offline', 'm');
    await expect(anthropicUnknown.complete([], [])).rejects.toThrow('provider-response-unexpected-stop');
  });

  it('requires real tool-call ids and normalizes blank arguments', async () => {
    const missingId = new OpenAIProvider(new SequenceTransport([openAIToolCalls([{ name: 'lookup', args: '{}' }])]), 'http://offline', 'm');
    await expect(missingId.complete([], [])).rejects.toThrow('provider-invalid-tool-call');
    const missingAnthropicId = new AnthropicProvider(new SequenceTransport([{ content: [{ type: 'tool_use', name: 'lookup', input: {} }], stop_reason: 'tool_use' }]), 'http://offline', 'm');
    await expect(missingAnthropicId.complete([], [])).rejects.toThrow('provider-invalid-tool-call');

    const emptyArgs = new OpenAIProvider(new SequenceTransport([openAIToolCalls([{ id: 'call-empty', name: 'lookup', omitArgs: true }])]), 'http://offline', 'm');
    const openai = await emptyArgs.complete([], []);
    expect(openai.toolCalls).toEqual([{ id: 'call-empty', name: 'lookup', arguments: '{}' }]);
    const emptyAnthropic = new AnthropicProvider(new SequenceTransport([{ content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} }], stop_reason: 'tool_use' }]), 'http://offline', 'm');
    expect((await emptyAnthropic.complete([], [])).toolCalls).toEqual([{ id: 'tool-1', name: 'lookup', arguments: '{}' }]);
  });

  it('never fabricates ids for streamed tool calls', async () => {
    const noId: HttpTransport = {
      async post() { return {}; },
      async postStream() {
        return chunks(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lookup","arguments":"{}"}}]}}]}\n\n', 'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n', 'data: [DONE]\n\n']);
      },
    };
    await expect(new OpenAIProvider(noId, 'http://offline', 'm').stream([], [])).rejects.toThrow('provider-invalid-tool-call');

    const noAnthropicId: HttpTransport = {
      async post() { return {}; },
      async postStream() {
        return chunks([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"lookup"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ]);
      },
    };
    await expect(new AnthropicProvider(noAnthropicId, 'http://offline', 'm').stream([], [])).rejects.toThrow('provider-invalid-tool-call');
  });

  it('maps streamed truncation and keeps blank streamed arguments valid JSON', async () => {
    const lengthStream: HttpTransport = {
      async post() { return {}; },
      async postStream() {
        return chunks(['data: {"choices":[{"delta":{"content":"cut"}}]}\n\n', 'data: {"choices":[{"finish_reason":"length"}]}\n\n', 'data: [DONE]\n\n']);
      },
    };
    await expect(new OpenAIProvider(lengthStream, 'http://offline', 'm').stream([], [])).rejects.toThrow('provider-response-truncated');

    const anthropicMax: HttpTransport = {
      async post() { return {}; },
      async postStream() {
        return chunks([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"lookup"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ]);
      },
    };
    await expect(new AnthropicProvider(anthropicMax, 'http://offline', 'm').stream([], [])).rejects.toThrow('provider-response-truncated');

    const emptyArgsStream: HttpTransport = {
      async post() { return {}; },
      async postStream() {
        return chunks([
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-2","name":"lookup"}}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ]);
      },
    };
    expect((await new AnthropicProvider(emptyArgsStream, 'http://offline', 'm').stream([], [])).toolCalls).toEqual([{ id: 'tool-2', name: 'lookup', arguments: '{}' }]);
  });

  it('rejects truncation from injected providers and surfaces a rejected command', async () => {
    const truncating: ModelProvider = { async complete() { return { stopReason: 'max_tokens', text: 'cut' }; }, cancel() {} };
    const session = new ProviderSession({ providers: { injected: truncating }, initialProvider: 'injected', execute: async () => ({}) });
    await expect(session.run('go')).rejects.toThrow('provider-response-truncated');
    expect(session.history.length).toBe(1);

    const runtime = createRuntime({
      clock: new ManualClock(),
      modelProvider: 'openai',
      providers: { openai: new OpenAIProvider(new SequenceTransport([openAIText('cut', 'length')]), 'http://offline', 'm') },
    });
    try {
      const result = await runtime.control.command({ requestId: 'r3-truncated', command: 'message', payload: { text: 'go' } });
      expect(result.state).toBe('rejected');
      expect(result.code).toContain('provider-response-truncated');
    } finally { runtime.close(); }
  });

  it('treats max-turns exhaustion as an error, not an empty terminal response', async () => {
    let turn = 0;
    const looping: ModelProvider = { async complete() { return { stopReason: 'tool_calls', toolCalls: [{ id: `call-${turn++}`, name: 'get_state', arguments: '{}' }] }; }, cancel() {} };
    const session = new ProviderSession({ providers: { loop: looping }, initialProvider: 'loop', maxTurns: 3, execute: async () => ({ ok: true }) });
    await expect(session.run('loop')).rejects.toThrow('provider-max-turns');
    expect(isToolHistoryComplete(session.history.snapshot())).toBe(true);
  });
});

describe('Round 3 — write replay ledger is scoped to one top-level run', () => {
  it('executes the same write call in two legitimate user turns', async () => {
    const transport = new SequenceTransport([
      openAIToolCalls([{ id: 'write-1', name: 'place_one', args: '{"x":1,"y":2}' }]),
      openAIText('first done'),
      openAIToolCalls([{ id: 'write-2', name: 'place_one', args: '{"x":1,"y":2}' }]),
      openAIText('second done'),
    ]);
    let executions = 0;
    const session = new ProviderSession({
      providers: { openai: new OpenAIProvider(transport, 'http://offline', 'm') },
      writeTools: ['place_one'],
      execute: async call => { executions += 1; return { ok: true, call: call.id }; },
    });
    const first = await session.run('place it');
    expect(first.response.text).toBe('first done');
    expect(executions).toBe(1);
    const second = await session.run('place it again');
    expect(second.response.text).toBe('second done');
    // A new top-level turn must not be suppressed by the previous turn's write fingerprint.
    expect(executions).toBe(2);
  });
});

describe('Round 3 — abort between sequential tool calls leaves complete pairing', () => {
  it('records an aborted result for the unexecuted call and allows a later turn and switch', async () => {
    const openaiTransport = new SequenceTransport([
      openAIToolCalls([
        { id: 'write-a', name: 'place_one', args: '{"x":1,"y":2}' },
        { id: 'write-b', name: 'place_one', args: '{"x":3,"y":4}' },
      ]),
    ]);
    const anthropicTransport = new SequenceTransport([anthropicText('continued')]);
    const openai = new OpenAIProvider(openaiTransport, 'http://offline/openai', 'm');
    const anthropic = new AnthropicProvider(anthropicTransport, 'http://offline/anthropic', 'm');
    const controller = new AbortController();
    let executions = 0;
    const session = new ProviderSession({
      providers: { openai, anthropic }, initialProvider: 'openai',
      writeTools: ['place_one'],
      execute: async call => { executions += 1; if (executions === 1) controller.abort(); return { ok: true, call: call.id }; },
    });

    await expect(session.run('do both', { signal: controller.signal })).rejects.toThrow();
    expect(executions).toBe(1);
    const history = session.history.snapshot();
    expect(isToolHistoryComplete(history)).toBe(true);
    expect(() => validateCanonicalHistory(history, 'openai', { requireComplete: true })).not.toThrow();
    const results = history.filter(message => message.role === 'tool');
    expect(results.map(message => message.toolResult?.toolCallId)).toEqual(['write-a', 'write-b']);
    // The executed call keeps its real result; the queued call is explicitly aborted, not missing.
    expect(results[1]!.toolResult?.content).toMatchObject({ ok: false, canceled: true, error: 'aborted' });

    // The complete history no longer blocks a provider switch, and the next turn serializes
    // both call/result pairs to the new provider.
    session.switchProvider('anthropic');
    const second = await session.run('continue');
    expect(second.response.text).toBe('continued');
    const sent = anthropicTransport.requests[0]!.body as { messages: any[] };
    const assistant = sent.messages.find(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some((block: any) => block.type === 'tool_use'));
    expect(assistant.content.filter((block: any) => block.type === 'tool_use').map((block: any) => block.id)).toEqual(['write-a', 'write-b']);
    const toolResults = sent.messages.find(message => message.role === 'user' && Array.isArray(message.content) && message.content.some((block: any) => block.type === 'tool_result'));
    expect(toolResults.content.filter((block: any) => block.type === 'tool_result').map((block: any) => block.tool_use_id)).toEqual(['write-a', 'write-b']);
  });
});

describe('Round 3 — factory providers are switchable while canonical history survives', () => {
  it('registers two injected providers and switches the next request with metadata update', async () => {
    const openaiTransport = new SequenceTransport([
      openAIToolCalls([{ id: 'call-state', name: 'get_state', args: '{}' }]),
      openAIText('openai done'),
    ]);
    const anthropicTransport = new SequenceTransport([anthropicText('anthropic done')]);
    const runtime = createRuntime({
      clock: new ManualClock(),
      bridge: new FakeClientBridge(),
      modelProvider: 'openai',
      providers: {
        openai: new OpenAIProvider(openaiTransport, 'http://offline/openai', 'openai-model'),
        anthropic: new AnthropicProvider(anthropicTransport, 'http://offline/anthropic', 'anthropic-model'),
      },
    });
    try {
      expect(runtime.canonicalProviderPath).toBe(true);
      expect(runtime.control.provider()).toMatchObject({ provider: 'openai', configured: true, networkEnabled: false, transport: 'fixture' });
      const first = await runtime.control.command({ requestId: 'r3-switch-1', command: 'message', payload: { text: 'go' } });
      expect(first.state).toBe('terminal');
      expect(openaiTransport.requests).toHaveLength(2);

      runtime.loop.switchProvider('anthropic');
      expect(runtime.providerSession!.provider).toBe('anthropic');
      expect(runtime.control.provider()).toMatchObject({ provider: 'anthropic', configured: true, networkEnabled: false, transport: 'fixture' });

      const second = await runtime.control.command({ requestId: 'r3-switch-2', command: 'message', payload: { text: 'again' } });
      expect(second.state).toBe('terminal');
      expect(openaiTransport.requests).toHaveLength(2);
      expect(anthropicTransport.requests).toHaveLength(1);

      // The canonical transcript crossed the provider boundary intact.
      const history = runtime.providerSession!.history.snapshot();
      expect(history).toContainEqual(expect.objectContaining({ role: 'assistant', toolCalls: [expect.objectContaining({ id: 'call-state', name: 'get_state' })] }));
      expect(history).toContainEqual(expect.objectContaining({ role: 'tool', toolResult: expect.objectContaining({ toolCallId: 'call-state' }) }));
      const sent = anthropicTransport.requests[0]!.body as { messages: any[] };
      expect(sent.messages.some(message => message.content?.some?.((block: any) => block.type === 'tool_use' && block.id === 'call-state'))).toBe(true);
      expect(sent.messages.some(message => message.content?.some?.((block: any) => block.type === 'tool_result' && block.tool_use_id === 'call-state'))).toBe(true);
      expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'again' });
    } finally { runtime.close(); }
  });
});

describe('Round 3 — canonical history trim evicts complete tool-turn groups under a cap', () => {
  it('stays bounded and paired for a tool-heavy transcript', () => {
    const history = new CanonicalHistory();
    history.appendUser('start');
    for (let index = 0; index < 300; index++) {
      const call = { id: `call-${index}`, name: 'get_state', arguments: '{}' };
      history.appendAssistant({ stopReason: 'tool_calls', toolCalls: [call] }, 'test');
      history.appendToolResults([call], new Map([[call.id, { ok: true, index }]]));
    }
    expect(history.length).toBe(601);
    history.trim(200);
    const bounded = history.snapshot();
    expect(bounded.length).toBeLessThanOrEqual(200);
    expect(isToolHistoryComplete(bounded)).toBe(true);
    expect(() => validateCanonicalHistory(bounded, 'openai', { requireComplete: true })).not.toThrow();
    // User context survives while tool turns are evicted first.
    expect(bounded[0]).toMatchObject({ role: 'user', content: 'start' });
    const callIds = new Set(bounded.flatMap(message => message.toolCalls?.map(call => call.id) ?? []));
    expect(callIds.size).toBeGreaterThan(0);
    expect(bounded.filter(message => message.role === 'tool').every(message => callIds.has(message.toolResult!.toolCallId))).toBe(true);

    // The byte cap is enforced without splitting a pair.
    history.trim(10_000, 8 * 1024);
    const byteBounded = history.snapshot();
    expect(new TextEncoder().encode(JSON.stringify(byteBounded)).byteLength).toBeLessThanOrEqual(8 * 1024);
    expect(byteBounded.length).toBeLessThan(bounded.length);
    expect(isToolHistoryComplete(byteBounded)).toBe(true);
    expect(() => validateCanonicalHistory(byteBounded, 'openai', { requireComplete: true })).not.toThrow();
  });
});

describe('Round 3 — shared retry budget is a sliding window', () => {
  it('exhausts, rejects immediate extra retries, then retries again after the window advances', async () => {
    let now = 1_000;
    const shared = new SharedProviderRuntime({ maxRetries: 1, retryWindowMs: 1_000, now: () => now });
    let firstAttempts = 0;
    const failingA = new OpenAIProvider({ async post() { firstAttempts += 1; throw new ProviderError('busy', 503, 'openai', true); } }, 'http://offline', 'm', undefined, { shared, sleep: async () => undefined });
    await expect(failingA.complete([], [])).rejects.toThrow('busy');
    expect(firstAttempts).toBe(2); // initial + one shared retry
    expect(shared.sharedRetriesUsed).toBe(1);

    // Same window: the shared token is gone.
    let secondAttempts = 0;
    const failingB = new AnthropicProvider({ async post() { secondAttempts += 1; throw new ProviderError('busy', 503, 'anthropic', true); } }, 'http://offline', 'm', undefined, '2023-06-01', { shared, sleep: async () => undefined });
    await expect(failingB.complete([], [])).rejects.toThrow('busy');
    expect(secondAttempts).toBe(1);

    // After the rolling window the budget is usable again.
    now += 1_001;
    let thirdAttempts = 0;
    const recovering = new OpenAIProvider({
      async post() {
        thirdAttempts += 1;
        if (thirdAttempts === 1) throw new ProviderError('busy', 503, 'openai', true);
        return openAIText('recovered');
      },
    }, 'http://offline', 'm', undefined, { shared, sleep: async () => undefined });
    await expect(recovering.complete([], [])).resolves.toMatchObject({ text: 'recovered' });
    expect(thirdAttempts).toBe(2);
    expect(shared.sharedRetriesUsed).toBe(1);
  });
});
