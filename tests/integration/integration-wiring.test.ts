import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createRuntime } from '../../src/execution/factory.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import type { ClientBridgeCapabilities } from '../../src/bridge/capabilities.js';
import { ManualClock, type BodyContext } from '../../src/contracts/index.js';
import { SparseVoxelWorld } from '../../src/motor/geometry.js';
import { SimulatedBody } from '../../src/fixtures/simulated-body.js';
import { SimulatedBodyAdapter } from '../../src/fixtures/body-adapter.js';
import type { BodyAdapter, WorldObservation } from '../../src/motor/contracts.js';
import { poseBlock } from '../../src/motor/route.js';
import { Motor3D } from '../../src/motor/primitives.js';
import { navigate } from '../../src/skills/navigation.js';
import type { KnowledgeRelease } from '../../src/autonomous/knowledge.js';
import type { HttpTransport } from '../../src/providers/shared.js';
import { BridgeService } from '../../src/bridge/service/orchestrator.js';
import { runBridgeServiceCommand } from '../../src/cli/main.js';
import { createControlServer } from '../../src/server/index.js';

const context: BodyContext = { serverProfileId: 'simulated', worldGenerationId: 'world-1', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };

function flatWorld(): SparseVoxelWorld {
  const world = new SparseVoxelWorld(context, { id: 'integration-fixture', registryVersion: 'fixture-1', source: 'fixture', approximate: false });
  for (let x = -3; x <= 12; x++) for (let z = -3; z <= 12; z++) {
    world.setBlock({ x, y: -1, z }, 'full_cube', 'stone');
    for (let y = 0; y <= 5; y++) world.setAir({ x, y, z });
  }
  return world;
}

function make3D(options: { start?: { x?: number; y?: number; z?: number } } = {}) {
  const clock = new ManualClock();
  const world = flatWorld();
  const body = new SimulatedBody(context, world, clock, { start: { x: 0.5, y: 0, z: 0.5, yaw: 0, pitch: 0, ...options.start } });
  const adapter = new SimulatedBodyAdapter(body, world, clock, { tickMs: 20, observationRadius: 16 });
  return { clock, world, body, adapter };
}

const openRuntimes: Array<{ close(): void }> = [];
afterEach(() => { while (openRuntimes.length) openRuntimes.pop()!.close(); });
function track<T extends { close(): void }>(runtime: T): T { openRuntimes.push(runtime); return runtime; }

/** Delegating adapter that yields a macrotask so a pause can land mid-navigation. */
class SlowAdapter implements BodyAdapter {
  readonly context = context;
  readonly capabilities;
  readonly source = 'simulated' as const;
  constructor(readonly inner: SimulatedBodyAdapter) { this.capabilities = inner.capabilities; }
  get clock() { return this.inner.clock; }
  peek(): WorldObservation { return this.inner.peek(); }
  async observe(): Promise<WorldObservation> { await new Promise(resolve => setTimeout(resolve, 0)); return this.inner.observe(); }
  submit(plan: Parameters<BodyAdapter['submit']>[0]) { return this.inner.submit(plan); }
  release(owner: string) { return this.inner.release(owner); }
  advance(ticks: number) { this.inner.advance(ticks); }
  findBlock(block: string) { return this.inner.findBlock(block); }
  digBlock(pos: Parameters<NonNullable<BodyAdapter['digBlock']>>[0], block: string) { return this.inner.digBlock!(pos, block); }
  findPlace(placeId: string) { return this.inner.findPlace(placeId); }
}

class RecordingTransport implements HttpTransport {
  readonly requests: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  private readonly responses: unknown[];
  constructor(...responses: unknown[]) { this.responses = responses; }
  async post(url: string, body: unknown, headers: Record<string, string>) {
    this.requests.push({ url, body, headers });
    return this.responses.shift() ?? openAIText('done');
  }
}

const openAIText = (text: string) => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const openAITool = (id: string, name: string, args: string) => ({ choices: [{ message: { content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }] });

function knowledgeRelease(id: string, version: string, value: number): KnowledgeRelease {
  return {
    releaseId: id, version, createdAt: '2026-01-01T00:00:00.000Z',
    manifest: {
      manifestVersion: '1', createdAt: '2026-01-01T00:00:00.000Z',
      sources: [{ sourceId: 'fixture-source', version: `fixture-${version}`, kind: 'verified-rules', origin: 'offline-fixture', verified: true, covers: ['block.hardness'], registeredAt: '2026-01-01T00:00:00.000Z' }],
    },
    rules: [{ id: `rule-${version}`, namespace: 'rule', predicate: 'block.hardness', subject: 'stone', value, sourceId: 'fixture-source', sourceVersion: `fixture-${version}` }],
  };
}

describe('production integration: 3D tool → executor → skill → Motor → sink → independent body', () => {
  it('navigates through start_skill with non-zero z and observes a changed world pose', async () => {
    const { clock, body, adapter } = make3D();
    const bridge = new FakeClientBridge(16, { context });
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock, bodyAdapter: adapter }));
    const result = await runtime.router.invoke({ id: 'nav-1', name: 'start_skill', arguments: JSON.stringify({ skill: 'navigate_to', x: 2, y: 0, z: 3 }) });
    expect(result.ok).toBe(true);
    const execution = result.result as { status: string; outcome?: string; skillVersion: string };
    expect(execution.status).toBe('succeeded');
    expect(execution.outcome).toBe('confirmed');
    expect(execution.skillVersion).toBe('2.0.0');
    // The independent body moved because it consumed accepted input; the tool never wrote pose.
    expect(poseBlock(body.currentPose)).toEqual({ x: 2, y: 0, z: 3 });
    expect(body.currentPose.z).toBeGreaterThan(2.5);
    expect(adapter.counters.accepted).toBeGreaterThan(0);
    expect(adapter.counters.releases).toBeGreaterThan(0);
    // The legacy planar bridge was not used as a fallback.
    expect(bridge.position).toEqual({ x: 0, y: 0 });
  });

  it('rejects a stale observation before dispatching input', async () => {
    const { clock, body, adapter } = make3D();
    adapter.setObservationOverride({ observationLagMs: 1_500 });
    const bridge = new FakeClientBridge(16, { context });
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock, bodyAdapter: adapter }));
    const before = body.currentPose;
    const result = await runtime.router.invoke({ id: 'nav-stale', name: 'start_skill', arguments: JSON.stringify({ skill: 'navigate_to', x: 2, y: 0, z: 0 }) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('observation-stale');
    expect(adapter.counters.submitted).toBe(0);
    expect(body.currentPose).toEqual(before);
  });

  it('pause releases held input and stops the skill through the real scheduler/lifecycle', async () => {
    const { clock, body, adapter } = make3D({ start: { x: 0.5, z: 0.5 } });
    const bridge = new FakeClientBridge(16, { context });
    const slow = new SlowAdapter(adapter);
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock, bodyAdapter: slow }));
    const generationBefore = runtime.lifecycle.generationValue;
    expect(runtime.scheduler.pausedValue).toBe(false);

    const pending = runtime.router.invoke({ id: 'nav-pause', name: 'start_skill', arguments: JSON.stringify({ skill: 'navigate_to', x: 9, y: 0, z: 9 }) });
    // Wait until the skill has really started input, so pause has an active execution to
    // cancel instead of racing the executor registration.
    for (let attempt = 0; attempt < 400 && adapter.counters.submitted === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(adapter.counters.submitted).toBeGreaterThan(0);
    const paused = await runtime.control.command({ requestId: 'pause-1', command: 'pause', payload: {} });
    expect(paused.state).toBe('terminal');
    expect(runtime.scheduler.pausedValue).toBe(true);
    expect(runtime.scheduler.wake('should-not-wake')).toBe(false);
    expect(runtime.lifecycle.generationValue).toBeGreaterThan(generationBefore);

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(adapter.counters.releases).toBeGreaterThan(0);
    expect(body.ownerToken).toBeUndefined();
    expect(body.lastAction).toBe('stop');
    const stoppedAt = body.currentPose;
    for (let index = 0; index < 5; index++) body.tick();
    expect(body.currentPose.x).toBeCloseTo(stoppedAt.x, 5);
    expect(body.currentPose.z).toBeCloseTo(stoppedAt.z, 5);

    const resumed = await runtime.control.command({ requestId: 'resume-1', command: 'resume', payload: {} });
    expect(resumed.state).toBe('terminal');
    expect(runtime.scheduler.pausedValue).toBe(false);
    expect(runtime.scheduler.wake('resume-wake')).toBe(true);

    const stopped = await runtime.control.command({ requestId: 'stop-1', command: 'stop', payload: {} });
    expect(stopped.state).toBe('accepted');
    expect(runtime.scheduler.stoppedValue).toBe(true);
  });

  it('exposes a 3D body state instead of a fake planar pose, and labels legacy explicitly', async () => {
    const { clock, adapter } = make3D({ start: { x: 1.25, y: 0, z: 2.5 } });
    const bridge = new FakeClientBridge(16, { context });
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock, bodyAdapter: adapter }));
    const status = runtime.control.status();
    expect(status.body).toMatchObject({ mode: '3d', threeDimensional: true, legacy2d: false, x: 1.25, y: 0, z: 2.5, dimension: 'overworld', source: 'simulated' });
    expect(status.body && 'z' in status.body).toBe(true);
    expect(status.position).toBeUndefined();
    expect(status.observation).toMatchObject({ threeDimensional: true, mode: '3d', source: 'simulated' });
    // The legacy bridge's inventory/cells/UI must not be presented as the 3D body's state.
    expect(status.inventory).toBe(adapter.inventory);
    expect(status.ui).toBeUndefined();
    expect((status.context as { cells?: unknown }).cells).toBeUndefined();

    const state = await runtime.router.invoke({ id: 'state', name: 'get_state', arguments: '{}' });
    expect(state.ok).toBe(true);
    expect(state.result).toMatchObject({ mode: '3d', threeDimensional: true, z: 2.5, dimension: 'overworld' });

    const legacy = track(createRuntime({ profile: 'simulated', bridge: new FakeClientBridge() }));
    const legacyStatus = legacy.control.status();
    expect(legacyStatus.body).toMatchObject({ mode: 'legacy-2d', threeDimensional: false, legacy2d: true });
    expect(legacyStatus.body && 'z' in legacyStatus.body).toBe(false);
    expect(legacyStatus.position).toEqual({ x: 0, y: 0 });
    const legacyState = await legacy.router.invoke({ id: 'legacy-state', name: 'get_state', arguments: '{}' });
    expect(legacyState.result).toMatchObject({ mode: 'legacy-2d', threeDimensional: false, legacy2d: true, position: { x: 0, y: 0 } });
    // A 3D target is not silently padded away on the legacy path.
    const missingZ = await legacy.router.invoke({ id: 'legacy-nav', name: 'start_skill', arguments: JSON.stringify({ skill: 'navigate_to', x: 1, y: 0 }) });
    expect(missingZ).toMatchObject({ ok: false, error: 'invalid-tool-arguments' });
  });

  it('reports 3D status even when the legacy bridge snapshot is unavailable', () => {
    const { clock, adapter } = make3D({ start: { x: 2, y: 0, z: 3 } });
    const bridge = new FakeClientBridge(16, { context });
    (bridge as unknown as { snapshot: () => never }).snapshot = () => { throw new Error('legacy-bridge-unavailable'); };
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock, bodyAdapter: adapter }));
    const status = runtime.control.status();
    expect(status.body).toMatchObject({ mode: '3d', threeDimensional: true, z: 3 });
    expect(status.observation).toMatchObject({ source: 'simulated', threeDimensional: true, mode: '3d' });
    expect((status.observation as { error?: string }).error).toBeUndefined();
  });

  it('routes gather_blocks count and explore_area through the 3D skill adapters', async () => {
    const { clock, world, adapter } = make3D();
    world.setBlock({ x: 1, y: 0, z: 0 }, 'full_cube', 'coal_ore');
    world.setBlock({ x: 0, y: 0, z: 1 }, 'full_cube', 'coal_ore');
    const bridge = new FakeClientBridge(16, { context });
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock, bodyAdapter: adapter }));

    const gathered = await runtime.router.invoke({ id: 'gather-1', name: 'start_skill', arguments: JSON.stringify({ skill: 'gather_blocks', block: 'coal_ore', count: 2 }) });
    expect(gathered.ok).toBe(true);
    expect((gathered.result as { outcome?: string }).outcome).toBe('confirmed');
    expect(world.get({ x: 1, y: 0, z: 0 }).cell).toBe('free');
    expect(world.get({ x: 0, y: 0, z: 1 }).cell).toBe('free');
    expect(adapter.inventory).toBe(2);

    const explored = await runtime.router.invoke({ id: 'explore-1', name: 'start_skill', arguments: JSON.stringify({ skill: 'explore_area', radius: 4 }) });
    expect(explored.ok).toBe(true);
    expect((explored.result as { outcome?: string }).outcome).toBe('confirmed');
  });

  it('serves 3D navigation/gather/return when the bridge lacks legacy planar methods', async () => {
    const { clock, world, body, adapter } = make3D();
    const bridge = new FakeClientBridge(16, { context });
    // A real client bridge will not expose the 2D walk/digBlock/findPlace surface.
    const legacy = bridge as unknown as Record<string, unknown>;
    for (const method of ['walk', 'digBlock', 'adjacentBlock', 'findPlace', 'dig', 'lookAt']) legacy[method] = undefined;
    world.setBlock({ x: 1, y: 0, z: 3 }, 'full_cube', 'coal_ore');
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock, bodyAdapter: adapter }));

    const skills = runtime.router.availableSkills();
    expect(skills).toEqual(expect.arrayContaining(['navigate_to', 'gather_blocks', 'return_to_place']));
    expect(skills).not.toContain('look_at');
    const catalog = await runtime.router.invoke({ id: 'find-3d', name: 'find_skills', arguments: '{}' });
    expect((catalog.result as Array<{ id?: string }>).map(skill => skill.id)).toContain('navigate_to');

    const navigated = await runtime.router.invoke({ id: 'nav-no-legacy', name: 'start_skill', arguments: JSON.stringify({ skill: 'navigate_to', x: 1, y: 0, z: 1 }) });
    expect(navigated.ok).toBe(true);
    expect((navigated.result as { outcome?: string }).outcome).toBe('confirmed');

    const gathered = await runtime.router.invoke({ id: 'gather-no-legacy', name: 'start_skill', arguments: JSON.stringify({ skill: 'gather_blocks', block: 'coal_ore' }) });
    expect(gathered.ok).toBe(true);
    expect((gathered.result as { outcome?: string }).outcome).toBe('confirmed');
    expect(world.get({ x: 1, y: 0, z: 3 }).cell).toBe('free');

    const inventory = await runtime.router.invoke({ id: 'inv-3d', name: 'get_inventory', arguments: '{}' });
    expect(inventory.result).toMatchObject({ count: 1, source: 'simulated' });
    // The legacy bridge inventory was never used as the 3D body's inventory.
    expect(bridge.inventory).toBe(8);

    await runtime.router.invoke({ id: 'remember-3d', name: 'remember_place', arguments: JSON.stringify({ placeId: 'deep', payload: { x: 0, y: 0, z: 4 } }) });
    const returned = await runtime.router.invoke({ id: 'return-3d', name: 'start_skill', arguments: JSON.stringify({ skill: 'return_to_place', placeId: 'deep' }) });
    expect(returned.ok).toBe(true);
    expect(poseBlock(body.currentPose)).toEqual({ x: 0, y: 0, z: 4 });
  });

  it('does not advertise navigate_to on the legacy profile because the public tool requires x/y/z', async () => {
    const runtime = track(createRuntime({ clock: new ManualClock() }));
    expect(runtime.router.availableSkills()).not.toContain('navigate_to');
    const catalog = await runtime.router.invoke({ id: 'find-legacy', name: 'find_skills', arguments: JSON.stringify({ query: 'navigate' }) });
    expect(catalog.result).toEqual([]);
  });

  it('persists a durable dispatch barrier for collect_nearby', async () => {
    const bridge = new FakeClientBridge(16);
    bridge.seedDrop(0, 0, 'stone');
    const runtime = track(createRuntime({ bridge, clock: new ManualClock() }));
    const collected = await runtime.router.invoke({ id: 'collect-effect', name: 'start_skill', arguments: JSON.stringify({ skill: 'collect_nearby' }) });
    expect(collected.ok).toBe(true);
    const effects = runtime.store.listEffects();
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      status: 'confirmed',
      intent: { kind: 'collect' },
      evidence: { barrier: 'pre-dispatch' },
    });
    const execution = runtime.store.getExecution((collected.result as { executionId: string }).executionId);
    expect(execution).toMatchObject({ status: 'succeeded', outcome: 'confirmed' });
  });

  it('does not confirm a 3D dig without collection evidence', async () => {
    const { clock, world, adapter } = make3D();
    world.setBlock({ x: 1, y: 0, z: 3 }, 'full_cube', 'coal_ore');
    const noDrop: BodyAdapter = {
      context: adapter.context, capabilities: adapter.capabilities, source: adapter.source, clock: adapter.clock,
      inventory: adapter.inventory,
      observe: () => adapter.observe(), peek: () => adapter.peek(), advance: ticks => adapter.advance!(ticks),
      submit: plan => adapter.submit(plan), release: owner => adapter.release(owner),
      findBlock: block => adapter.findBlock!(block), findPlace: placeId => adapter.findPlace!(placeId),
      digBlock: async (pos, block) => {
        const result = await adapter.digBlock!(pos, block);
        // The block disappears, but this body has no evidence that it received the item.
        return { ...result, collected: 0, items: [] };
      },
    };
    const runtime = track(createRuntime({ profile: 'simulated', bridge: new FakeClientBridge(16, { context }), clock, bodyAdapter: noDrop }));
    const result = await runtime.router.invoke({ id: 'gather-no-drop', name: 'start_skill', arguments: JSON.stringify({ skill: 'gather_blocks', block: 'coal_ore' }) });
    expect(result.ok).toBe(false);
    expect(result.result).toMatchObject({ outcome: 'partial', reason: 'collection-not-observed' });
    expect(world.get({ x: 1, y: 0, z: 3 }).cell).toBe('free');
    expect(runtime.store.listEffects()).toEqual([expect.objectContaining({ status: 'partial' })]);
  });

  it('uses the injected Motor writer factory in the public 3D chain', async () => {
    const { clock, adapter } = make3D();
    let created = 0;
    const runtime = track(createRuntime({
      profile: 'simulated',
      bridge: new FakeClientBridge(16, { context }),
      clock,
      bodyAdapter: adapter,
      motor: deps => { created += 1; return new Motor3D(deps); },
    }));
    const result = await runtime.router.invoke({ id: 'injected-motor', name: 'start_skill', arguments: JSON.stringify({ skill: 'navigate_to', x: 1, y: 0, z: 1 }) });
    expect(result.ok).toBe(true);
    expect(created).toBeGreaterThan(0);
  });

  it('uses the injected legacy navigation port for planar return_to_place', async () => {
    const bridge = new FakeClientBridge(16);
    const calls: Array<{ x: number; y: number }> = [];
    const runtime = track(createRuntime({
      bridge,
      clock: new ManualClock(),
      nav: { navigate: (targetBridge, target, budget) => { calls.push({ ...target }); return navigate(targetBridge, target, budget); } },
    }));
    await runtime.router.invoke({ id: 'remember-planar', name: 'remember_place', arguments: JSON.stringify({ placeId: 'planar', payload: { x: 2, y: 0 } }) });
    const result = await runtime.router.invoke({ id: 'return-planar', name: 'start_skill', arguments: JSON.stringify({ skill: 'return_to_place', placeId: 'planar' }) });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ x: 2, y: 0 }]);
    expect(bridge.position).toEqual({ x: 2, y: 0 });
  });

  it('assembles the public simulated-3d profile with one shared 3D body', async () => {
    const runtime = track(createRuntime({ profile: 'simulated-3d', clock: new ManualClock() }));
    expect(runtime.bodyAdapter).toBeDefined();
    expect(runtime.bodyAdapter?.source).toBe('simulated');
    expect(runtime.control.status().body).toMatchObject({ mode: '3d', threeDimensional: true, legacy2d: false });
    const result = await runtime.router.invoke({ id: 'public-3d', name: 'start_skill', arguments: JSON.stringify({ skill: 'navigate_to', x: 2, y: 0, z: 2 }) });
    expect(result.ok).toBe(true);
    expect(poseBlock(runtime.bodyAdapter!.peek!().pose)).toEqual({ x: 2, y: 0, z: 2 });
    expect(runtime.bridge.position).toEqual({ x: 0, y: 0 });
    expect(() => createRuntime({ profile: 'not-a-profile' as never })).toThrow('unknown-profile');
  });

  it('rejects an adapter whose context does not match the bridge', () => {
    const { adapter } = make3D();
    const bridge = new FakeClientBridge(16, { context: { ...context, worldGenerationId: 'other-world' } });
    expect(() => createRuntime({ profile: 'simulated', bridge, bodyAdapter: adapter })).toThrow('body-adapter-context-mismatch:worldGenerationId');
  });

  it('never substitutes a simulated adapter for a missing real client body', () => {
    const { adapter } = make3D();
    const clientBridge = {
      context: { ...context, serverProfileId: 'client-offline' },
      capabilities: { source: 'client' },
      size: 16, position: { x: 0, y: 0 }, inventory: 0,
      snapshot: () => { throw new Error('unavailable'); },
      cell: () => 'unknown' as const,
      walk: () => undefined,
      place: () => ({ accepted: false, commandId: 'x', seq: 0 }),
      setUi: () => undefined,
    } as unknown as ClientBridgeCapabilities;
    expect(() => createRuntime({ profile: 'client-offline', bridge: clientBridge, bodyAdapter: adapter })).toThrow('client-offline-requires-real-body');
  });
});

describe('provider gate and canonical provider session', () => {
  it('uses the injected transport with truthful offline metadata and the canonical loop', async () => {
    const transport = new RecordingTransport(openAITool('call-1', 'get_state', '{}'), openAIText('done'));
    const runtime = track(createRuntime({ modelProvider: 'openai', transport, allowModelNetwork: false }));
    expect(runtime.control.provider()).toMatchObject({ provider: 'openai', configured: true, networkEnabled: false, transport: 'fixture' });
    expect(runtime.canonicalProviderPath).toBe(true);
    expect(runtime.providerSession).toBeDefined();
    expect(runtime.loop.providerSession).toBe(runtime.providerSession);

    const result = await runtime.control.command({ requestId: 'msg-1', command: 'message', payload: { text: 'go' } });
    expect(result.state).toBe('terminal');
    expect(transport.requests).toHaveLength(2);
    const history = runtime.providerSession!.history.snapshot();
    expect(history).toContainEqual(expect.objectContaining({ role: 'assistant', toolCalls: [expect.objectContaining({ id: 'call-1', name: 'get_state' })] }));
    expect(history).toContainEqual(expect.objectContaining({ role: 'tool', toolResult: expect.objectContaining({ toolCallId: 'call-1' }) }));
  });

  it('never enables network access when the gate is off and reports the disabled boundary', async () => {
    const runtime = track(createRuntime({ modelProvider: 'openai', allowModelNetwork: false, apiKey: 'sk-not-used' }));
    expect(runtime.control.provider()).toMatchObject({ provider: 'openai', configured: false, networkEnabled: false, transport: 'unavailable' });
    expect(runtime.canonicalProviderPath).toBe(false);
    const result = await runtime.control.command({ requestId: 'msg-off', command: 'message', payload: { text: 'go' } });
    expect(result.state).toBe('terminal');
    expect((result.result as { response?: { stopReason?: string } }).response?.stopReason).toBe('unavailable');
  });
});

describe('knowledge tools through the public router', () => {
  it('registers the three knowledge tools and respects release, bounds and unknown coverage', async () => {
    const runtime = track(createRuntime());
    runtime.knowledge.publish(knowledgeRelease('release-int-1', '1', 1.5));
    runtime.knowledge.publish(knowledgeRelease('release-int-2', '2', 2.0), false);

    const facts = await runtime.router.invoke({ id: 'k1', name: 'query_knowledge_facts', arguments: JSON.stringify({ predicate: 'block.hardness' }) });
    expect(facts.ok).toBe(true);
    expect(facts.result).toMatchObject({ releaseId: 'release-int-1', items: [{ id: 'rule-1', value: 1.5 }] });

    const sources = await runtime.router.invoke({ id: 'k2', name: 'query_knowledge_sources', arguments: '{}' });
    expect(sources.ok).toBe(true);
    expect(sources.result).toMatchObject({ releaseId: 'release-int-1', unknown: false });
    const coverage = await runtime.router.invoke({ id: 'k3', name: 'query_knowledge_coverage', arguments: '{}' });
    expect(coverage.ok).toBe(true);
    expect(coverage.result).toMatchObject({ scope: 'declared-sources-only' });

    const unknown = await runtime.router.invoke({ id: 'k4', name: 'query_knowledge_facts', arguments: JSON.stringify({ predicate: 'unmapped.predicate' }) });
    expect(unknown.result).toMatchObject({ unknown: true, reason: 'missing-source', items: [] });

    // Bounds are enforced at the tool schema and in the service.
    const oversized = await runtime.router.invoke({ id: 'k5', name: 'query_knowledge_facts', arguments: JSON.stringify({ limit: 999 }) });
    expect(oversized).toMatchObject({ ok: false, error: 'invalid-tool-arguments' });
    const badCursor = await runtime.router.invoke({ id: 'k6', name: 'query_knowledge_facts', arguments: JSON.stringify({ cursor: '20000' }) });
    expect(badCursor.ok).toBe(false);
    expect(badCursor.error).toContain('knowledge-cursor-limit');

    // Fixed release: activating release 2 does not change an explicit release-1 read.
    runtime.knowledge.activate('release-int-2');
    const pinned = await runtime.router.invoke({ id: 'k7', name: 'query_knowledge_facts', arguments: JSON.stringify({ releaseId: 'release-int-1' }) });
    expect(pinned.result).toMatchObject({ releaseId: 'release-int-1', items: [{ value: 1.5 }] });
    const active = await runtime.router.invoke({ id: 'k8', name: 'query_knowledge_facts', arguments: '{}' });
    expect(active.result).toMatchObject({ releaseId: 'release-int-2', items: [{ value: 2 }] });

    // The old silently-diverging tool name is gone.
    const retired = await runtime.router.invoke({ id: 'k9', name: 'query_knowledge', arguments: '{}' });
    expect(retired).toMatchObject({ ok: false, error: 'unknown-tool' });
  });
});

describe('scoped memory places for return_to_place', () => {
  it('uses scoped memory for return_to_place on an attached 3D body', async () => {
    const { clock, body, adapter } = make3D();
    const bridge = new FakeClientBridge(16, { context });
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock, bodyAdapter: adapter }));
    await runtime.router.invoke({ id: 'p3d-remember', name: 'remember_place', arguments: JSON.stringify({ placeId: 'spot', payload: { x: 1, y: 0 } }) });
    const result = await runtime.router.invoke({ id: 'p3d-return', name: 'start_skill', arguments: JSON.stringify({ skill: 'return_to_place', placeId: 'spot' }) });
    expect(result.ok).toBe(true);
    expect((result.result as { outcome?: string }).outcome).toBe('confirmed');
    expect(poseBlock(body.currentPose)).toEqual({ x: 1, y: 0, z: 0 });
    // The 3D body moved; the legacy 2D bridge did not.
    expect(bridge.position).toEqual({ x: 0, y: 0 });
  });

  it('resolves a current in-scope place and rejects stale or foreign places', async () => {
    const clock = new ManualClock();
    const bridge = new FakeClientBridge(12, { context });
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock }));
    const remembered = await runtime.router.invoke({ id: 'p1', name: 'remember_place', arguments: JSON.stringify({ placeId: 'home', payload: { x: 1, y: 0 } }) });
    expect(remembered.ok).toBe(true);

    const returned = await runtime.router.invoke({ id: 'p2', name: 'start_skill', arguments: JSON.stringify({ skill: 'return_to_place', placeId: 'home' }) });
    expect(returned.ok).toBe(true);
    expect((returned.result as { outcome?: string }).outcome).toBe('confirmed');
    expect(bridge.position).toEqual({ x: 1, y: 0 });

    // The same place is scoped; a foreign-scope place is not a navigation target.
    const foreign = runtime.memory.rememberPlace({ placeId: 'foreign', context: { serverProfileId: 'simulated', worldGenerationId: 'other-world', dimensionId: 'overworld' }, payload: { x: 2, y: 0 } });
    expect(foreign.placeId).toBe('foreign');
    expect(runtime.control.places().map(place => place.placeId)).toEqual(['home']);
    const wrongScope = await runtime.router.invoke({ id: 'p3', name: 'start_skill', arguments: JSON.stringify({ skill: 'return_to_place', placeId: 'foreign' }) });
    expect(wrongScope.ok).toBe(false);
    expect(bridge.position).toEqual({ x: 1, y: 0 });
    const scopedMemory = await runtime.router.invoke({ id: 'p4', name: 'query_memory', arguments: '{}' });
    expect((scopedMemory.result as { scope?: unknown }).scope).toMatchObject({ serverProfileId: 'simulated', worldGenerationId: 'world-1', dimensionId: 'overworld' });

    // Staleness fails closed before legacy navigation.
    clock.advance(6 * 60_000);
    const stale = await runtime.router.invoke({ id: 'p5', name: 'start_skill', arguments: JSON.stringify({ skill: 'return_to_place', placeId: 'home' }) });
    expect(stale.ok).toBe(false);
    expect(String(stale.error)).toMatch(/place-stale/);
    expect(bridge.position).toEqual({ x: 1, y: 0 });
  });
});

describe('P09 service orchestration exposure and control/server surfacing', () => {
  it('attaches a BridgeService orchestration to the runtime factory and stops it on close', async () => {
    const service = new BridgeService({});
    const runtime = track(createRuntime({ bridgeService: { service } }));
    expect(runtime.bridgeService).toBe(service);
    await runtime.startBridgeService!();
    expect(service.state).toBe('running');
    runtime.close();
    await new Promise(resolve => setImmediate(resolve));
    expect(service.state).toBe('stopped');
  });

  it('serves 3D body state through the public status route', async () => {
    const { clock, adapter } = make3D({ start: { x: 0.5, y: 0, z: 0.5 } });
    const bridge = new FakeClientBridge(16, { context });
    const runtime = track(createRuntime({ profile: 'simulated', bridge, clock, bodyAdapter: adapter }));
    const server = createControlServer(runtime);
    await server.listen({ port: 0, host: '127.0.0.1' });
    try {
      const address = server.server.address();
      if (!address || typeof address === 'string') throw new Error('server-address-unavailable');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/status`);
      expect(response.status).toBe(200);
      const status = await response.json() as { body?: Record<string, unknown>; observation?: Record<string, unknown> };
      expect(status.body).toMatchObject({ mode: '3d', threeDimensional: true, z: 0.5, dimension: 'overworld' });
      expect(status.observation).toMatchObject({ threeDimensional: true, mode: '3d' });
    } finally { await server.close(); }
  });

  const builtEntry = existsSync(fileURLToPath(new URL('../../dist/bridge/service/entry.js', import.meta.url)));
  it.skipIf(!builtEntry)('exposes the CLI bridge service mode over loopback without claiming a real client body', async () => {
    const upstream = net.createServer(socket => { socket.on('data', chunk => socket.write(chunk)); });
    await new Promise<void>((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
    const targetPort = (upstream.address() as net.AddressInfo).port;
    try {
      const result = await runBridgeServiceCommand({
        relay: { listenHost: '127.0.0.1', listenPort: 0, targetHost: '127.0.0.1', targetPort, allowMinecraftUpstream: true, heartbeatMs: 60 },
        observer: { enabled: true }, shutdownGraceMs: 1_000, helloTimeoutMs: 5_000, maxRestarts: 1, backoffBaseMs: 10,
      }, { entryUrl: new URL('../../dist/bridge/service/entry.js', import.meta.url) });
      expect(result).toMatchObject({ mode: 'service', orchestration: 'bridge-service', network: 'disabled', boundary: 'client-body-unavailable', liveCompatibility: 'not-verified' });
      expect((result.status as { state?: string } | null)?.state).toMatch(/running|degraded/);
      expect(result.shutdown).toMatchObject({ stopped: true });
    } finally { await new Promise<void>(resolve => upstream.close(() => resolve())); }
  }, 30_000);
});
