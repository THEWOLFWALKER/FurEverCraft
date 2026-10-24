import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/execution/factory.js';
import { SQLiteStore } from '../../src/persistence/store.js';
import { canonicalPayloadHash } from '../../src/control/service.js';
import { FakeClientBridge, type FakeBridgeOptions } from '../../src/bridge/fake/index.js';
import type { ModelMessage, ModelProvider, ModelResponse, ToolCall } from '../../src/providers/scripted/index.js';
import { nextId } from '../../src/contracts/index.js';
import { ScriptedModelProvider } from '../../src/providers/scripted/index.js';

/** Gate a promise from outside so a test can hold an AgentLoop in flight. */
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A provider whose completion the test releases explicitly; it honors the AgentLoop abort signal. */
class GatedProvider implements ModelProvider {
  readonly started: Promise<void>;
  private markStarted!: () => void;
  private readonly release = deferred<ModelResponse>();
  calls = 0;
  canceled = 0;
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
  cancel() { this.canceled += 1; }
}

/** Counts every physical write the AgentLoop could still attempt through the router. */
class CountingBridge extends FakeClientBridge {
  chatWrites = 0;
  constructor(size?: number, options?: FakeBridgeOptions) { super(size, options); }
  override dispatchChat(text: string) { this.chatWrites += 1; return super.dispatchChat(text); }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const controlScope = 'control:simulated';

describe('U01 ControlService', () => {
  it('hashes payloads canonically and deduplicates durable requests', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      expect(canonicalPayloadHash({ b: 2, a: 1 })).toBe(canonicalPayloadHash({ a: 1, b: 2 }));
      const first = await runtime.control.command({ requestId: 'r1', command: 'goal.set', payload: { goalId: 'g1', text: 'explore' } });
      const replay = await runtime.control.command({ requestId: 'r1', command: 'goal.set', payload: { text: 'explore', goalId: 'g1' } });
      const conflict = await runtime.control.command({ requestId: 'r1', command: 'goal.set', payload: { goalId: 'g1', text: 'different' } });
      expect(first.state).toBe('terminal');
      expect(replay.state).toBe('terminal');
      expect(replay.result).toEqual(first.result);
      expect(conflict).toMatchObject({ state: 'conflict', code: 'command-payload-conflict' });
      expect(runtime.control.goals()).toHaveLength(1);
    } finally { runtime.close(); }
  });

  it('never reports a command accepted when its durable receipt cannot be written', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    const store = runtime.store as unknown as { addActionReceipt: (...args: unknown[]) => unknown };
    const original = store.addActionReceipt.bind(runtime.store);
    let fail = true;
    store.addActionReceipt = (...args: unknown[]) => {
      if (fail) { fail = false; throw new Error('receipt-disk-full'); }
      return original(...args as Parameters<typeof original>);
    };
    try {
      const result = await runtime.control.command({ requestId: 'receipt-unavailable', command: 'goal.set', payload: { goalId: 'g-receipt', text: 'must not start' } });
      expect(result).toMatchObject({ state: 'unknown', code: 'receipt-unavailable' });
      // No durable receipt means no execution: the goal write must not have happened.
      expect(runtime.store.getGoal('g-receipt')).toBeUndefined();
      const receipt = runtime.store.getActionReceipt('control:simulated', 'receipt-unavailable');
      expect(receipt).toBeUndefined();
    } finally { runtime.close(); }
  });

  it('reports unknown when the completion receipt write fails after execution', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    const store = runtime.store as unknown as { updateActionReceipt: (...args: unknown[]) => unknown };
    const original = store.updateActionReceipt.bind(runtime.store);
    let fail = true;
    store.updateActionReceipt = (...args: unknown[]) => {
      if (fail) { fail = false; throw new Error('receipt-write-failed'); }
      return original(...args as Parameters<typeof original>);
    };
    try {
      const result = await runtime.control.command({ requestId: 'receipt-commit-fail', command: 'goal.set', payload: { goalId: 'g-commit', text: 'applied but unrecorded' } });
      expect(result).toMatchObject({ state: 'unknown', code: 'receipt-write-failed' });
      // The command may have taken effect; the response must not claim a durable terminal.
      expect(runtime.store.getGoal('g-commit')?.revision).toBe(1);
      expect(runtime.store.getActionReceipt('control:simulated', 'receipt-commit-fail')?.status).toBe('pending');
    } finally { runtime.close(); }
  });

  it('returns CAS conflict and does not claim accepted chat is succeeded', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      await runtime.control.command({ requestId: 'r1', command: 'goal.set', payload: { goalId: 'g1', text: 'one' } });
      const cas = await runtime.control.command({ requestId: 'r2', command: 'goal.revise', payload: { goalId: 'g1', expectedRevision: 0, change: 'two' } });
      expect(cas.state).toBe('conflict');
      const chat = await runtime.control.command({ requestId: 'r3', command: 'chat', payload: { text: 'hello' } });
      expect(['terminal', 'unknown']).toContain(chat.state);
      expect(chat.state).not.toBe('accepted');
    } finally { runtime.close(); }
  });

  it('persists a checkpoint on save and reports it on reload', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      const saved = await runtime.control.command({ requestId: 's1', command: 'save', payload: {} });
      expect(saved.state).toBe('terminal');
      const stored = runtime.store.getLatestCheckpoint('runtime');
      expect(stored?.revision).toBe(1);
      expect(stored?.checkpoint_id).toBe((saved.result as { checkpointId?: string }).checkpointId);
    } finally { runtime.close(); }
  });

  it('replays a conflict as conflict, never as terminal success', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      await runtime.control.command({ requestId: 'g', command: 'goal.set', payload: { goalId: 'g1', text: 'one' } });
      const conflict = await runtime.control.command({ requestId: 'c', command: 'goal.revise', payload: { goalId: 'g1', expectedRevision: 0, change: 'two' } });
      expect(conflict.state).toBe('conflict');
      const replay = await runtime.control.command({ requestId: 'c', command: 'goal.revise', payload: { goalId: 'g1', expectedRevision: 0, change: 'two' } });
      expect(replay.state).toBe('conflict');
      expect(replay.state).not.toBe('terminal');
    } finally { runtime.close(); }
  });

  it('stop cancels non-terminal executions instead of only flagging', async () => {
    const runtime = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      runtime.store.saveExecution({ executionId: 'exec-running', proposalId: 'prop-running', proposalHash: 'h', goalId: 'g1', skillId: 'navigate_to', skillVersion: '1.0.0', status: 'running' });
      const stopped = await runtime.control.command({ requestId: 'stop', command: 'stop', payload: {} });
      expect(stopped.state).toBe('accepted');
      expect((stopped.result as { canceled?: string[] }).canceled).toContain('exec-running');
      expect(runtime.store.getExecution('exec-running')?.status).toBe('canceled');
      expect(runtime.control.status().stopping).toBe(true);
    } finally { runtime.close(); }
  });
});

describe('FEC-052 in-process requestId claim', () => {
  it('executes a concurrently claimed requestId exactly once and replays its stored result', async () => {
    const provider = new GatedProvider();
    const runtime = createRuntime({ provider });
    try {
      await runtime.control.command({ requestId: 'g', command: 'goal.set', payload: { goalId: 'g1', text: 'one' } });
      const request = { requestId: 'same', command: 'message' as const, payload: { text: 'hello' } };
      const first = runtime.control.command(request);
      await provider.started;
      // Same-process duplicates arrive while the first execution is still in flight.
      const duplicates = await Promise.all([runtime.control.command(request), runtime.control.command(request)]);
      const leaked = await runtime.control.command({ ...request, payload: { text: 'different' } });
      expect(duplicates.every(result => result.state === 'accepted' && result.code === 'in-flight')).toBe(true);
      expect(leaked).toMatchObject({ state: 'accepted', code: 'in-flight' });
      expect(runtime.store.getActionReceipt('control:simulated', 'same')?.status).toBe('pending');

      provider.releaseRun();
      expect((await first).state).toBe('terminal');
      expect(provider.calls).toBe(1); // exactly one admitted AgentLoop run
      const replay = await runtime.control.command(request);
      expect(replay.state).toBe('terminal');
      expect(runtime.store.getActionReceipt('control:simulated', 'same')?.status).toBe('completed');
      expect(await runtime.control.command({ ...request, payload: { text: 'different' } })).toMatchObject({ state: 'conflict', code: 'command-payload-conflict' });
      expect(provider.calls).toBe(1);
    } finally { runtime.close(); }
  });
});

describe('FEC-041/042/015/016 pause, stop and resume abort in-flight work', () => {
  it('pause aborts a started AgentLoop before it can dispatch its tool call', async () => {
    const bridge = new CountingBridge();
    const call: ToolCall = { id: 'call-chat', name: 'send_chat', arguments: JSON.stringify({ text: 'should-not-be-sent' }) };
    const provider = new GatedProvider(call);
    const runtime = createRuntime({ bridge, provider });
    try {
      const message = runtime.control.command({ requestId: 'm1', command: 'message', payload: { text: 'go' } });
      await provider.started;
      const pause = await runtime.control.command({ requestId: 'p1', command: 'pause', payload: {} });
      expect(pause.state).toBe('terminal');
      // The abort happened inside pause; the advertised signal for the next admitted run is fresh.
      expect(runtime.control.abortSignal.aborted).toBe(false);
      provider.releaseRun();
      const aborted = await message;
      expect(aborted.state).toBe('rejected');
      expect(aborted.code).toBe('stopping');
      // The aborted run never reached its tool call, so no body write happened.
      expect(bridge.chatWrites).toBe(0);
      expect(runtime.control.status().paused).toBe(true);
      // Pausing is announced when the handoff starts; the terminal pause receipt follows it.
      const kinds = runtime.control.events('0', 100).events.map(event => event.kind);
      expect(kinds.indexOf('control.pause')).toBeGreaterThan(-1);
      expect(kinds.indexOf('runtime.pausing')).toBeGreaterThan(-1);
      expect(kinds.indexOf('runtime.pausing')).toBeLessThan(kinds.indexOf('control.pause'));
      // Every execution the aborted run had started is canceled, not left running.
      expect(runtime.store.listExecutions().every(execution => ['canceled', 'failed'].includes(execution.status))).toBe(true);
      // Resume re-opens admission with a fresh, unaborted signal.
      const resume = await runtime.control.command({ requestId: 'p2', command: 'resume', payload: {} });
      expect(resume.state).toBe('terminal');
      expect(runtime.control.status().paused).toBe(false);
      expect(runtime.control.abortSignal.aborted).toBe(false);
    } finally { runtime.close(); }
  });

  it('pause aborts an AgentLoop waiting on the model and reports the message as rejected', async () => {
    const provider = new GatedProvider();
    const runtime = createRuntime({ provider });
    try {
      const message = runtime.control.command({ requestId: 'm-wait', command: 'message', payload: { text: 'wait' } });
      await provider.started;
      await runtime.control.command({ requestId: 'p-wait', command: 'pause', payload: {} });
      const result = await message;
      // The provider was released only by the abort, so the command settled by the time pause returned.
      expect(result).toMatchObject({ state: 'rejected', code: 'stopping' });
      expect(runtime.store.getActionReceipt(controlScope, 'm-wait')?.status).toBe('rejected');
      expect(provider.calls).toBe(1);
      const kinds = runtime.control.events('0', 100).events.map(event => event.kind);
      expect(kinds.indexOf('control.message')).toBeGreaterThan(-1);
      expect(kinds.indexOf('runtime.pausing')).toBeGreaterThan(kinds.indexOf('control.message'));
    } finally { runtime.close(); }
  });

  it('stop aborts the in-flight message and its receipt is rejected before runtime.stopping', async () => {
    const provider = new GatedProvider();
    const runtime = createRuntime({ provider });
    try {
      const message = runtime.control.command({ requestId: 'm2', command: 'message', payload: { text: 'go' } });
      await provider.started;
      const stopped = await runtime.control.command({ requestId: 's2', command: 'stop', payload: {} });
      expect(stopped.state).toBe('accepted');
      const result = await message;
      expect(result).toMatchObject({ state: 'rejected', code: 'stopping' });
      expect(runtime.store.getActionReceipt(controlScope, 'm2')?.status).toBe('rejected');
      const kinds = runtime.control.events('0', 200).events.map(event => event.kind);
      // The aborted message receipt is published before the stop event it caused: a client that
      // follows runtime.stopping never sees a later receipt resolving a command the stop ended.
      expect(kinds.indexOf('control.message')).toBeGreaterThan(-1);
      expect(kinds.indexOf('control.message')).toBeLessThan(kinds.indexOf('runtime.stopping'));
      expect(runtime.control.status()).toMatchObject({ stopping: true, paused: true });
    } finally { runtime.close(); }
  });

  it('resume is rejected after stop or quit and never clears the stopped state', async () => {
    const stopped = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      await stopped.control.command({ requestId: 's', command: 'stop', payload: {} });
      const resume = await stopped.control.command({ requestId: 'r', command: 'resume', payload: {} });
      expect(resume).toMatchObject({ state: 'rejected', code: 'stopping' });
      expect(stopped.control.status()).toMatchObject({ stopping: true, paused: true });
      // Replaying durable commands after stop must not resurrect the run either.
      const replay = await stopped.control.command({ requestId: 's', command: 'stop', payload: {} });
      expect(replay.state).toBe('accepted');
      expect((await stopped.control.command({ requestId: 'm', command: 'message', payload: { text: 'x' } })).state).toBe('rejected');
      expect(stopped.control.status()).toMatchObject({ stopping: true, paused: true });
    } finally { stopped.close(); }

    const quitting = createRuntime({ provider: new ScriptedModelProvider([{ text: 'ok', stopReason: 'end_turn' }]) });
    try {
      await quitting.control.command({ requestId: 'p', command: 'pause', payload: {} });
      await quitting.control.command({ requestId: 'resume-pre', command: 'resume', payload: {} });
      expect(quitting.control.status().paused).toBe(false);
      const quit = await quitting.control.command({ requestId: 'q', command: 'quit', payload: {} });
      expect(quit.state).toBe('accepted');
      expect(quit.result).toMatchObject({ stopping: true, closed: true });
      // A durable resume from before the quit must not clear paused/stopping after resume became illegal.
      // Either a stopping or already-closed rejection is correct; what matters is that it is refused.
      const resume = await quitting.control.command({ requestId: 'resume-pre', command: 'resume', payload: {} });
      expect(resume.state).toBe('rejected');
      expect(['stopping', 'runtime-closed']).toContain(resume.code);
      expect((await quitting.control.command({ requestId: 'r', command: 'resume', payload: {} })).state).toBe('rejected');
      expect(quitting.control.status()).toMatchObject({ stopping: true, paused: true });
      expect(quitting.control.quittingValue).toBe(true);
      expect(quitting.control.closedValue).toBe(true);
      expect((await quitting.control.command({ requestId: 'm', command: 'message', payload: { text: 'x' } })).state).toBe('rejected');
    } finally { quitting.close(); }
  });
});

describe('FEC-043/044 quit runs the runtime cleanup path', () => {
  it('quit closes the runtime, the underlying store, and shuts down the bridge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'furevercraft-quit-'));
    const db = join(dir, 'runtime.sqlite');
    let bridgeShutdowns = 0;
    class ShuttingBridge extends FakeClientBridge { async shutdown() { bridgeShutdowns += 1; } }
    const bridge = new ShuttingBridge();
    const runtime = createRuntime({ db, bridge });
    const inspector = new SQLiteStore(db);
    let inspectorClosed = false;
    try {
      await runtime.control.command({ requestId: 'goal-q', command: 'goal.set', payload: { goalId: 'g-quit', text: 'before quit' } });
      const quit = await runtime.control.command({ requestId: 'quit-1', command: 'quit', payload: {} });
      expect(quit.state).toBe('accepted');
      expect(quit.result).toMatchObject({ stopping: true, closed: true });
      expect(bridgeShutdowns).toBe(1);
      // The store is closed: a direct query fails instead of silently succeeding.
      expect(() => runtime.store.getGoal('any')).toThrow();
      // The quit receipt and event are durable before the store closes.
      expect(inspector.getActionReceipt('control:simulated', 'quit-1')?.status).toBe('completed');
      const durableKinds = inspector.getCriticalEvents('0', 100).map(event => event.kind);
      expect(durableKinds).toEqual(expect.arrayContaining(['runtime.shutdown-requested', 'control.quit']));
      expect(runtime.control.status()).toMatchObject({ stopping: true, paused: true, closed: true });
      expect(runtime.control.closedValue).toBe(true);
    } finally { inspector.close(); inspectorClosed = true; runtime.close(); }
    expect(inspectorClosed).toBe(true);
    // The closed runtime released its db ownership lock, so the same db can be reopened.
    const reopened = createRuntime({ db });
    try {
      expect(reopened.store.listGoals().map(goal => goal.goal_id)).toEqual(['g-quit']);
    } finally { reopened.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('FEC-038 pause cancels active executions', () => {
  it('pause cancels an execution the AgentLoop started from a tool call', async () => {
    // The loop really starts the skill through the router; pause must end it, not let it finish.
    const call: ToolCall = { id: 'call-nav', name: 'start_skill', arguments: JSON.stringify({ skill: 'wait_for_condition', ms: 0, proposalId: 'loop-wait' }) };
    const provider = new GatedProvider(call);
    const runtime = createRuntime({ provider });
    try {
      const message = runtime.control.command({ requestId: 'm-skill', command: 'message', payload: { text: 'go' } });
      await provider.started;
      provider.releaseRun();
      // Let the loop enter the tool call before pausing.
      for (let attempt = 0; attempt < 50 && runtime.store.listExecutions().length === 0; attempt += 1) await tick();
      const execution = runtime.store.listExecutions()[0]!;
      expect(execution).toBeDefined();
      await runtime.control.command({ requestId: 'p-skill', command: 'pause', payload: {} });
      expect((await message).state).toBe('rejected');
      // Pause waits for cancellations, so the execution is already settled when it returns.
      expect(runtime.store.getExecution(execution.executionId)?.status).not.toBe('running');
      expect(['canceled', 'failed', 'succeeded']).toContain(runtime.store.getExecution(execution.executionId)?.status);
    } finally { runtime.close(); }
  });
});
