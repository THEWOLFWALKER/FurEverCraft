import { afterEach, describe, expect, it } from 'vitest';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { ManualClock } from '../../src/contracts/index.js';
import { ExecutionAdmission, INPUT_SKILLS, skillRequiresInput } from '../../src/execution/admission.js';
import { createRuntime, type RuntimeAssembly } from '../../src/execution/factory.js';
import { Executor } from '../../src/execution/runtime.js';
import { SimulatedBodyAdapter } from '../../src/fixtures/body-adapter.js';
import { SQLiteStore } from '../../src/persistence/store.js';

const runtimes: RuntimeAssembly[] = [];
const track = (runtime: RuntimeAssembly): RuntimeAssembly => { runtimes.push(runtime); return runtime; };
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.close(); });

const exploreCall = (proposalId: string) => ({
  id: proposalId,
  name: 'start_skill',
  arguments: JSON.stringify({ skill: 'explore_area', radius: 4, proposalId }),
});

describe('Round 5 F1 — input gate covers every input-driving skill', () => {
  it('derives explore_area from manifest resources and fails closed for unregistered skills', () => {
    expect(INPUT_SKILLS.has('explore_area')).toBe(true);
    expect(skillRequiresInput('explore_area')).toBe(true);
    // Observation-only skills do not drive input and are not gated.
    expect(skillRequiresInput('observe_ui')).toBe(false);
    expect(skillRequiresInput('wait_for_condition')).toBe(false);
    // An unmapped skill cannot be proven read-only, so it must pass the input gate.
    expect(skillRequiresInput('unregistered-future-skill')).toBe(true);
  });

  it('rejects explore_area on simulated-3d with inputs disabled without submitting body input', async () => {
    const runtime = track(createRuntime({ profile: 'simulated-3d', clock: new ManualClock(), inputsEnabled: false }));
    const adapter = runtime.bodyAdapter;
    expect(adapter).toBeInstanceOf(SimulatedBodyAdapter);
    expect(runtime.router.availableSkills()).not.toContain('explore_area');

    const result = await runtime.router.invoke(exploreCall('explore-input-off'));
    expect(result).toMatchObject({ ok: false, error: 'input-disabled' });
    // Admission rejects before the executor exists for this proposal, so nothing reached the
    // body, the input arbiter or the effect barrier.
    expect((adapter as SimulatedBodyAdapter).counters.submitted).toBe(0);
    expect(runtime.store.listExecutions()).toHaveLength(0);
    expect(runtime.store.listEffects()).toHaveLength(0);
  });

  it('fails explore_area and unregistered skills before any lease in the executor', async () => {
    const store = new SQLiteStore(':memory:');
    const bridge = new FakeClientBridge();
    let invoked = 0;
    try {
      const executor = new Executor(bridge, store, undefined, { inputsEnabled: () => false });
      const explored = await executor.start('g', 'explore_area', { proposalId: 'explore-exec-off' }, () => {
        invoked += 1;
        return { outcome: 'confirmed' as const };
      });
      expect(invoked).toBe(0);
      expect(explored).toMatchObject({ status: 'failed', reason: 'input-disabled' });

      // Unmapped skills are not assumed read-only: the same pre-lease gate applies.
      const unknown = await executor.start('g', 'unregistered-future-skill', { proposalId: 'unknown-exec-off' }, () => {
        invoked += 1;
        return { outcome: 'confirmed' as const };
      });
      expect(invoked).toBe(0);
      expect(unknown).toMatchObject({ status: 'failed', reason: 'input-disabled' });
      expect(store.listEffects()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('keeps the admission gate consistent for iteration skills and unregistered skills', () => {
    const store = new SQLiteStore(':memory:');
    try {
      const admission = new ExecutionAdmission(store, new FakeClientBridge(), 'owner-round5', () => false);
      expect(admission.check({ skillId: 'explore_area' })).toMatchObject({ ok: false, code: 'input-disabled' });
      expect(admission.check({ skillId: 'unregistered-future-skill' })).toMatchObject({ ok: false, code: 'input-disabled' });
      // A genuinely read-only skill remains startable while input is disabled.
      expect(admission.check({ skillId: 'observe_ui' })).toEqual({ ok: true });
    } finally {
      store.close();
    }
  });
});

describe('Round 5 F1 — skill advertisement honors coordinate space and body', () => {
  it('does not advertise explore_area on a legacy 2D bridge while keeping supported legacy skills', async () => {
    const runtime = track(createRuntime({ clock: new ManualClock() }));
    expect(runtime.bodyAdapter).toBeUndefined();
    const skills = runtime.router.availableSkills();
    expect(skills).not.toContain('explore_area');
    expect(skills).not.toContain('navigate_to');
    // Explicitly supported legacy skills remain advertised.
    expect(skills).toEqual(expect.arrayContaining([
      'observe_ui', 'send_chat', 'place_one', 'wait_for_condition', 'look_at',
      'dig_one', 'collect_nearby', 'gather_blocks', 'return_to_place',
    ]));

    const catalog = await runtime.router.invoke({ id: 'find-legacy-explore', name: 'find_skills', arguments: JSON.stringify({ query: 'explore' }) });
    expect(catalog.ok).toBe(true);
    expect(catalog.result).toEqual([]);
  });

  it('advertises explore_area on the 3D adapter path when inputs are enabled', async () => {
    const runtime = track(createRuntime({ profile: 'simulated-3d', clock: new ManualClock(), inputsEnabled: true }));
    expect(runtime.router.availableSkills()).toContain('explore_area');
    const catalog = await runtime.router.invoke({ id: 'find-3d-explore', name: 'find_skills', arguments: JSON.stringify({ query: 'explore' }) });
    expect(catalog.ok).toBe(true);
    expect((catalog.result as Array<{ id: string }>).map(skill => skill.id)).toEqual(['explore_area']);
  });
});
