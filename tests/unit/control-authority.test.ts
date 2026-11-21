import { describe, expect, it } from 'vitest';
import { ControlAuthority } from '../../src/execution/control-authority.js';
import { BridgeService } from '../../src/bridge/service/orchestrator.js';

describe('control authority', () => {
  it('requires both an arm decision and current evidence and fences previous generations', () => {
    let ready = true;
    const authority = new ControlAuthority(() => ({ ready, reasons: ready ? [] : ['pose-stale'] }));
    expect(authority.decision().allowed).toBe(false);
    const first = authority.arm(); expect(first.allowed).toBe(true);
    ready = false;
    expect(authority.decision()).toMatchObject({ allowed: false });
    ready = true;
    expect(authority.decision().allowed).toBe(false); // fresh evidence alone cannot resurrect the latch
    const second = authority.arm(); expect(second.generation).toBeGreaterThan(first.generation);
    expect(authority.decision(first.generation)).toMatchObject({ allowed: false, reasons: ['control-generation-changed'] });
  });
  it('fails closed when the evidence evaluator throws or contradicts itself', () => {
    const throwing = new ControlAuthority(() => { throw new Error('unavailable'); });
    expect(throwing.arm().reasons).toContain('control-evidence-unavailable');
    const contradictory = new ControlAuthority(() => ({ ready: true, reasons: ['not-bound'] }));
    expect(contradictory.arm().allowed).toBe(false);
  });
});

describe('authority integrated into BridgeService', () => {
  it('does not accept a reason string as evidence and cannot arm stopped service', async () => {
    const service = new BridgeService(); await service.start();
    expect(service.armControl('fresh-observation').allowed).toBe(false);
    await service.stop();
    expect(service.armControl().allowed).toBe(false);
    const available = new BridgeService({ controlReadiness: () => ({ ready: true, reasons: [] }) });
    expect(available.armControl().allowed).toBe(false);
    await available.start(); expect(available.armControl().allowed).toBe(true);
    await available.stop(); expect(available.armControl().allowed).toBe(false);
  });
  it('revokes local admission and notifies listeners before a hanging helper release', async () => {
    const events: string[] = []; let finish!: () => void;
    const service = new BridgeService({ controlReadiness: () => ({ ready: true, reasons: [] }), shutdownGraceMs: 10,
      helper: { shutdown: async () => undefined, releaseOwnedInputs: () => new Promise<void>(resolve => { finish = resolve; }) } });
    await service.start(); service.armControl(); service.on(e => events.push(e.type!));
    service.onObserverFailure('worker-exit');
    expect(service.status().admissionOpen).toBe(false);
    expect(service.armControl().allowed).toBe(false);
    expect(events).toContain('control-revoked');
    await Promise.resolve(); finish(); await service.stop();
  });
  it('revokes on lost control IPC even when the parent never drains its queue', async () => {
    const events: string[] = [];
    const service = new BridgeService({ controlReadiness: () => ({ ready: true, reasons: [] }), maxIpcMessages: 2, ipc: { send: () => false } });
    await service.start(); service.on(e => events.push(e.type!));
    service.publishObserver({ index: 1 }); service.publishObserver({ index: 2 });
    expect(service.status()).toMatchObject({ admissionOpen: false, ipc: { controlLost: true, globalUnknown: true } });
    expect(service.armControl().allowed).toBe(false);
    expect(events).toContain('ipc-overflow');
    expect(events).toContain('control-revoked');
    await service.stop();
  });
  it('returns one shutdown promise and bounds a release that never settles', async () => {
    const service = new BridgeService({ shutdownGraceMs: 10, helper: { shutdown: async () => undefined, releaseOwnedInputs: () => new Promise(() => undefined) } });
    await service.start();
    const first = service.stop(); expect(service.stop()).toBe(first);
    await first;
    expect(service.status()).toMatchObject({ admissionOpen: false, shutdown: { forced: true } });
  });
  it('reports release and stop failures instead of claiming verified cleanup', async () => {
    const service = new BridgeService({ helper: {
      releaseOwnedInputs: async () => { throw new Error('release failed'); },
      shutdown: async () => { throw new Error('shutdown failed'); },
    } });
    await service.start(); await service.stop();
    expect(service.status().shutdown).toMatchObject({ releaseUncertain: true, errors: ['helper-stop-failed'] });
  });

});
