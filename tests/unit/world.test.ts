import { describe, expect, it } from 'vitest';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { WorldState } from '../../src/state/world.js';

describe('W03 world state and fake bridge contracts', () => {
  const context = { serverProfileId:'simulated', worldGenerationId:'world-1', connectionEpoch:'1', bodyEpoch:'1', dimension:'overworld' } as const;
  const observation = (bridge: FakeClientBridge, sequence: string, observedAt=0) => ({ ...bridge.snapshot(), observedAt, sequence, sourceEpoch: bridge.sessionEpoch, ttl: 100 });
  it('keeps queries immutable and rejects session mismatch', () => {
    const bridge = new FakeClientBridge(); const state = new WorldState(context, () => 10);
    state.apply(observation(bridge, '1')); const view = state.snapshot(); view.position.x = 99; view.cells['1,1'] = 'blocked';
    expect(state.snapshot().position.x).toBe(0); expect(state.snapshot().cells['1,1']).toBe('free');
    expect(() => state.apply({ ...observation(bridge, '2'), context:{ ...context, dimension:'nether' } })).toThrow('world-context-mismatch');
  });
  it('marks sequence gaps and only invalidates the affected projection', () => {
    const bridge = new FakeClientBridge(); const state = new WorldState(context);
    state.apply(observation(bridge, '1')); bridge.block(1, 1); const next = state.apply(observation(bridge, '3'));
    expect(next.gap).toBe(true); expect(next.cells['1,1']).toBe('unknown'); expect(next.position).toEqual({x:0,y:0});
  });
  it('marks expired fields stale', () => {
    const bridge = new FakeClientBridge(); const state = new WorldState(context, () => 500);
    const result = state.apply(observation(bridge, '1', 0)); expect(result.fields.position.freshness).toBe('stale'); expect(result.fields.position.available).toBe(false);
  });
  it('injects delayed, failed, dropped, disconnected and ambiguous effects', () => {
    let delayed = 0; const bridge = new FakeClientBridge(12, { delay: ms => { delayed += ms; }, faults: { walk:{fault:'delay',delayMs:7}, place:{fault:'ambiguous'} } });
    bridge.walk(1,0); expect(delayed).toBe(7);
    expect(bridge.place(2,0)).toMatchObject({ accepted:true, ambiguous:true });
    bridge.configureFault('walk', { fault:'failure' }); expect(() => bridge.walk(2,0)).toThrow('bridge-failure');
    bridge.configureFault('walk', { fault:'drop' }); bridge.walk(2,0); expect(bridge.position).toEqual({x:1,y:0});
    bridge.configureFault('snapshot', { fault:'disconnect' }); expect(() => bridge.snapshot()).toThrow('bridge-disconnected'); expect(bridge.sessionEpoch).toBe('1:2');
  });
});
