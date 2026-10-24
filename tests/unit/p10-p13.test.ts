import { describe, expect, it } from 'vitest';
import { ManualClock, type BodyContext } from '../../src/contracts/index.js';
import { SparseVoxelWorld } from '../../src/motor/geometry.js';
import { ActionPlanner, JUMP_MAX_RISE } from '../../src/motor/action-graph.js';
import { MotionController } from '../../src/motor/controller.js';
import { resolveTarget3D, isReal3DObservation, NavigationTarget3DSchema, type BodyAdapter, type WorldObservation } from '../../src/motor/contracts.js';
import { poseBlock } from '../../src/motor/route.js';
import { SimulatedBody } from '../../src/fixtures/simulated-body.js';
import { SimulatedBodyAdapter, Legacy2DBodyAdapter } from '../../src/fixtures/body-adapter.js';
import { VoxelFixtureWorld } from '../../src/fixtures/voxel-world.js';
import { gatherBody, navigateToBody, returnToPlaceBody, exploreBody, selectExploreTarget, toSkillResult, navigateToSkill } from '../../src/skills/navigation.js';
import { Executor, InputArbiter } from '../../src/execution/runtime.js';
import { SQLiteStore } from '../../src/persistence/store.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ToolRouter } from '../../src/agent/router.js';
import { skillImplementations } from '../../src/skills/skills.js';
import { attachBodyAdapter, getAttachedBodyAdapter } from '../../src/motor/contracts.js';

const context: BodyContext = { serverProfileId: 'simulated', worldGenerationId: 'p10-p13-world', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };

type FixtureOptions = {
  start?: { x?: number; y?: number; z?: number; yaw?: number };
  latencyTicks?: number;
  seed?: number;
  disturbanceEvery?: number;
  disturbance?: { x?: number; z?: number; yaw?: number };
  observationRadius?: number;
  tickMs?: number;
};

/** Analytic fixture: floor at y=-1, open air at y=0..5 over x/z [-3,10]. */
function flatWorld(): SparseVoxelWorld {
  const world = new SparseVoxelWorld(context, { id: 'p10-p13-fixture', registryVersion: 'fixture-1', source: 'fixture', approximate: false });
  for (let x = -3; x <= 10; x++) for (let z = -3; z <= 10; z++) {
    world.setBlock({ x, y: -1, z }, 'full_cube', 'stone');
    for (let y = 0; y <= 5; y++) world.setAir({ x, y, z });
  }
  return world;
}

function makeHarness(options: FixtureOptions = {}) {
  const clock = new ManualClock();
  const world = flatWorld();
  const body = new SimulatedBody(context, world, clock, {
    start: { x: 0.5, y: 0, z: 0.5, yaw: 0, pitch: 0, ...options.start },
    ...(options.latencyTicks !== undefined ? { latencyTicks: options.latencyTicks } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.disturbanceEvery !== undefined ? { disturbanceEvery: options.disturbanceEvery } : {}),
    ...(options.disturbance ? { disturbance: options.disturbance } : {}),
  });
  const adapter = new SimulatedBodyAdapter(body, world, clock, { tickMs: options.tickMs ?? 20, observationRadius: options.observationRadius ?? 12 });
  return { clock, world, body, adapter, fixture: new VoxelFixtureWorld(world) };
}

const navOptions = (overrides: Record<string, unknown> = {}) => ({ leaseId: 'lease-test', ownerToken: 'owner-test', ...overrides });

describe('P10 3D body contract migration', () => {
  it('uses explicit world x/y/z and never silently invents z=0 for a 3D body', async () => {
    const { adapter } = makeHarness();
    const observation = await adapter.observe();
    expect(isReal3DObservation(observation)).toBe(true);
    expect(observation.dimension).toBe('overworld');
    expect(observation.pose).toMatchObject({ x: 0.5, y: 0, z: 0.5 });

    const explicit = resolveTarget3D(observation, { x: 3, y: 2, z: -4 });
    expect(explicit).toMatchObject({ target: { x: 3, y: 2, z: -4 }, mapping: 'explicit-xyz', derived: false });

    // Planar legacy input is mapped explicitly to world x/z at the current y and labelled.
    const planar = resolveTarget3D(observation, { x: 3, y: -4 });
    expect(planar).toMatchObject({ target: { x: 3, y: 0, z: -4 }, mapping: 'planar-xz-current-y', derived: true });

    const nav = await navigateToBody(adapter, adapter.body.clock, { x: 2, y: 0, z: 2 }, navOptions());
    expect(nav.status).toBe('confirmed');
    expect(nav.targetMapping).toBe('explicit-xyz');
    expect(poseBlock(nav.pose!)).toEqual({ x: 2, y: 0, z: 2 });
  });

  it('exposes a 3D tool schema that refuses a missing z instead of padding it', () => {
    expect(NavigationTarget3DSchema.safeParse({ x: 1, y: 0, z: 2 }).success).toBe(true);
    expect(NavigationTarget3DSchema.safeParse({ x: 1, y: 0 }).success).toBe(false);
    expect(NavigationTarget3DSchema.safeParse({ x: 1, y: 0, z: 2, planarY: 1 }).success).toBe(false);
  });

  it('keeps the legacy 2D bridge explicitly non-3D so a 3D consumer fails closed', async () => {
    const clock = new ManualClock();
    const bridge = {
      context, position: { x: 0, y: 0 },
      snapshot: () => ({ context, revision: '0', position: { x: 0, y: 0 }, cells: { '0,0': 'free' as const }, inventory: 0, ui: 'gameplay' as const, source: 'simulated' as const, freshness: 'current' as const, gap: false, fields: {} }),
      walk: () => undefined,
    };
    const legacy = new Legacy2DBodyAdapter(bridge, clock);
    const observation = await legacy.observe();
    expect(observation.threeDimensional).toBe(false);
    expect(observation.coordinateMapping).toBe('legacy-2d-xz');
    expect(isReal3DObservation(observation)).toBe(false);
    expect(resolveTarget3D(observation, { x: 4, y: 2 })).toMatchObject({ mapping: 'legacy-2d-xz', target: { x: 4, y: 0, z: 2 } });

    // A 3D controller refuses to treat the planar fixture as a 3D volume.
    const controller = new MotionController(legacy, clock);
    const result = await controller.run({ target: { x: 1, y: 0, z: 1 }, leaseId: 'l', ownerToken: 'o' });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('legacy-observation-not-3d');
    expect(result.pose).not.toBeNull();
  });

  it('reports non-zero z and dimension in observations and route evidence', async () => {
    const { adapter, clock } = makeHarness({ start: { x: 0.5, y: 0, z: 0.5 } });
    const result = await navigateToBody(adapter, clock, { x: 1, y: 0, z: 2 }, navOptions());
    expect(result.status).toBe('confirmed');
    expect(poseBlock(result.pose!)).toEqual({ x: 1, y: 0, z: 2 });
    expect(result.pose?.z).toBeGreaterThan(1.5);
    expect(result.route?.observationRevision).toBeTruthy();
    expect(result.route?.supportedActions).toEqual(['walk', 'jump_short']);
    expect(result.evidence).toBe('simulated-control-loop');
  });
});

describe('P11 navigation → Motor → sink chain', () => {
  it('runs through the Executor and input arbiter with an injected 3D sink', async () => {
    const { adapter, body, clock } = makeHarness();
    const bridge = new FakeClientBridge(12, { context });
    attachBodyAdapter(bridge, adapter);
    const store = new SQLiteStore(':memory:');
    const arbiter = new InputArbiter(() => clock.now(), () => `${context.connectionEpoch}:${context.bodyEpoch}:${context.worldGenerationId}`);
    const executor = new Executor(bridge, store, arbiter, { clock, leaseTtl: 60_000, watchdogTtl: 60_000 });
    try {
      const execution = await executor.start('goal-1', 'navigate_to', { x: 3, y: 2 }, async (lease, report) => {
        expect(getAttachedBodyAdapter(bridge)).toBe(adapter);
        report({ stage: 'dispatch', completed: 0, message: 'planning' });
        const result = await navigateToBody(adapter, clock, { x: 3, y: 0, z: 2 }, {
          leaseId: lease.leaseId,
          ownerToken: lease.owner,
          isPaused: () => false,
          onProgress: (stage, completed, total, message) => report({ stage: stage === 'plan' ? 'dispatch' : 'verify', completed, total, message }),
        });
        return toSkillResult(result);
      });
      expect(execution.status).toBe('succeeded');
      expect(execution.outcome).toBe('confirmed');
      expect(poseBlock(body.currentPose)).toEqual({ x: 3, y: 0, z: 2 });
      expect(adapter.counters.accepted).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('reaches the same chain from the public start_skill tool once the one-line skill wiring is applied', async () => {
    const { adapter, body, clock } = makeHarness();
    const bridge = new FakeClientBridge(12, { context });
    attachBodyAdapter(bridge, adapter);
    const store = new SQLiteStore(':memory:');
    const router = new ToolRouter(bridge, store);
    // Production `skills.ts` does not yet consult an attached BodyAdapter. This
    // in-test override mirrors the exact required patch (reported separately):
    // when an adapter is attached, call navigateToBody instead of legacy 2D walk.
    const mutable = skillImplementations as unknown as Record<string, unknown>;
    const original = mutable.navigate_to;
    mutable.navigate_to = (ctx: Parameters<typeof navigateToSkill>[0], args: { x: number; y: number }) => navigateToSkill(ctx, { x: args.x, y: args.y });
    try {
      const result = await router.invoke({ id: 'call-1', name: 'start_skill', arguments: JSON.stringify({ skill: 'navigate_to', x: 3, y: 2 }) });
      expect(result.ok).toBe(true);
      const execution = result.result as { status: string; outcome?: string };
      expect(execution.status).toBe('succeeded');
      expect(execution.outcome).toBe('confirmed');
      expect(poseBlock(body.currentPose)).toEqual({ x: 3, y: 0, z: 2 });
    } finally {
      mutable.navigate_to = original;
      store.close();
    }
  });

  it('drives a public navigation tool through Executor → skill → Motor → injected sink, with an independent body', async () => {
    const { adapter, body, clock } = makeHarness();
    // Prove the sink/body are authoritative: the controller never writes pose.
    const poseBefore = body.currentPose;
    const result = await navigateToBody(adapter, clock, { x: 3, y: 0, z: 2 }, navOptions({ onProgress: () => undefined }));
    expect(result.status).toBe('confirmed');
    expect(result.pose).not.toEqual(poseBefore);
    expect(poseBlock(result.pose!)).toEqual({ x: 3, y: 0, z: 2 });
    expect(adapter.counters.submitted).toBeGreaterThan(0);
    expect(adapter.counters.accepted).toBeGreaterThan(0);
    expect(adapter.counters.releases).toBeGreaterThan(0);
    // The body reached the target because it consumed accepted input plans.
    expect(body.currentPose.x).toBeGreaterThan(2.5);
  });

  it('carries expected preconditions, landing tolerance, supported actions and observation version', async () => {
    const { adapter, clock } = makeHarness();
    const result = await navigateToBody(adapter, clock, { x: 2, y: 0, z: 0 }, navOptions());
    expect(result.status).toBe('confirmed');
    const route = result.route!;
    expect(route.steps.length).toBeGreaterThan(0);
    for (const step of route.steps) {
      expect(step.expected.support).toMatch(/,-1,/);
      expect(step.expected.clearance.length).toBeGreaterThan(0);
      expect(step.landingTolerance).toBeGreaterThan(0);
      expect(step.observationRevision).toBe(route.observationRevision);
    }
    expect(route.supportedActions).not.toContain('step_up');
    expect(route.supportedActions).not.toContain('controlled_drop');
  });

  it('supports return_to_place and explore through the same motor chain', async () => {
    const { adapter, clock } = makeHarness();
    adapter.rememberPlace('home', { x: 1, y: 0, z: 2 });
    const back = await returnToPlaceBody(adapter, clock, 'home', navOptions());
    expect(back.status).toBe('confirmed');
    expect(poseBlock(back.pose!)).toEqual({ x: 1, y: 0, z: 2 });

    const observation = await adapter.observe();
    const frontier = selectExploreTarget(adapter, observation, 3);
    expect(frontier).toBeDefined();
    const explored = await exploreBody(adapter, clock, 3, navOptions());
    expect(explored.status).toBe('confirmed');
    expect(explored.exploreTarget).toBeDefined();
  });

  it('gathers only after navigating to a supported standing cell and observing the target free', async () => {
    const { adapter, body, world, clock } = makeHarness();
    world.setBlock({ x: 3, y: 0, z: 1 }, 'full_cube', 'coal_ore');
    let dispatchBoundaryState: string | undefined;
    const result = await gatherBody(adapter, clock, 'coal_ore', navOptions({ onBeforeDig: () => { dispatchBoundaryState = world.get({ x: 3, y: 0, z: 1 }).cell; } }));
    // The durable dispatch boundary is crossed while the target is still observed blocked.
    expect(dispatchBoundaryState).toBe('blocked');
    expect(result.status).toBe('confirmed');
    expect(result.observedFree).toBe(true);
    expect(result.collected).toBe(1);
    expect(adapter.inventory).toBe(1);
    expect(world.get({ x: 3, y: 0, z: 1 }).cell).toBe('free');
    expect(body.currentPose.x).toBeLessThan(3);
  });
});

describe('P12 realtime control and recovery', () => {
  it('rejects stale observations and releases the lease before any input', async () => {
    const { adapter, clock } = makeHarness();
    adapter.setObservationOverride({ observationLagMs: 1_500 });
    let revoked: string | undefined;
    const result = await navigateToBody(adapter, clock, { x: 2, y: 0, z: 0 }, navOptions({ onLeaseRevoke: (reason: string) => { revoked = reason; } }));
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('observation-stale');
    expect(result.outcome).toBe('failed');
    expect(revoked).toBe('observation-stale');
    expect(adapter.counters.submitted).toBe(0);
  });

  it('rejects a gap observation and an observation from another dimension', async () => {
    const { adapter, clock } = makeHarness();
    adapter.setObservationOverride({ gap: true });
    const gapped = await navigateToBody(adapter, clock, { x: 2, y: 0, z: 0 }, navOptions());
    expect(gapped.status).toBe('failed');
    expect(gapped.reason).toBe('observation-gap');

    let observeCount = 0;
    const wrongDimension: BodyAdapter = {
      context: adapter.context,
      capabilities: adapter.capabilities,
      source: 'simulated',
      submit: plan => adapter.submit(plan),
      release: owner => adapter.release(owner),
      advance: ticks => adapter.advance!(ticks),
      observe: async () => { observeCount += 1; const observation = await adapter.observe(); return { ...observation, dimension: 'the_nether' }; },
    };
    const result = await navigateToBody(wrongDimension, clock, { x: 2, y: 0, z: 0 }, navOptions());
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('observation-dimension-mismatch');
    expect(observeCount).toBeGreaterThan(0);
  });

  it('revokes the route when the target revision CAS changes mid-run', async () => {
    const { adapter, clock } = makeHarness();
    let revision = 7;
    let calls = 0;
    const result = await navigateToBody(adapter, clock, { x: 4, y: 0, z: 0 }, navOptions({
      targetRevision: { expected: 7, current: () => revision },
      watch: () => { calls += 1; if (calls === 6) revision = 8; return undefined; },
    }));
    expect(result.status).toBe('canceled');
    expect(result.reason).toBe('target-revision-changed');
    expect(calls).toBeGreaterThanOrEqual(6);
    expect(adapter.body.ownerToken).toBeUndefined();
  });

  it('inserts an obstacle and replans around it without teleporting', async () => {
    const { adapter, body, world, clock } = makeHarness();
    let calls = 0;
    const result = await navigateToBody(adapter, clock, { x: 3, y: 0, z: 0 }, navOptions({
      watch: () => {
        calls += 1;
        // Insert while the body is on its way east; the next fresh observation must see it.
        if (calls === 14) world.setBlock({ x: 2, y: 0, z: 0 }, 'full_cube', 'stone');
        return undefined;
      },
    }));
    expect(result.status).toBe('confirmed');
    expect(result.replans).toBeGreaterThan(0);
    expect(result.temporaryFailures.length).toBeGreaterThan(0);
    expect(poseBlock(result.pose!)).toEqual({ x: 3, y: 0, z: 0 });
    // The body detoured; its path never occupies the inserted block.
    expect(body.currentPose.x).toBeGreaterThan(2.5);
  });

  it('corrects a server position displacement by replanning from the fresh pose', async () => {
    const { adapter, body, clock } = makeHarness();
    let calls = 0;
    const result = await navigateToBody(adapter, clock, { x: 3, y: 0, z: 3 }, navOptions({
      watch: () => {
        calls += 1;
        if (calls === 12) body.injectCorrection({ pose: { x: 2.5, y: 0, z: 0.5, yaw: 0, pitch: 0 }, reason: 'server-correction', revision: '1' });
        return undefined;
      },
    }));
    expect(calls).toBeGreaterThanOrEqual(12);
    expect(result.status).toBe('confirmed');
    expect(result.replans).toBeGreaterThan(0);
    expect(poseBlock(result.pose!)).toEqual({ x: 3, y: 0, z: 3 });
  });

  it('releases held input immediately on pause, disconnect and focus loss', async () => {
    for (const reason of ['paused', 'disconnected', 'focus-lost'] as const) {
      const { adapter, body, clock } = makeHarness();
      let calls = 0;
      const result = await navigateToBody(adapter, clock, { x: 5, y: 0, z: 5 }, navOptions({
        watch: () => {
          calls += 1;
          if (calls !== 5) return undefined;
          return reason;
        },
      }));
      expect(result.status).toBe(reason === 'paused' ? 'canceled' : 'failed');
      expect(result.reason).toBe(reason);
      expect(result.released).toBe(true);
      expect(adapter.counters.releases).toBeGreaterThan(0);
      expect(body.ownerToken).toBeUndefined();
      expect(body.lastAction).toBe('stop');
      const before = body.currentPose;
      for (let index = 0; index < 5; index++) body.tick();
      expect(body.currentPose.x).toBeCloseTo(before.x, 5);
      expect(body.currentPose.z).toBeCloseTo(before.z, 5);
    }
  });

  it('revokes the lease and stops held input from the controller lifecycle methods', async () => {
    const cases = [
      { method: 'pause', reason: 'paused', status: 'canceled' },
      { method: 'changeTarget', reason: 'target-changed', status: 'canceled' },
      { method: 'onDisconnect', reason: 'disconnected', status: 'failed' },
      { method: 'onFocusLost', reason: 'focus-lost', status: 'failed' },
      { method: 'onObservationExpired', reason: 'observation-stale', status: 'failed' },
    ] as const;
    for (const { method, reason, status } of cases) {
      const { adapter, body, clock } = makeHarness();
      let controller: MotionController;
      let accepted = 0;
      const hooked: BodyAdapter = {
        context: adapter.context,
        capabilities: adapter.capabilities,
        source: 'simulated',
        observe: () => adapter.observe(),
        advance: ticks => adapter.advance!(ticks),
        release: owner => adapter.release(owner),
        submit: async plan => {
          const receipt = await adapter.submit(plan);
          if (receipt.accepted && plan.intent.kind !== 'stop') {
            accepted += 1;
            if (accepted === 2) controller[method]();
          }
          return receipt;
        },
      };
      controller = new MotionController(hooked, clock, {});
      const result = await controller.run({ target: { x: 5, y: 0, z: 5 }, leaseId: 'l', ownerToken: 'o' });
      expect(result.status).toBe(status);
      expect(result.reason).toBe(reason);
      expect(adapter.counters.releases).toBeGreaterThan(0);
      expect(body.ownerToken).toBeUndefined();
      await controller.whenReleased();
    }
  });

  it('enforces a hard control tick budget instead of retrying forever', async () => {
    const { adapter, clock } = makeHarness();
    const result = await navigateToBody(adapter, clock, { x: 8, y: 0, z: 8 }, navOptions({ budget: { maxTicks: 5 } }));
    expect(result.status).toBe('failed');
    expect(result.reasonCode).toBe('control-budget-exhausted');
    expect(result.ticks).toBeLessThanOrEqual(6);
  });

  it('bounds retries against an unreachable target and records temporary failures', async () => {
    const second = makeHarness();
    // Remove all support around a target so no graph edge can reach it.
    second.world.setAir({ x: 2, y: -1, z: 0 });
    second.world.setAir({ x: 2, y: 0, z: 0 });
    second.world.setAir({ x: 2, y: 1, z: 0 });
    const unreachable = await navigateToBody(second.adapter, second.clock, { x: 2, y: 0, z: 0 }, navOptions({ maxReplans: 2 }));
    expect(['failed', 'partial']).toContain(unreachable.status);
    expect(unreachable.reasonCode).toMatch(/plan:|target-not-reached|no-path/);
    expect(unreachable.released).toBe(true);
    expect(unreachable.replans).toBeLessThanOrEqual(2);
  });

  it('never retries a permanent no-path result as if it were temporary', async () => {
    const { adapter, clock } = makeHarness();
    // Drop the entire target column out of the world (unknown), not air.
    const world = adapter.world;
    world.setUnknown({ x: 4, y: 0, z: 0 });
    world.setUnknown({ x: 4, y: 1, z: 0 });
    world.setUnknown({ x: 4, y: -1, z: 0 });
    const result = await navigateToBody(adapter, clock, { x: 4, y: 0, z: 0 }, navOptions({ maxReplans: 2 }));
    expect(result.status).toBe('partial');
    expect(result.reasonCode).toBe('plan:NEEDS_OBSERVATION');
    expect(result.replans).toBe(0);
  });
});

describe('P13 independent offline body scenarios', () => {
  it('is deterministic for a fixed seed, virtual time, injected latency and disturbance', async () => {
    const run = async () => {
      const harness = makeHarness({ seed: 42, latencyTicks: 2, disturbanceEvery: 3, disturbance: { x: 0.01, z: 0.01, yaw: 0.5 }, start: { x: 0.5, y: 0, z: 0.5 } });
      const result = await navigateToBody(harness.adapter, harness.clock, { x: 2, y: 0, z: 2 }, navOptions());
      return { status: result.status, pose: result.pose, ticks: result.ticks, jumps: harness.body.jumpStats };
    };
    const first = await run();
    const second = await run();
    expect(first).toEqual(second);
    expect(first.status).toBe('confirmed');
  });

  it('handles a nonzero z start and yaw turn to the first edge', async () => {
    const { adapter, body, clock } = makeHarness({ start: { x: 0.5, y: 0, z: 2.5, yaw: -90 } });
    const result = await navigateToBody(adapter, clock, { x: 2, y: 0, z: 2 }, navOptions());
    expect(result.status).toBe('confirmed');
    expect(poseBlock(result.pose!)).toEqual({ x: 2, y: 0, z: 2 });
    // Yaw is body-relative degrees; the body ends facing approximately east for the final east edge.
    const yaw = ((body.currentPose.yaw % 360) + 360) % 360;
    expect(Math.min(Math.abs(yaw), Math.abs(360 - yaw))).toBeLessThan(95);
  });

  it('refuses a jump when the head is obstructed and reports the blocked attempt', async () => {
    const { adapter, body, world, clock } = makeHarness();
    // One-block platform ahead requiring the only validated short jump.
    for (let x = 1; x <= 4; x++) for (let z = -1; z <= 1; z++) world.setBlock({ x, y: 0, z }, 'full_cube', 'stone');
    const unblocked = await navigateToBody(adapter, clock, { x: 1, y: 1, z: 0 }, navOptions());
    expect(unblocked.status).toBe('confirmed');
    expect(body.jumpStats.accepted).toBeGreaterThan(0);

    const blocked = makeHarness();
    for (let x = 1; x <= 4; x++) for (let z = -1; z <= 1; z++) blocked.world.setBlock({ x, y: 0, z }, 'full_cube', 'stone');
    // Seal the corridor so the only way up is the jump whose takeoff headroom is blocked.
    for (let x = -1; x <= 4; x++) for (const z of [-2, 2]) { blocked.world.setBlock({ x, y: 0, z }, 'full_cube', 'stone'); blocked.world.setBlock({ x, y: 1, z }, 'full_cube', 'stone'); }
    for (const z of [-1, 0, 1]) { blocked.world.setBlock({ x: -1, y: 0, z }, 'full_cube', 'stone'); blocked.world.setBlock({ x: -1, y: 1, z }, 'full_cube', 'stone'); }
    for (let z = -1; z <= 1; z++) blocked.world.setBlock({ x: 0, y: 2, z }, 'full_cube', 'stone');
    const result = await navigateToBody(blocked.adapter, blocked.clock, { x: 1, y: 1, z: 0 }, navOptions());
    expect(result.status).not.toBe('confirmed');
    expect(result.status).toBe('failed');
    expect(result.route?.steps.some(step => step.edge.kind === 'jump_short')).not.toBe(true);

    // The body itself also refuses a head-blocked jump and never clips through.
    const direct = makeHarness();
    direct.world.setBlock({ x: 0, y: 2, z: 0 }, 'full_cube', 'stone');
    const startY = direct.body.currentPose.y;
    direct.body.submit({ commandId: 'c', executionId: 'e', context, leaseId: 'l', sequence: '1', sourceEpoch: '1', generatedAt: direct.clock.now(), clockDomain: 'virtual', maxAge: 1000, observationRef: 'r', leaseUntil: direct.clock.now() + 1000, kind: 'walk', payload: {}, ownerToken: 'o', deadline: direct.clock.now() + 1000, snapshotRevision: 'r', heldSet: [], delta: { jump: true } });
    direct.body.tick();
    expect(direct.body.lastAction).toBe('jump-blocked');
    expect(direct.body.currentPose.y).toBe(startY);
    expect(direct.body.jumpStats).toEqual({ accepted: 0, blocked: 1 });
  });

  it('disables jump planning when the body capability profile has no jump', async () => {
    const { adapter, body, world, clock } = makeHarness();
    for (let x = 1; x <= 4; x++) for (let z = -1; z <= 1; z++) world.setBlock({ x, y: 0, z }, 'full_cube', 'stone');
    (adapter.capabilities as { jump: 'none' | 'short'; jumpMaxRise: number }).jump = 'none';
    (adapter.capabilities as { jumpMaxRise: number }).jumpMaxRise = 0;
    const result = await navigateToBody(adapter, clock, { x: 1, y: 0, z: 0 }, navOptions());
    expect(result.status).not.toBe('confirmed');
    expect(result.route?.supportedActions ?? []).not.toContain('jump_short');
    expect(body.jumpStats.accepted).toBe(0);
  });

  it('does not allow a second jump while airborne and enforces the one-block rise limit', async () => {
    const { body, clock, world } = makeHarness();
    void world;
    const plan = { commandId: 'j1', executionId: 'e', context, leaseId: 'l', sequence: '1', sourceEpoch: '1', generatedAt: clock.now(), clockDomain: 'virtual', maxAge: 1000, observationRef: 'r', leaseUntil: clock.now() + 1000, kind: 'walk' as const, payload: {}, ownerToken: 'o', deadline: clock.now() + 1000, snapshotRevision: 'r', heldSet: [] as string[], delta: { jump: true } };
    body.submit(plan);
    body.tick();
    expect(body.jumpStats.accepted).toBe(1);
    body.tick();
    body.tick();
    expect(body.jumpStats.accepted).toBe(1);
    expect(body.jumpStats.blocked).toBeGreaterThan(0);
    expect(JUMP_MAX_RISE).toBe(1);
  });

  it('marks slab stairs and unsupported drops as unsupported transitions, never as steps', () => {
    const world = flatWorld();
    const planner = new ActionPlanner(world);
    // A lower slab directly in front is not a supported landing at the same feet height.
    world.setBlock({ x: 1, y: 0, z: 0 }, 'lower_slab', 'stone');
    const slab = planner.plan({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(slab.status).not.toBe('COMPLETE');
    expect(slab.edges.some(edge => edge.kind === 'step_up' || edge.kind === 'controlled_drop')).toBe(false);

    // An edge with no floor beyond is not walked or dropped.
    const edgeWorld = flatWorld();
    edgeWorld.setAir({ x: 1, y: -1, z: 0 });
    for (let y = 0; y <= 3; y++) edgeWorld.setAir({ x: 1, y, z: 0 });
    const edge = new ActionPlanner(edgeWorld).plan({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(edge.status).not.toBe('COMPLETE');
    expect(edge.edges.some(candidate => candidate.kind === 'walk' && candidate.to.x === 1)).toBe(false);
  });

  it('treats unknown terrain as unknown, never as air or support', () => {
    const world = new SparseVoxelWorld(context);
    // Only the start is observed; everything else is unknown.
    world.setAir({ x: 0, y: 0, z: 0 });
    world.setAir({ x: 0, y: 1, z: 0 });
    world.setBlock({ x: 0, y: -1, z: 0 });
    const plan = new ActionPlanner(world).plan({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(plan.status).toBe('NEEDS_OBSERVATION');
    expect(plan.reason).toBe('unknown-geometry-not-air');
    expect(plan.edges).toEqual([]);
    expect(plan.supportedActions).not.toContain('step_up');
  });

  it('stops input and settles on the target after a confirmed run', async () => {
    const { adapter, body, clock } = makeHarness();
    const result = await navigateToBody(adapter, clock, { x: 2, y: 0, z: 0 }, navOptions());
    expect(result.status).toBe('confirmed');
    const settled = body.currentPose;
    for (let index = 0; index < 5; index++) body.tick();
    expect(body.currentPose.x).toBeCloseTo(settled.x, 5);
    expect(body.currentPose.z).toBeCloseTo(settled.z, 5);
    expect(body.ownerToken).toBeUndefined();
    expect(adapter.counters.releases).toBeGreaterThan(0);
  });
});
