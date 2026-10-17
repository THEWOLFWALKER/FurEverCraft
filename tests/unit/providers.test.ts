import { describe, expect, it } from 'vitest';
import { OpenAIProvider, parseSSE, type HttpTransport } from '../../src/providers/openai/index.js';
import { AnthropicProvider } from '../../src/providers/anthropic/index.js';

async function collect(source: AsyncIterable<string | Uint8Array>) { const out: unknown[] = []; for await (const item of parseSSE(source)) out.push(item); return out; }
async function* chunks(values: Array<string | Uint8Array>) { for (const value of values) yield value; }

describe('providers', () => {
  it('parses UTF-8 SSE records split across byte chunks', async () => {
    const bytes = new TextEncoder().encode('data: {"text":"雪"}\n\n');
    const result = await collect(chunks([bytes.slice(0, 10), bytes.slice(10, 12), bytes.slice(12)]));
    expect(result).toEqual([{ text: '雪' }]);
  });

  it('maps generic tools to native OpenAI and Anthropic schemas', async () => {
    const calls: unknown[] = [];
    const transport: HttpTransport = { async post(_url, body) { calls.push(body); return { choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }] }; } };
    await new OpenAIProvider(transport, 'http://offline', 'model').complete([], [{ name: 'lookup', description: 'look up', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]);
    await new AnthropicProvider(transport, 'http://offline', 'model').complete([{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }], [{ name: 'lookup', description: 'look up', parameters: { type: 'object', properties: {} } }]);
    expect((calls[0] as any).tools[0]).toEqual({ type: 'function', function: { name: 'lookup', description: 'look up', parameters: { type: 'object', properties: { q: { type: 'string' } } } } });
    expect((calls[1] as any).tools[0]).toEqual({ name: 'lookup', description: 'look up', input_schema: { type: 'object', properties: {} } });
    expect((calls[1] as any).system).toBe('rules');
  });

  it('pairs interleaved streamed tool fragments and surfaces provider errors', async () => {
    const transport: HttpTransport = { async post() { return {}; }, async postStream(_url, _body) { return chunks([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"one","arguments":"{\\"x\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"two","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n', 'data: [DONE]\n\n'
    ]); } };
    const result = await new OpenAIProvider(transport, 'http://offline', 'model').stream([], []);
    expect(result.toolCalls).toEqual([{ id: 'a', name: 'one', arguments: '{"x":1}' }, { id: 'b', name: 'two', arguments: '{}' }]);
    const failing: HttpTransport = { async post() { return {}; }, async postStream() { return chunks(['data: {"type":"error","error":{"message":"bad"}}\n\n']); } };
    await expect(new AnthropicProvider(failing, 'http://offline', 'model').stream([], [])).rejects.toThrow('bad');
  });
});
