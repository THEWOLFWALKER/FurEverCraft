import { describe, expect, it } from 'vitest';
import { FakeClientBridge } from '../../src/bridge/fake/index.js';
import { WorldState } from '../../src/state/world.js';

describe('W03 world state and fake bridge contracts', () => {
  const context = { serverProfileId:'simulated', worldGenerationId:'world-1', connectionEpoch:'1', bodyEpoch:'1', dimension:'overworld' } as const;
  const observation = (bridge: FakeClientBridge, sequence: string, observedAt=0, baseline:'full'|'delta'='delta') => ({ ...bridge.snapshot(), observedAt, sequence, sourceEpoch: bridge.sessionEpoch, ttl: 100, baseline });
  it('keeps queries immutable and rejects session mismatch', () => {
    const bridge = new FakeClientBridge(); const state = new WorldState(context, () => 10);
    state.apply(observation(bridge, '1', 0, 'full')); const view = state.snapshot(); view.position.x = 99; view.cells['1,1'] = 'blocked';
    expect(state.snapshot().position.x).toBe(0); expect(state.snapshot().cells['1,1']).toBe('free');
    expect(() => state.apply({ ...observation(bridge, '2'), context:{ ...context, dimension:'nether' } })).toThrow('world-context-mismatch');
  });
  it('marks sequence gaps and invalidates affected cells', () => {
    const bridge = new FakeClientBridge(); const state = new WorldState(context);
    state.apply(observation(bridge, '1', 0, 'full')); bridge.block(1, 1); const next = state.apply(observation(bridge, '3'));
    expect(next.gap).toBe(true); expect(next.cells['1,1']).toBe('unknown'); expect(next.position).toEqual({x:0,y:0});
  });
  it('marks expired fields stale at read time', () => {
    const bridge = new FakeClientBridge(); const state = new WorldState(context, () => 500);
    const result = state.apply(observation(bridge, '1', 0, 'full')); expect(result.fields.position.freshness).toBe('stale'); expect(result.fields.position.available).toBe(false);
  });
  it('does not treat a delta without a baseline as complete until a full snapshot arrives', () => {
    const bridge = new FakeClientBridge(); const state = new WorldState(context);
    const delta = state.apply(observation(bridge, '1'));
    expect(delta.gap).toBe(true); expect(Object.values(delta.cells).every(cell => cell === 'unknown')).toBe(true);
    const full = state.apply(observation(bridge, '9', 0, 'full'));
    expect(full.gap).toBe(false); expect(full.cells['1,1']).toBe('free');
  });
  it('does not lose previously known cells when a gapped delta omits them', () => {
    const bridge = new FakeClientBridge(); const state = new WorldState(context);
    state.apply(observation(bridge, '1', 0, 'full'));
    bridge.block(3, 3);
    const full = state.apply(observation(bridge, '2', 0, 'full'));
    expect(full.cells['3,3']).toBe('blocked');
    const gapped = state.apply({ ...observation(bridge, '5'), gap: true, cells: { '9,9': 'free' } });
    expect(gapped.cells['3,3']).toBe('unknown');
    expect(gapped.cells['9,9']).toBe('unknown');
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

describe('FEC-481 delta merge', () => {
  const ctx = { serverProfileId:'simulated', worldGenerationId:'world-1', connectionEpoch:'1', bodyEpoch:'1', dimension:'overworld' } as const;
  it('merges a delta instead of deleting cells it did not mention', () => {
    const bridge = new FakeClientBridge(); const state = new WorldState(ctx);
    state.apply({ ...bridge.snapshot(), observedAt: 0, sequence: '1', sourceEpoch: bridge.sessionEpoch, ttl: 100, baseline: 'full' });
    bridge.block(2, 2);
    const delta = state.apply({ ...bridge.snapshot(), observedAt: 0, sequence: '2', sourceEpoch: bridge.sessionEpoch, ttl: 100 });
    expect(delta.cells['2,2']).toBe('blocked');
    // A partial delta touching one cell keeps the other known cells.
    const partial = state.apply({ ...bridge.snapshot(), cells: { '0,0': 'blocked' }, observedAt: 0, sequence: '3', sourceEpoch: bridge.sessionEpoch, ttl: 100 });
    expect(partial.cells['2,2']).toBe('blocked');
    expect(partial.cells['0,0']).toBe('blocked');
  });
});

describe('FEC-491/492 invalidate scope', () => {
  const ctx = { serverProfileId:'simulated', worldGenerationId:'world-1', connectionEpoch:'1', bodyEpoch:'1', dimension:'overworld' } as const;
  it('marks every known cell unknown on the default cells scope', () => {
    const bridge = new FakeClientBridge(4); const state = new WorldState(ctx);
    bridge.block(1, 1); bridge.block(2, 2);
    const full = state.apply({ ...bridge.snapshot(), observedAt: 0, sequence: '1', sourceEpoch: bridge.sessionEpoch, ttl: 100, baseline: 'full' });
    expect(full.cells['1,1']).toBe('blocked'); expect(full.cells['0,0']).toBe('free');
    const out = state.invalidate();
    expect(out.gap).toBe(true); expect(out.freshness).toBe('unknown');
    expect(Object.keys(out.cells).length).toBeGreaterThan(0);
    expect(Object.values(out.cells).every(cell => cell === 'unknown')).toBe(true);
    expect(state.snapshot().cells['1,1']).toBe('unknown');
    expect(Object.values(out.fields).every(field => field.available === false)).toBe(true);
    // Deltas that arrive while the gap is sticky keep every known key unknown.
    const delta = state.apply({ ...bridge.snapshot(), observedAt: 0, sequence: '2', sourceEpoch: bridge.sessionEpoch, ttl: 100 });
    expect(delta.gap).toBe(true);
    expect(delta.cells['2,2']).toBe('unknown'); expect(delta.cells['0,0']).toBe('unknown');
  });
  it('treats an explicit cells scope the same as all', () => {
    const bridge = new FakeClientBridge(4); const state = new WorldState(ctx);
    state.apply({ ...bridge.snapshot(), observedAt: 0, sequence: '1', sourceEpoch: bridge.sessionEpoch, ttl: 100, baseline: 'full' });
    for (const scope of ['cells', 'all'] as const) {
      expect(Object.values(state.invalidate('manual', scope).cells).every(cell => cell === 'unknown')).toBe(true);
    }
  });
  it('invalidates cells when a delta arrives for a new source epoch', () => {
    const bridge = new FakeClientBridge(4); const state = new WorldState(ctx);
    state.apply({ ...bridge.snapshot(), observedAt: 0, sequence: '1', sourceEpoch: bridge.sessionEpoch, ttl: 100, baseline: 'full' });
    bridge.disconnect();
    const out = state.apply({ ...bridge.snapshot(), observedAt: 0, sequence: '1', sourceEpoch: bridge.sessionEpoch, ttl: 100 });
    expect(out.gap).toBe(true);
    expect(Object.values(out.cells).every(cell => cell === 'unknown')).toBe(true);
  });
});

describe('FEC-497 observation sequence contract errors', () => {
  const ctx = { serverProfileId:'simulated', worldGenerationId:'world-1', connectionEpoch:'1', bodyEpoch:'1', dimension:'overworld' } as const;
  it.each(['abc', '1.5', '-1', '', ' 1', '1e3', '0x10', '12a', '  ', '١'])('rejects the invalid sequence %j as invalid-observation-sequence', (sequence) => {
    const bridge = new FakeClientBridge(4); const state = new WorldState(ctx);
    state.apply({ ...bridge.snapshot(), observedAt: 0, sequence: '5', sourceEpoch: bridge.sessionEpoch, ttl: 100, baseline: 'full' });
    let error: unknown;
    try { state.apply({ ...bridge.snapshot(), observedAt: 0, sequence, sourceEpoch: bridge.sessionEpoch, ttl: 100 }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('invalid-observation-sequence');
    expect((error as Error).name).not.toBe('SyntaxError');
    // The rejected observation does not advance the accepted sequence.
    expect(state.snapshot().gap).toBe(false);
    expect(() => state.apply({ ...bridge.snapshot(), observedAt: 0, sequence: '6', sourceEpoch: bridge.sessionEpoch, ttl: 100, baseline: 'full' })).not.toThrow();
  });
});
