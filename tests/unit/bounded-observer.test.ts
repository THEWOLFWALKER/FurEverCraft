import { describe, expect, it } from 'vitest';
import { createBoundedObserver } from '../../src/bridge/observer/bounded.js';

describe('bounded observer',()=>{
 it('assembles fragmented frames and preserves direction state',()=>{const observer=createBoundedObserver();const events:any[]=[];observer.subscribe(e=>events.push(e));observer.attach('client-to-server',Buffer.from([3,1]));observer.attach('client-to-server',Buffer.from([2,3,9]));expect(events).toHaveLength(1);expect(events[0]).toMatchObject({kind:'observation',direction:'client-to-server',frameSequence:'1'});expect(observer.state().downstream.byteOffset).toBe('5');});
 it('publishes bounded degradation without affecting caller',()=>{const observer=createBoundedObserver({maxFrameBytes:2});const events:any[]=[];observer.subscribe(e=>events.push(e));observer.attach('server-to-client',Buffer.from([3,1,2,3]));expect(observer.health).toBe('degraded');expect(events[0]).toMatchObject({kind:'observer_gap',gap:{scope:'global',reason:'frame-overflow'}});});
});
