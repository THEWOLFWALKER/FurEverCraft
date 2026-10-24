import { describe, expect, it } from 'vitest';
import { ManualClock, type BodyContext } from '../../src/contracts/index.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { createRuntime } from '../../src/execution/factory.js';
import { ProviderError, type HttpTransport } from '../../src/providers/shared.js';
import type { ModelMessage, ModelProvider, ModelResponse } from '../../src/providers/scripted/index.js';
import { MotionController } from '../../src/motor/controller.js';
import type { BodyAdapter, MotionPlan } from '../../src/motor/contracts.js';
import { SparseVoxelWorld } from '../../src/motor/geometry.js';
import { SimulatedBody } from '../../src/fixtures/simulated-body.js';
import { SimulatedBodyAdapter } from '../../src/fixtures/body-adapter.js';
import { createBoundedObserver } from '../../src/bridge/observer/bounded.js';
import { navigateToBody } from '../../src/skills/navigation.js';

const context: BodyContext = { serverProfileId: 'simulated', worldGenerationId: 'p23-world', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };

const toolCallResponse = (id: string, name: string, args: unknown) => ({
  choices: [{ message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }],
});
const textResponse = (text: string) => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });

class RecordingTransport implements HttpTransport {
  readonly requests: Array<{ url: string; body: { messages?: Array<Record<string, unknown>> } }> = [];
  constructor(private readonly handler: (index: number) => unknown) {}
  async post(url: string, body: unknown, _headers: Record<string, string>, signal?: AbortSignal) {
    this.requests.push({ url, body: body as { messages?: Array<Record<string, unknown>> } });
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    return this.handler(this.requests.length - 1);
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000, label = 'condition') => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`timeout:${label}`);
};

describe('P23 provider interruption', () => {
  it('retries a 429 within the shared budget without re-executing an already dispatched write', async () => {
    const transport = new RecordingTransport(index => {
      if (index === 0) return toolCallResponse('call-place', 'start_skill', { skill: 'place_one', x: 1, y: 0, proposalId: 'provider-429-place' });
      if (index <= 2) {
        const error = new ProviderError('busy', 429, 'openai', true);
        (error as { retryAfterMs?: number }).retryAfterMs = 1;
        throw error;
      }
      return textResponse('done after rate limit');
    });
    const bridge = new FakeClientBridge();
    const runtime = createRuntime({
      bridge,
      clock: new ManualClock(),
      modelProvider: 'openai',
      allowModelNetwork: false,
      transport,
    });
    try {
      expect(runtime.canonicalProviderPath).toBe(true);
      const command = await runtime.control.command({ requestId: 'provider-429', command: 'message', payload: { text: 'place one block' } });
      expect(command.state).toBe('terminal');
      // one tool turn plus two retries plus the final answer; the write tool itself runs once.
      expect(transport.requests).toHaveLength(4);
      expect(bridge.inventory).toBe(7);
      expect(bridge.cell(1, 0)).toBe('blocked');
      expect(runtime.store.listExecutions()).toHaveLength(1);
      expect(runtime.store.listExecutions()[0]).toMatchObject({ status: 'succeeded', outcome: 'confirmed' });
      expect(runtime.store.listEffects()).toHaveLength(1);
      expect(runtime.store.listEffects()[0]).toMatchObject({ status: 'confirmed' });
      // The retry carried the canonical tool result; it did not ask the model to run the write again.
      const retryMessages = transport.requests[1]!.body.messages ?? [];
      expect(retryMessages.some(message => message.role === 'tool')).toBe(true);
      expect(JSON.stringify(retryMessages)).toContain('call-place');
    } finally {
      runtime.close();
    }
  }, 15_000);

  it('aborts an in-flight provider request on pause without dispatching input', async () => {
    class HangingProvider implements ModelProvider {
      started = false;
      canceled = false;
      complete(_messages: ModelMessage[], _tools: unknown[], signal?: AbortSignal): Promise<ModelResponse> {
        this.started = true;
        return new Promise<ModelResponse>((_resolve, reject) => {
          const abort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      cancel() { this.canceled = true; }
    }
    const provider = new HangingProvider();
    const bridge = new FakeClientBridge();
    const runtime = createRuntime({ bridge, clock: new ManualClock(), provider });
    try {
      const pending = runtime.control.command({ requestId: 'provider-abort', command: 'message', payload: { text: 'slow model request' } });
      await waitFor(() => provider.started, 2_000, 'provider-start');
      const paused = await runtime.control.command({ requestId: 'provider-pause', command: 'pause', payload: {} });
      expect(paused.state).toBe('terminal');
      const result = await pending;
      expect(result.state).toBe('rejected');
      expect(result.code).toBe('stopping');
      expect(runtime.control.status().paused).toBe(true);
      // The aborted model turn never reached a tool, an execution, an effect or the body.
      expect(runtime.store.listExecutions()).toHaveLength(0);
      expect(runtime.store.listEffects()).toHaveLength(0);
      expect(bridge.position).toEqual({ x: 0, y: 0 });
      expect(bridge.inventory).toBe(8);
      expect(provider.canceled).toBe(false);
    } finally {
      runtime.close();
    }
  }, 15_000);
});

function flatWorld(): SparseVoxelWorld {
  const world = new SparseVoxelWorld(context, { id: 'p23-motor-fixture', registryVersion: 'fixture-1', source: 'fixture', approximate: false });
  for (let x = -4; x <= 12; x += 1) for (let z = -4; z <= 12; z += 1) {
    world.setBlock({ x, y: -1, z }, 'full_cube', 'stone');
    for (let y = 0; y <= 5; y += 1) world.setAir({ x, y, z });
  }
  return world;
}

function makeBody() {
  const clock = new ManualClock();
  const world = flatWorld();
  const body = new SimulatedBody(context, world, clock, { start: { x: 0.5, y: 0, z: 0.5, yaw: 0, pitch: 0 } });
  const adapter = new SimulatedBodyAdapter(body, world, clock, { tickMs: 20, observationRadius: 12 });
  return { clock, world, body, adapter };
}

const stopPlan = (clock: ManualClock, ownerToken: string): MotionPlan => ({
  commandId: 'post-disconnect-stop', ownerToken, leaseId: 'new-lease', issuedAt: clock.now(),
  deadline: clock.now() + 1_000, maxAge: 1_000, context, observationRef: 'post-disconnect',
  intent: { kind: 'stop' },
});

describe('P23 observation loss', () => {
  it('revokes the lease before input when the observer reports a global gap', async () => {
    // A saturated observer is explicitly unknown; the control loop refuses that observation and
    // releases the lease instead of acting on bytes it cannot interpret.
    const observer = createBoundedObserver({ maxQueuedFrames: 1, maxQueuedBytes: 1_024, maxConcurrency: 1, taskTimeoutMs: 100 });
    observer.subscribe(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    observer.attach('client-to-server', Buffer.concat(Array.from({ length: 6 }, (_, index) => Buffer.from([1, index]))));
    expect(observer.health).toBe('unknown');
    await observer.stop();

    const { adapter, clock, body } = makeBody();
    adapter.setObservationOverride({ gap: true });
    let revoked: string | undefined;
    const result = await navigateToBody(adapter, clock, { x: 2, y: 0, z: 0 }, {
      leaseId: 'gap-lease',
      ownerToken: 'gap-owner',
      onLeaseRevoke: reason => { revoked = reason; },
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('observation-gap');
    expect(result.released).toBe(true);
    expect(revoked).toBe('observation-gap');
    expect(adapter.counters.submitted).toBe(0);
    expect(body.ownerToken).toBeUndefined();
  });
});

describe('P23 Motor stall and disconnect', () => {
  it('bounds a stall, releases input, and keeps a disconnected route from reviving its lease', async () => {
    const stalled = makeBody();
    // The frozen adapter accepts input but never advances the body: a genuine no-progress stall.
    const frozen: BodyAdapter = {
      context: stalled.adapter.context,
      capabilities: stalled.adapter.capabilities,
      source: 'simulated',
      observe: () => stalled.adapter.observe(),
      submit: plan => stalled.adapter.submit(plan),
      release: owner => stalled.adapter.release(owner),
      advance: () => undefined,
    };
    const stalledController = new MotionController(frozen, stalled.clock, {
      budget: { maxTicks: 60, maxTicksPerStep: 8, stallTicks: 3, maxReplans: 1, maxWallClockMs: 60_000, observationMaxAgeMs: 500, yawToleranceDegrees: 8 },
    });
    const stalledResult = await stalledController.run({ target: { x: 3, y: 0, z: 0 }, leaseId: 'stall-lease', ownerToken: 'stall-owner' });
    expect(stalledResult.status).toBe('failed');
    expect(stalledResult.outcome).toBe('failed');
    expect(stalledResult.ticks).toBeLessThanOrEqual(24);
    expect(stalledResult.replans).toBeLessThanOrEqual(1);
    expect(stalledResult.released).toBe(true);
    expect(stalled.adapter.counters.releases).toBeGreaterThan(0);
    expect(stalled.body.ownerToken).toBeUndefined();
    expect(stalled.adapter.counters.submitted).toBeGreaterThan(0);

    const disconnected = makeBody();
    let controller!: MotionController;
    let advances = 0;
    let submittedAfterRelease = 0;
    let released = false;
    const hooked: BodyAdapter = {
      context: disconnected.adapter.context,
      capabilities: disconnected.adapter.capabilities,
      source: 'simulated',
      observe: () => disconnected.adapter.observe(),
      advance: ticks => {
        disconnected.adapter.advance(ticks);
        advances += 1;
        if (advances === 1) controller.onDisconnect();
      },
      submit: async plan => {
        // A terminal stop may follow release as the safety action; no motion input may.
        if (released && plan.intent.kind !== 'stop') submittedAfterRelease += 1;
        return disconnected.adapter.submit(plan);
      },
      release: async owner => {
        released = true;
        await disconnected.adapter.release(owner);
      },
    };
    controller = new MotionController(hooked, disconnected.clock, {
      budget: { maxTicks: 60, maxTicksPerStep: 40, stallTicks: 8, maxReplans: 2, maxWallClockMs: 60_000, observationMaxAgeMs: 500, yawToleranceDegrees: 8 },
    });
    const disconnectedResult = await controller.run({ target: { x: 4, y: 0, z: 0 }, leaseId: 'old-lease', ownerToken: 'old-owner' });
    expect(disconnectedResult.status).toBe('failed');
    expect(disconnectedResult.reason).toBe('disconnected');
    expect(disconnectedResult.released).toBe(true);
    expect(disconnected.body.ownerToken).toBeUndefined();
    expect(submittedAfterRelease).toBe(0);

    // The old owner's lease is not revived; a fresh owner can use the body after the release.
    const fresh = await disconnected.adapter.submit(stopPlan(disconnected.clock, 'new-owner'));
    expect(fresh.accepted).toBe(true);

    // Target CAS: an operator revision change during execution revokes the route immediately.
    const retargeted = makeBody();
    let revision = 7;
    let watchCalls = 0;
    const targetRun = await new MotionController(retargeted.adapter, retargeted.clock, {
      budget: { maxTicks: 60, maxTicksPerStep: 40, stallTicks: 8, maxReplans: 2, maxWallClockMs: 60_000, observationMaxAgeMs: 500, yawToleranceDegrees: 8 },
    }).run({
      target: { x: 4, y: 0, z: 0 },
      leaseId: 'cas-lease',
      ownerToken: 'cas-owner',
      targetRevision: { expected: 7, current: () => revision },
      watch: () => {
        watchCalls += 1;
        if (watchCalls === 6) revision = 8;
        return undefined;
      },
    });
    expect(targetRun.status).toBe('canceled');
    expect(targetRun.reason).toBe('target-revision-changed');
    expect(targetRun.released).toBe(true);
    expect(retargeted.body.ownerToken).toBeUndefined();
  }, 15_000);
});
