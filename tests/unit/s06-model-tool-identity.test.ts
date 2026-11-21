import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/execution/factory.js';
import { SQLiteStore } from '../../src/persistence/store.js';
import { commandScopeFor, canonicalPayloadHash } from '../../src/control/service.js';
import { canonicalScopeKey } from '../../src/contracts/context.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ScriptedModelProvider, type ModelMessage, type ModelProvider, type ModelResponse, type ToolCall } from '../../src/providers/scripted/index.js';
import { ProviderSession } from '../../src/providers/session.js';
import { CanonicalHistory } from '../../src/providers/canonical.js';
import { classifyToolCall, defaultWriteTools } from '../../src/providers/tools.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Provider whose response sequence is advanced only when complete() is called. */
class SequenceProvider implements ModelProvider {
  readonly calls: ModelMessage[][] = [];
  canceled = 0;
  constructor(private readonly responses: ModelResponse[]) {}
  async complete(messages: ModelMessage[]): Promise<ModelResponse> {
    this.calls.push(messages);
    return this.responses.shift() ?? { text: 'done', stopReason: 'end_turn' };
  }
  cancel() { this.canceled += 1; }
}

/** Provider that gates its first completion so a command can be held in flight. */
class GatedProvider implements ModelProvider {
  readonly started: Promise<void>;
  private markStarted!: () => void;
  private readonly release = deferred<ModelResponse>();
  calls = 0;
  constructor(private readonly call?: ToolCall) { this.started = new Promise<void>(resolve => { this.markStarted = resolve; }); }
  async complete(_messages: ModelMessage[], _tools: unknown[], signal?: AbortSignal): Promise<ModelResponse> {
    this.calls += 1;
    this.markStarted();
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    const response = await new Promise<ModelResponse>((resolve, reject) => {
      const abort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      void this.release.promise.then(value => { signal?.removeEventListener('abort', abort); resolve(value); });
    });
    return this.call ? { ...response, toolCalls: [this.call] } : response;
  }
  releaseRun(response: ModelResponse = { text: 'late reply', stopReason: 'end_turn' }) { this.release.resolve(response); }
  cancel() {}
}

const call = (id: string, name: string, args: unknown): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const toolResponse = (...calls: ToolCall[]): ModelResponse => ({ text: '', toolCalls: calls, stopReason: 'tool_calls' });
const textResponse = (text: string): ModelResponse => ({ text, stopReason: 'end_turn' });

function sessionWith(provider: ModelProvider, options: { execute: (call: ToolCall, signal?: AbortSignal) => Promise<unknown>; writeTools?: string[]; providers?: Record<string, ModelProvider> }) {
  return new ProviderSession({
    providers: options.providers ?? { provider },
    initialProvider: 'provider',
    writeTools: options.writeTools ?? ['place_one', 'send_chat', 'revise_goal', 'cancel_execution'],
    execute: options.execute,
  });
}

describe('S06 FEC-29 control command identity', () => {
  it('reports identical in-flight payloads as accepted and different payloads as conflict', async () => {
    const provider = new GatedProvider();
    const runtime = createRuntime({ provider });
    try {
      const request = { requestId: 's06-same', command: 'message' as const, payload: { text: 'hello' } };
      const first = runtime.control.command(request);
      await provider.started;
      const duplicate = await runtime.control.command(request);
      const different = await runtime.control.command({ ...request, payload: { text: 'different' } });
      expect(duplicate).toMatchObject({ state: 'accepted', code: 'in-flight' });
      expect(different).toMatchObject({ state: 'conflict', code: 'command-payload-conflict' });
      expect(provider.calls).toBe(1);
      const scope = commandScopeFor(runtime.bridge.context);
      expect(runtime.store.getActionReceipt(scope, request.requestId)?.status).toBe('pending');
      provider.releaseRun();
      expect((await first).state).toBe('terminal');
      // The owner-safe claim is released; a later different payload is still rejected by the
      // durable payload hash, not silently accepted.
      expect(await runtime.control.command({ ...request, payload: { text: 'different' } })).toMatchObject({ state: 'conflict', code: 'command-payload-conflict' });
    } finally { runtime.close(); }
  });

  it('uses the full stable scope key when account/world/dimension identity is available', async () => {
    const bridge = new FakeClientBridge(12, { context: { accountId: 'account-a', worldGenerationId: 'world-9', dimension: 'nether' } });
    const runtime = createRuntime({ bridge, provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      await runtime.control.command({ requestId: 'scoped', command: 'goal.set', payload: { goalId: 'g-scope', text: 'scoped' } });
      const expected = `control:${canonicalScopeKey({ serverProfileId: 'simulated', accountId: 'account-a', worldGenerationId: 'world-9', dimensionId: 'nether' })}`;
      expect(commandScopeFor(runtime.bridge.context)).toBe(expected);
      expect(runtime.store.getActionReceipt(expected, 'scoped')?.status).toBe('completed');
    } finally { runtime.close(); }
  });
});

describe('S06 FEC-30 full command receipt replay', () => {
  it('persists and replays the exact failure envelope and code after a DB reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's06-receipt-'));
    const db = join(dir, 's06.sqlite');
    try {
      const request = { requestId: 's06-cancel', command: 'cancel' as const, payload: { executionId: 'missing-execution' } };
      const first = createRuntime({ db });
      let firstResult;
      try {
        firstResult = await first.control.command(request);
        expect(firstResult).toMatchObject({ state: 'unknown', code: 'execution-not-found' });
      } finally { first.close(); }

      const reopened = createRuntime({ db });
      try {
        const scope = commandScopeFor(reopened.bridge.context);
        const receipt = reopened.store.getActionReceipt(scope, request.requestId);
        expect(receipt?.code).toBe('execution-not-found');
        expect(receipt?.fullResult).toEqual(firstResult);
        expect(receipt?.requestJsonHash).toBe(canonicalPayloadHash(request));
        const replay = await reopened.control.command(request);
        expect(replay).toEqual(firstResult);
        expect(replay.code).toBe('execution-not-found');
      } finally { reopened.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('stores the quit envelope before closing the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's06-quit-'));
    const db = join(dir, 'quit.sqlite');
    let scope = '';
    try {
      const runtime = createRuntime({ db });
      scope = commandScopeFor(runtime.bridge.context);
      const quit = await runtime.control.command({ requestId: 's06-quit', command: 'quit', payload: {} });
      expect(quit.state).toBe('accepted');
      const inspector = new SQLiteStore(db);
      try {
        const receipt = inspector.getActionReceipt(scope, 's06-quit');
        expect(receipt?.fullResult).toMatchObject({ requestId: 's06-quit', command: 'quit', state: 'accepted' });
        expect(receipt?.requestJsonHash).toBe(canonicalPayloadHash({ requestId: 's06-quit', command: 'quit', payload: {} }));
      } finally { inspector.close(); }
      runtime.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('S06 FEC-39/40 logical tool call identity', () => {
  it('executes identical text/arguments again in a new decision but replays the same decision', async () => {
    const provider = new SequenceProvider([
      toolResponse(call('w1', 'place_one', { x: 1, y: 2 })), textResponse('one'),
      toolResponse(call('w1', 'place_one', { x: 1, y: 2 })), textResponse('two'),
      toolResponse(call('r1', 'place_one', { x: 3, y: 4 })), textResponse('three'),
      toolResponse(call('r1', 'place_one', { x: 3, y: 4 })), textResponse('four'),
    ]);
    let executions = 0;
    const session = sessionWith(provider, { execute: async () => { executions += 1; return { ok: true, n: executions }; } });
    const first = await session.run('place');
    const second = await session.run('place again');
    expect(first.turns[0]!.executed).toEqual(['w1']);
    expect(second.turns[0]!.executed).toEqual(['w1']);
    expect(executions).toBe(2);

    // Explicitly retrying the same decision reuses the logical call identity.
    const retried = await session.run('retry', { decisionId: 'decision-retry' });
    const retriedTurn = retried.turns.at(-1)!;
    const replayed = await session.run('retry again', { decisionId: 'decision-retry' });
    const replayedTurn = replayed.turns.at(-1)!;
    expect(retriedTurn.executed).toEqual(['r1']);
    // The repeated raw id is namespaced internally; provenance keeps the provider id.
    expect(replayedTurn.replayed).toEqual([replayedTurn.provenance[0]!.internalId]);
    expect(replayedTurn.provenance[0]!.providerId).toBe('r1');
    expect(replayedTurn.executed).toEqual([]);
    expect(executions).toBe(3);
  });

  it('rejects changed name/arguments under the same logical id before mutating history', async () => {
    const provider = new SequenceProvider([
      toolResponse(call('c1', 'place_one', { x: 1 })), textResponse('done'),
      toolResponse(call('c1', 'place_one', { x: 2 })),
    ]);
    let executions = 0;
    const session = sessionWith(provider, { execute: async () => { executions += 1; return { ok: true }; } });
    await session.run('first', { decisionId: 'd-conflict' });
    const before = session.history.length;
    await expect(session.run('second', { decisionId: 'd-conflict' })).rejects.toThrow('provider-tool-call-conflict');
    expect(executions).toBe(1);
    expect(session.history.length).toBe(before);
    expect(session.history.snapshot().at(-1)).toMatchObject({ role: 'assistant', content: 'done' });
  });

  it('does not let a failed call suppress a later legitimate write in a new decision', async () => {
    const provider = new SequenceProvider([
      toolResponse(call('f1', 'place_one', { x: 1 })), textResponse('failed'),
      toolResponse(call('f2', 'place_one', { x: 1 })), textResponse('ok'),
    ]);
    let executions = 0;
    const session = sessionWith(provider, { execute: async () => { executions += 1; if (executions === 1) throw new Error('body-busy'); return { ok: true }; } });
    const first = await session.run('try');
    expect(first.turns[0]!.executed).toEqual(['f1']);
    expect(first.turns[0]!.response.stopReason).toBe('tool_calls');
    const second = await session.run('try again');
    expect(second.turns[1]!.executed).toEqual(['f2']);
    expect(executions).toBe(2);
  });

  it('keeps raw provider ids as provenance while namespacing repeated ids', async () => {
    const provider = new SequenceProvider([
      toolResponse(call('same-id', 'get_state', {})), textResponse('a'),
      toolResponse(call('same-id', 'get_state', {})), textResponse('b'),
    ]);
    const session = sessionWith(provider, { execute: async () => ({ ok: true }) });
    await session.run('a');
    const second = await session.run('b');
    const provenance = second.turns[1]!.provenance[0]!;
    expect(provenance.providerId).toBe('same-id');
    expect(provenance.internalId).not.toBe('same-id');
    expect(session.history.snapshot().flatMap(message => message.toolCalls ?? []).map(item => item.id)).toEqual(['same-id', provenance.internalId]);
  });
});

describe('S06 FEC-41 final assistant text', () => {
  it('appends a text-only final assistant response to canonical history', async () => {
    const session = sessionWith(new SequenceProvider([textResponse('final answer')]), { execute: async () => ({ ok: true }) });
    const result = await session.run('question');
    expect(result.response.text).toBe('final answer');
    expect(session.history.snapshot().at(-1)).toMatchObject({ role: 'assistant', content: 'final answer' });
  });
});

describe('S06 FEC-42 atomic tool_call/result pairing on cancel', () => {
  it('pairs canceled calls as ambiguous/not-executed and allows switching provider afterwards', async () => {
    const provider = new SequenceProvider([toolResponse(call('started', 'place_one', { x: 1 }), call('never', 'place_one', { x: 2 }))]);
    const other = new SequenceProvider([textResponse('other')]);
    const gate = deferred<void>();
    const controller = new AbortController();
    let started = 0;
    const session = new ProviderSession({
      providers: { provider, other }, initialProvider: 'provider',
      writeTools: ['place_one'],
      execute: async (_call, signal) => {
        started += 1;
        if (started === 1) {
          await new Promise<void>((resolve, reject) => {
            gate.promise.then(resolve);
            signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
          });
        }
        return { ok: true };
      },
    });
    const run = session.run('go', { signal: controller.signal });
    for (let attempt = 0; attempt < 20 && started === 0; attempt++) await tick();
    expect(started).toBe(1);
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    const history = session.history.snapshot();
    const assistant = history.find(message => message.role === 'assistant' && message.toolCalls?.length);
    const results = history.filter(message => message.role === 'tool');
    expect(assistant?.toolCalls?.map(item => item.id)).toEqual(['started', 'never']);
    expect(results).toHaveLength(2);
    expect(results[0]!.toolResult).toMatchObject({ toolCallId: 'started', content: { ok: false, code: 'ambiguous' }, isError: true });
    expect(results[1]!.toolResult).toMatchObject({ toolCallId: 'never', content: { ok: false, code: 'not-executed' }, isError: true });
    // The cancel left a complete pair, so switching providers is legal.
    expect(() => session.switchProvider('other')).not.toThrow();
    expect(session.provider).toBe('other');
  });

  it('uses allSettled for read fan-out and marks ok:false failures as tool errors', async () => {
    const provider = new SequenceProvider([toolResponse(call('r1', 'get_state', {}), call('r2', 'get_state', {}), call('r3', 'get_state', {}))]);
    let concurrent = 0, maxConcurrent = 0;
    const session = new ProviderSession({
      providers: { provider }, initialProvider: 'provider',
      execute: async item => {
        concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
        await tick();
        concurrent -= 1;
        if (item.id === 'r2') throw new Error('read-failed');
        return { ok: true, id: item.id };
      },
    });
    await session.run('read');
    const results = session.history.snapshot().filter(message => message.role === 'tool');
    expect(results).toHaveLength(3);
    expect(results[1]!.toolResult).toMatchObject({ toolCallId: 'r2', isError: true, content: { ok: false, error: 'read-failed' } });
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(maxConcurrent).toBeLessThanOrEqual(8);
  });
});

describe('S06 FEC-43 shared tool classifier', () => {
  it('classifies read, write and control-write, including dynamic start_skill', () => {
    expect(classifyToolCall(call('a', 'get_state', {}))).toBe('read');
    expect(classifyToolCall(call('b', 'send_chat', { text: 'hi' }))).toBe('write');
    expect(classifyToolCall(call('c', 'remember_place', { placeId: 'p', payload: {} }))).toBe('write');
    expect(classifyToolCall(call('d', 'revise_goal', { goalId: 'g', expectedRevision: 1, change: 'x' }))).toBe('control-write');
    expect(classifyToolCall(call('e', 'cancel_execution', { executionId: 'x' }))).toBe('control-write');
    expect(classifyToolCall(call('f', 'start_skill', { skill: 'navigate_to', x: 1, y: 2, z: 3 }))).toBe('read');
    expect(classifyToolCall(call('g', 'start_skill', { skill: 'place_one', x: 1, y: 2 }))).toBe('write');
    expect(defaultWriteTools).toEqual(expect.arrayContaining(['send_chat', 'remember_place', 'revise_goal', 'cancel_execution']));
  });

  it('serializes a batch containing any mutation in model order, while pure reads fan out', async () => {
    const order: string[] = [];
    const provider = new SequenceProvider([toolResponse(call('w1', 'place_one', { x: 1 }), call('r1', 'get_state', {}), call('w2', 'send_chat', { text: 'hi' })), textResponse('done')]);
    const session = sessionWith(provider, { writeTools: ['place_one', 'send_chat'], execute: async item => { order.push(item.id); await tick(); return { ok: true }; } });
    await session.run('mixed');
    expect(order).toEqual(['w1', 'r1', 'w2']);

    const readOrder: string[] = [];
    const readProvider = new SequenceProvider([toolResponse(call('a', 'get_state', {}), call('b', 'get_state', {}), call('c', 'get_state', {})), textResponse('done')]);
    const readSession = sessionWith(readProvider, { execute: async item => { readOrder.push(item.id); return { ok: true }; } });
    await readSession.run('reads');
    expect(readOrder).toHaveLength(3);
  });
});

describe('S06 FEC-44 unit-based canonical history trim', () => {
  it('drops oldest whole units and never splits tool calls from results', () => {
    const history = new CanonicalHistory();
    history.append({ role: 'user', content: 'old question' });
    history.append({ role: 'assistant', content: 'old answer' });
    history.append({ role: 'user', content: 'new question' });
    history.append({ role: 'assistant', content: '', toolCalls: [call('t1', 'get_state', {}), call('t2', 'get_state', {})] });
    history.append({ role: 'tool', content: '{"ok":true}', toolResult: { toolCallId: 't1', content: { ok: true } } });
    history.append({ role: 'tool', content: '{"ok":true}', toolResult: { toolCallId: 't2', content: { ok: true } } });
    history.trim(4);
    expect(history.length).toBe(4);
    const snapshot = history.snapshot();
    expect(snapshot[0]).toMatchObject({ role: 'user', content: 'new question' });
    expect(snapshot[1]!.toolCalls?.map(item => item.id)).toEqual(['t1', 't2']);
    expect(snapshot.slice(2).map(message => message.toolResult?.toolCallId)).toEqual(['t1', 't2']);
    expect(() => history.validate()).not.toThrow();
  });

  it('enforces the UTF-8 byte budget and rejects a single newest unit over budget', () => {
    const history = new CanonicalHistory();
    history.append({ role: 'user', content: 'x'.repeat(2_000) });
    history.append({ role: 'assistant', content: 'short' });
    history.trim(200, 100);
    expect(history.snapshot()).toEqual([{ role: 'assistant', content: 'short' }]);

    const oversized = new CanonicalHistory();
    oversized.append({ role: 'assistant', content: '', toolCalls: [call('large', 'get_state', {})] });
    oversized.append({ role: 'tool', content: '{}', toolResult: { toolCallId: 'large', content: { ok: true } } });
    expect(() => oversized.trim(200, 1)).toThrow('canonical-history-budget-exceeded');
  });
});
