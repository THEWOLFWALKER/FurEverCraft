import { describe, expect, it } from 'vitest';
import { createBoundedObserver } from '../../src/bridge/observer/bounded.js';

const tick=()=>new Promise<void>(r=>setImmediate(r));

describe('bounded observer',()=>{
 it('assembles fragmented frames and preserves direction state',async()=>{const observer=createBoundedObserver();const events:any[]=[];observer.subscribe(e=>events.push(e));observer.attach('client-to-server',Buffer.from([3,1]));observer.attach('client-to-server',Buffer.from([2,3,9]));await tick();expect(events).toHaveLength(1);expect(events[0]).toMatchObject({kind:'observation',direction:'client-to-server',frameSequence:'1'});expect(observer.state().downstream.byteOffset).toBe('5');});
 it('publishes bounded degradation without affecting caller',()=>{const observer=createBoundedObserver({maxFrameBytes:2});const events:any[]=[];observer.subscribe(e=>events.push(e));observer.attach('server-to-client',Buffer.from([3,1,2,3]));expect(observer.health).toBe('degraded');expect(events[0]).toMatchObject({kind:'observer_gap',gap:{scope:'global',reason:'frame-overflow'}});});
 it('reports precise per-frame offsets for multiple frames in one chunk',async()=>{const observer=createBoundedObserver();const observed:any[]=[];observer.subscribe(e=>{if(e.kind==='observation')observed.push(e);});observer.attach('client-to-server',Buffer.from([2,1,1,3,2,2,2]));await tick();expect(observed.map(e=>[e.frameSequence,e.payload.offsetStart,e.payload.offsetEnd])).toEqual([['1','0','3'],['2','3','7']]);});
 it('enforces the pending frame queue and gap rather than emitting unbounded',async()=>{const observer=createBoundedObserver({maxQueuedFrames:1,taskTimeoutMs:50});const observed:any[]=[];observer.subscribe(async e=>{if(e.kind==='observation'){observed.push(e);await new Promise(r=>setTimeout(r,30));}});observer.attach('client-to-server',Buffer.from([1,1,1,2,2,2]));observer.attach('client-to-server',Buffer.from([3,3,3]));await new Promise(r=>setTimeout(r,120));expect(observed.length).toBeLessThan(3);expect(observer.health).not.toBe('healthy');});
 it('keeps global framing loss sticky until an explicit reset',async()=>{const observer=createBoundedObserver({maxFrameBytes:1,maxQueuedFrames:16});const events:any[]=[];observer.subscribe(e=>events.push(e));observer.attach('client-to-server',Buffer.from([9,1,2,3]));expect(observer.state().downstream.phase).toBe('UNKNOWN');observer.attach('client-to-server',Buffer.from([1,7]));await tick();expect(events.filter(e=>e.kind==='observation')).toHaveLength(0);observer.reset('client-to-server');observer.attach('client-to-server',Buffer.from([1,7]));await tick();expect(events.filter(e=>e.kind==='observation')).toHaveLength(1);});

 it('FEC-401/402 marks phase and compression unsupported with degraded availability',()=>{
  const observer=createBoundedObserver();
  const state=observer.state();
  for(const direction of ['upstream','downstream'] as const){
    expect(state[direction]).toMatchObject({phase:'unsupported',compression:'unsupported',payloadKind:'frame-metadata',availability:'degraded'});
  }
  observer.attach('client-to-server',Buffer.from([1,1]));
  observer.reset('client-to-server');
  expect(observer.state().downstream).toMatchObject({phase:'unsupported',compression:'unsupported',availability:'degraded'});
  // Framing loss is the only known unknown; it must not be silently turned into 'unsupported'.
  observer.markUnknown('framing-loss','server-to-client');
  expect(observer.state().upstream).toMatchObject({phase:'UNKNOWN',availability:'unknown'});
 });
 it('FEC-401/402 reset returns the whole observer to healthy after a queue gap',async()=>{
  const observer=createBoundedObserver({maxQueuedFrames:1,taskTimeoutMs:50});
  observer.subscribe(async()=>{await new Promise(r=>setTimeout(r,20));});
  observer.attach('client-to-server',Buffer.from([1,1,1,2]));await new Promise(r=>setTimeout(r,60));
  expect(observer.health).toBe('degraded');
  observer.reset('client-to-server');
  expect(observer.health).toBe('healthy');
 });
 it('FEC-403 publishes frame metadata only and never claims a decoded packet ID or fields',async()=>{
  const observer=createBoundedObserver();const observed:any[]=[];
  observer.subscribe(e=>{if(e.kind==='observation')observed.push(e);});
  // [length=2][packet-id byte 0x05][payload 0x33] - the leading VarInt is framing, not a packet ID.
  observer.attach('server-to-client',Buffer.from([2,5,0x33]));await tick();
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({kind:'observation',direction:'server-to-client',frameSequence:'1',phase:'unsupported',availability:'degraded',payload:{kind:'frame-metadata',bytes:3,offsetStart:'0',offsetEnd:'3'}});
  expect(observed[0].payload).not.toHaveProperty('packetId');
  expect(observed[0].payload).not.toHaveProperty('fields');
  expect(JSON.stringify(observed[0])).not.toContain('packetId');
  expect(observer.state().upstream.phase).not.toBe('PLAY');
 });
});
