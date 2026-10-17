import { describe, expect, it } from 'vitest';
import { OpenAIProvider, parseSSE, type HttpTransport, ProviderError, MAX_SSE_RECORD_BYTES, MAX_SSE_RESPONSE_BYTES } from '../../src/providers/openai/index.js';
import { AnthropicProvider, anthropicMessages } from '../../src/providers/anthropic/index.js';
import type { ModelMessage } from '../../src/providers/scripted/index.js';

async function collect(source: AsyncIterable<string | Uint8Array>) { const out: unknown[] = []; for await (const item of parseSSE(source)) out.push(item); return out; }
async function* chunks(values: Array<string | Uint8Array>) { for (const value of values) yield value; }
const transportResponse = { choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }] };

describe('providers', () => {
  it('parses UTF-8 SSE records split across byte chunks', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"雪"}\n\n');
    expect(await collect(chunks([bytes.slice(0, 10), bytes.slice(10, 12), bytes.slice(12)]))).toEqual([{ text: '雪' }]);
  });
  it('maps generic tools to native OpenAI and Anthropic schemas', async () => {
    const calls: unknown[] = []; const transport: HttpTransport = { async post(_url, body) { calls.push(body); return transportResponse; } };
    await new OpenAIProvider(transport, 'http://offline', 'model').complete([], [{ name: 'lookup', description: 'look up', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]);
    await new AnthropicProvider(transport, 'http://offline', 'model').complete([{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }], [{ name: 'lookup', description: 'look up', parameters: { type: 'object', properties: {} } }]);
    expect((calls[0] as any).tools[0]).toEqual({ type: 'function', function: { name: 'lookup', description: 'look up', parameters: { type: 'object', properties: { q: { type: 'string' } } } } });
    expect((calls[1] as any).tools[0]).toEqual({ name: 'lookup', description: 'look up', input_schema: { type: 'object', properties: {} } });
    expect((calls[1] as any).system).toBe('rules');
  });
  it('rejects real fetch unless the model network gate is explicitly enabled', async () => {
    const { FetchTransport } = await import('../../src/providers/openai/index.js');
    await expect(new FetchTransport().post('https://example.invalid', {}, {})).rejects.toThrow('model-network-disabled');
  });
  it('serializes canonical assistant calls and paired tool results', async () => {
    const calls: unknown[] = []; const transport: HttpTransport = { async post(_url, body) { calls.push(body); return { choices: [{ message: { content: null, tool_calls: [] }, finish_reason: 'stop' }] }; } };
    await new OpenAIProvider(transport, 'http://offline', 'model').complete([{ role: 'user', content: 'lookup' }, { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'lookup', arguments: '{"q":"x"}' }] }, { role: 'tool', toolCallId: 'call-1', content: '{"ok":true}' }], []);
    expect((calls[0] as any).messages).toEqual([{ role: 'user', content: 'lookup' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' }]);
  });
  it('serializes image references in provider-native formats and keeps system loss out of Anthropic messages', () => {
    const history: ModelMessage[] = [{ role: 'system', content: 'policy' }, { role: 'user', content: 'inspect', images: [{ type: 'image', ref: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png' }] }];
    expect(anthropicMessages(history)).toEqual({ system: 'policy', messages: [{ role: 'user', content: [{ type: 'text', text: 'inspect' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }] }] });
  });
  it('rejects incomplete streams and half JSON tool arguments', async () => {
    const noDone: HttpTransport = { async post() { return {}; }, async postStream() { return chunks(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']); } };
    await expect(new OpenAIProvider(noDone, 'http://offline', 'model').stream([], [])).rejects.toThrow('provider-stream-truncated');
    const halfJson: HttpTransport = { async post() { return {}; }, async postStream() { return chunks(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"x","arguments":"{\\"a\\":"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n']); } };
    await expect(new OpenAIProvider(halfJson, 'http://offline', 'model').stream([], [])).rejects.toThrow('provider-incomplete-tool-json');
  });
  it('enforces SSE byte budgets', async () => {
    await expect(collect(chunks([`data: ${'x'.repeat(MAX_SSE_RECORD_BYTES)}\n\n`]))).rejects.toThrow('provider-sse-record-limit');
    await expect(collect(chunks(['x'.repeat(MAX_SSE_RESPONSE_BYTES + 1)]))).rejects.toThrow('provider-sse-response-limit');
  });
  it('retries transient HTTP errors at most twice without SDK retry behavior', async () => {
    let attempts = 0; const transport: HttpTransport = { async post() { attempts++; if (attempts < 3) throw new ProviderError('busy', 503, 'test', true); return transportResponse; } };
    const provider = new OpenAIProvider(transport, 'http://offline', 'model', undefined, { sleep: async () => {} });
    await provider.complete([], []); expect(attempts).toBe(3);
  });
  it('cancellation fences an in-flight completion', async () => {
    let finish!: (value: unknown) => void; const transport: HttpTransport = { post() { return new Promise(resolve => { finish = resolve; }); } };
    const provider = new OpenAIProvider(transport, 'http://offline', 'model'); const request = provider.complete([], []); provider.cancel(); finish(transportResponse);
    await expect(request).rejects.toThrow();
  });
  it('pairs interleaved streamed tool fragments and reports provider stream errors', async () => {
    const transport: HttpTransport = { async post() { return {}; }, async postStream() { return chunks(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"one","arguments":"{\\"x\\":"}}]}}]}\n\n','data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"two","arguments":"{}"}}]}}]}\n\n','data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n','data: [DONE]\n\n']); } };
    const result = await new OpenAIProvider(transport, 'http://offline', 'model').stream([], []); expect(result.toolCalls).toEqual([{ id: 'a', name: 'one', arguments: '{"x":1}' }, { id: 'b', name: 'two', arguments: '{}' }]);
    const failing: HttpTransport = { async post() { return {}; }, async postStream() { return chunks(['data: {"type":"error","error":{"message":"bad"}}\n\n','event: message_stop\ndata: {"type":"message_stop"}\n\n']); } };
    await expect(new AnthropicProvider(failing, 'http://offline', 'model').stream([], [])).rejects.toThrow('bad');
  });
});
