import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock, type BodyContext } from '../../src/contracts/index.js';
import { createRuntime } from '../../src/execution/factory.js';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { SimulatedBody } from '../../src/fixtures/simulated-body.js';
import { SimulatedBodyAdapter } from '../../src/fixtures/body-adapter.js';
import { SparseVoxelWorld } from '../../src/motor/geometry.js';
import { collectDoctorReport, unavailableDoctorReport } from '../../src/diagnostics/doctor.js';
import { runDoctorCommand } from '../../src/cli/main.js';

const context: BodyContext = { serverProfileId: 'simulated', worldGenerationId: 'doctor-world', connectionEpoch: '1', bodyEpoch: '1', dimension: 'overworld' };
const cleanup: string[] = [];
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'furevercraft-doctor-'));
  cleanup.push(dir);
  return join(dir, 'state.sqlite');
};
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(profile: 'simulated' | 'client-offline' = 'simulated') {
  const clock = new ManualClock();
  const world = new SparseVoxelWorld(context);
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) world.setBlock({ x, y: -1, z }, 'full_cube', 'stone');
  const body = new SimulatedBody(context, world, clock);
  const adapter = new SimulatedBodyAdapter(body, world, clock);
  const runtime = createRuntime({ profile, bridge: new FakeClientBridge(12, { context }), bodyAdapter: adapter, clock });
  return { runtime, adapter };
}

describe('P21 doctor reports actual Runtime/Store capabilities', () => {
  it('reports a disabled network gate and unavailable provider without inventing a live path', () => {
    const runtime = createRuntime({ modelProvider: 'openai', allowModelNetwork: false, apiKey: 'sk-test-secret' });
    try {
      const report = collectDoctorReport(runtime);
      expect(report.provider).toMatchObject({
        state: 'unavailable', reason: 'network-gate-disabled', provider: 'openai',
        configured: false, transport: 'unavailable', networkEnabled: false,
      });
      expect(report.network).toEqual({ state: 'disabled', reason: 'network-gate-disabled' });
      expect(report.paidModelApi).toEqual({ state: 'disabled', reason: 'offline-batch-paid-api-disabled' });
      expect(report.status).not.toBe('ok');
      expect(JSON.stringify(report)).not.toContain('sk-test-secret');
    } finally { runtime.close(); }
  });

  it('reports a missing credential separately from a disabled network gate', () => {
    const runtime = createRuntime({ modelProvider: 'openai', allowModelNetwork: true });
    try {
      const report = collectDoctorReport(runtime);
      expect(report.provider).toMatchObject({ state: 'unavailable', reason: 'model-provider-not-configured', configured: false, networkEnabled: false });
      expect(report.network).toEqual({ state: 'disabled', reason: 'provider-not-configured' });
      expect(report.warnings).toContain('provider:model-provider-not-configured');
    } finally { runtime.close(); }
  });

  it('reports a configured provider over an injected transport as offline', () => {
    const transport = { post: async () => ({ ok: true }) };
    const runtime = createRuntime({ modelProvider: 'anthropic', apiKey: 'sk-test-secret', transport });
    try {
      const report = collectDoctorReport(runtime);
      expect(report.provider).toMatchObject({ state: 'available', transport: 'fixture', configured: true, networkEnabled: false });
      expect(report.network).toEqual({ state: 'disabled', reason: 'injected-fixture-transport' });
    } finally { runtime.close(); }
  });

  it('distinguishes an attached 3D body from the explicit legacy 2D body', () => {
    const three = harness();
    const legacy = createRuntime({ clock: new ManualClock() });
    try {
      const threeReport = collectDoctorReport(three.runtime);
      expect(threeReport.body).toMatchObject({ state: 'available', mode: '3d', threeDimensional: true, legacy2d: false, source: 'simulated', jump: 'short' });
      expect(threeReport.body.observation).toBeDefined();
      const legacyReport = collectDoctorReport(legacy);
      expect(legacyReport.body).toMatchObject({ state: 'available', reason: 'legacy-2d-body', mode: 'legacy-2d', threeDimensional: false, legacy2d: true, jump: 'none' });
      expect(legacyReport.warnings).toContain('body:legacy-2d-body');
    } finally { three.runtime.close(); legacy.close(); }
  });

  it('reports the real store path, ownership lock, session state and absent optional subsystems', () => {
    const db = tempDb();
    const runtime = createRuntime({ db, clock: new ManualClock() });
    try {
      const report = collectDoctorReport(runtime);
      expect(report.store).toMatchObject({ state: 'available', path: db, durable: true, health: 'ok' });
      expect(report.ownership).toMatchObject({ state: 'available', path: `${db}.owner.lock`, pid: process.pid });
      expect(report.recovery).toMatchObject({ state: 'disabled', reason: 'session-not-started', sessionState: 'idle', attempts: 0, pendingEffects: 0 });
      expect(report.knowledge).toMatchObject({ state: 'unavailable', reason: 'no-active-release', releaseCount: 0 });
      expect(report.bridgeService).toMatchObject({ state: 'unavailable', reason: 'bridge-service-not-attached', attached: false });
      expect(report.external.liveMinecraft).toEqual({ state: 'disabled', reason: 'live-minecraft-not-connected' });
    } finally { runtime.close(); }
  });

  it('reports a runtime that cannot be assembled, and CLI doctor fails honestly for client-offline', () => {
    const direct = unavailableDoctorReport({ profile: 'client-offline', reason: 'client-offline-body-unavailable', dbPath: '/tmp/x.sqlite', generatedAt: 1 });
    expect(direct).toMatchObject({ status: 'unavailable', profile: { id: 'client-offline', simulated: false }, store: { state: 'unavailable' } });
    expect(direct.warnings).toContain('runtime:client-offline-body-unavailable');

    const cli = runDoctorCommand({ profile: 'client-offline', generatedAt: 2 });
    expect(cli.status).toBe('unavailable');
    expect(cli.provider.state).toBe('unavailable');
    expect(cli.warnings.some(warning => warning.startsWith('runtime:'))).toBe(true);
  });

  it('reads the active knowledge release rather than claiming a default knowledge base', () => {
    const runtime = createRuntime({ clock: new ManualClock() });
    try {
      const empty = collectDoctorReport(runtime);
      expect(empty.knowledge).toMatchObject({ state: 'unavailable', reason: 'no-active-release', releaseCount: 0 });
      runtime.knowledge.publish({
        releaseId: 'release-doctor', version: '1.0.0', createdAt: new Date(0).toISOString(),
        manifest: {
          manifestVersion: '1', createdAt: new Date(0).toISOString(),
          sources: [{ sourceId: 'fixture-source', version: '1.0.0', kind: 'fixture', origin: 'test', verified: true, covers: ['block.hardness'], registeredAt: new Date(0).toISOString() }],
        },
        rules: [],
      });
      const report = collectDoctorReport(runtime);
      expect(report.knowledge).toMatchObject({ state: 'available', activeReleaseId: 'release-doctor', activeVersion: '1.0.0', releaseCount: 1 });
      expect(report.knowledge.coverage).toMatchObject({ unknown: false, conflicts: 0, sources: { verified: 1, unverified: 0, total: 1 } });
    } finally { runtime.close(); }
  });

  it('does not start a session or mutate the store while reporting', () => {
    const runtime = createRuntime({ clock: new ManualClock() });
    try {
      const before = runtime.session.state;
      collectDoctorReport(runtime);
      expect(runtime.session.state).toBe(before);
      expect(runtime.store.listExecutions()).toHaveLength(0);
    } finally { runtime.close(); }
  });
});
