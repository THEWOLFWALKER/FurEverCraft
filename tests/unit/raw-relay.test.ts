import { describe, expect, it } from 'vitest';
import { createRawTcpRelay } from '../../src/bridge/relay/raw.js';
import net from 'node:net';

function peer(port:number){return new Promise<net.Socket>(resolve=>{const s=net.createConnection(port,'127.0.0.1',()=>resolve(s));});}
function collect(s:net.Socket){const chunks:Buffer[]=[];s.on('data',c=>chunks.push(Buffer.from(c)));return {chunks,all:()=>Buffer.concat(chunks)};}

describe('raw TCP relay fixture',()=>{
 it('forwards bytes in both directions without protocol termination',async()=>{
  const upstream=net.createServer(); const received:Buffer[]=[]; let serverPeer!:net.Socket;
  upstream.on('connection',s=>{serverPeer=s;s.on('data',c=>received.push(Buffer.from(c)));});
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',()=>r())); const target=(upstream.address() as net.AddressInfo).port;
  const relay=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:target,allowMinecraftUpstream:true});await relay.start();
  const client=await peer(relay.address.port); const response=collect(client); const sent=Buffer.from([0,1,2,3,255]);client.write(sent.subarray(0,2));client.write(sent.subarray(2));
  await new Promise(r=>setTimeout(r,20));expect(Buffer.concat(received)).toEqual(sent);serverPeer.write(Buffer.from('reply'));await new Promise(r=>setTimeout(r,20));expect(response.all().toString()).toBe('reply');
  client.end();await relay.stop();await new Promise<void>(r=>upstream.close(()=>r()));
 });
 it('rewrites only the configured first handshake',async()=>{
  const upstream=net.createServer();let received=Buffer.alloc(0);upstream.on('connection',s=>s.on('data',c=>{received=Buffer.concat([received,Buffer.from(c)]);}));await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',()=>r()));
  const relay=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:(upstream.address() as net.AddressInfo).port,allowMinecraftUpstream:true,rewriteHandshake:true});await relay.start();const client=await peer(relay.address.port);
  const body=Buffer.concat([Buffer.from([0]),Buffer.from([0x09]),Buffer.from([3]),Buffer.from('old'),Buffer.from([0x63,0xdd]),Buffer.from([2])]);const frame=Buffer.concat([Buffer.from([body.length]),body,Buffer.from('tail')]);client.write(frame.subarray(0,3));client.write(frame.subarray(3));await new Promise(r=>setTimeout(r,30));expect(received.subarray(-4).toString()).toBe('tail');expect(received.toString()).toContain('127.0.0.1');client.destroy();await relay.stop();await new Promise<void>(r=>upstream.close(()=>r()));
 });
 it('does not close a healthy connection that never backpressures',async()=>{
  const upstream=net.createServer();upstream.on('connection',s=>s.on('data',()=>{}));await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',()=>r()));
  const relay=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:(upstream.address() as net.AddressInfo).port,allowMinecraftUpstream:true,budgets:{writeStallMs:30}});await relay.start();
  const client=await peer(relay.address.port);client.write(Buffer.alloc(32,1));await new Promise(r=>setTimeout(r,80));
  expect(relay.sessions()[0]?.state).not.toBe('failed');expect(client.destroyed).toBe(false);
  client.destroy();await relay.stop();await new Promise<void>(r=>upstream.close(()=>r()));
 });
 it('transitions to forwarding when handshake rewrite is disabled',async()=>{
  const upstream=net.createServer();upstream.on('connection',s=>s.on('data',()=>{}));await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',()=>r()));
  const relay=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:(upstream.address() as net.AddressInfo).port,allowMinecraftUpstream:true});await relay.start();
  const client=await peer(relay.address.port);client.write(Buffer.from([1,2,3]));await new Promise(r=>setTimeout(r,20));
  expect(relay.sessions()[0]?.metrics().state).toBe('forwarding');
  client.destroy();await relay.stop();await new Promise<void>(r=>upstream.close(()=>r()));
 });
 it('removes the session after a clean client EOF',async()=>{
  const upstream=net.createServer();upstream.on('connection',s=>s.on('data',()=>{}));await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',()=>r()));
  const relay=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:(upstream.address() as net.AddressInfo).port,allowMinecraftUpstream:true});await relay.start();
  const client=await peer(relay.address.port);client.end();await new Promise(r=>setTimeout(r,60));
  expect(relay.sessions()).toHaveLength(0);
  await relay.stop();await new Promise<void>(r=>upstream.close(()=>r()));
 });
 it('rejects a handshake whose next-state is not LOGIN or STATUS',async()=>{
  const upstream=net.createServer();let received=Buffer.alloc(0);upstream.on('connection',s=>s.on('data',c=>{received=Buffer.concat([received,Buffer.from(c)]);}));await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',()=>r()));
  const relay=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:(upstream.address() as net.AddressInfo).port,allowMinecraftUpstream:true,rewriteHandshake:true});let session:import('../../src/bridge/relay/raw.js').RelaySession|undefined;relay.onSession(s=>{session=s;});await relay.start();
  const client=await peer(relay.address.port);const body=Buffer.concat([Buffer.from([0]),Buffer.from([0x09]),Buffer.from([3]),Buffer.from('old'),Buffer.from([0x63,0xdd]),Buffer.from([7])]);client.write(Buffer.concat([Buffer.from([body.length]),body]));await new Promise(r=>setTimeout(r,30));
  expect(received).toHaveLength(0);expect(session?.state).toBe('failed');
  await relay.stop();await new Promise<void>(r=>upstream.close(()=>r()));
 });
 it('allows restart after a failed listen',async()=>{
  const blocker=net.createServer();await new Promise<void>(r=>blocker.listen(0,'127.0.0.1',()=>r()));const busyPort=(blocker.address() as net.AddressInfo).port;
  const upstream=net.createServer();await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',()=>r()));
  const relay=createRawTcpRelay({listenPort:busyPort,targetHost:'127.0.0.1',targetPort:(upstream.address() as net.AddressInfo).port,allowMinecraftUpstream:true});
  await expect(relay.start()).rejects.toThrow();await new Promise<void>(r=>blocker.close(()=>r()));await relay.start();expect(relay.address.port).toBe(busyPort);
  await relay.stop();await new Promise<void>(r=>upstream.close(()=>r()));
 });
 it('delivers the upstream reply after a client half-close',async()=>{
  const sockets=new Set<net.Socket>();
  const upstream=net.createServer({allowHalfOpen:true},s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('data',()=>setTimeout(()=>s.write('reply'),10));});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',()=>r()));
  const relay=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:(upstream.address() as net.AddressInfo).port,allowMinecraftUpstream:true});await relay.start();
  const client=await peer(relay.address.port);const chunks:Buffer[]=[];client.on('data',c=>chunks.push(Buffer.from(c)));
  client.write(Buffer.from('status'));client.end();await new Promise(r=>setTimeout(r,120));
  expect(Buffer.concat(chunks).toString()).toBe('reply');
  await relay.stop();for(const s of sockets)s.destroy();await new Promise<void>(r=>upstream.close(()=>r()));
 });
 it('stops within a bounded time even with an active connection',async()=>{
  const sockets=new Set<net.Socket>();
  const upstream=net.createServer({allowHalfOpen:true},s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('data',()=>{});});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',()=>r()));
  const relay=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:(upstream.address() as net.AddressInfo).port,allowMinecraftUpstream:true,budgets:{closeFlushMs:100}});await relay.start();
  const client=await peer(relay.address.port);client.write(Buffer.alloc(64,7));await new Promise(r=>setTimeout(r,20));
  const started=Date.now();await relay.stop();expect(Date.now()-started).toBeLessThan(2000);
  expect(relay.sessions()).toHaveLength(0);
  client.destroy();for(const s of sockets)s.destroy();await new Promise<void>(r=>upstream.close(()=>r()));
 });

 it('FEC-381 buffers client data until the upstream connects and a failed connect closes the session',async()=>{
  // First upstream accepts; second upstream port accepts and immediately destroys to simulate a refused target.
  const healthySockets=new Set<net.Socket>();
  const healthy=net.createServer({allowHalfOpen:true});let received:Buffer[]=[];healthy.on('connection',s=>{healthySockets.add(s);s.on('close',()=>healthySockets.delete(s));s.on('data',c=>received.push(Buffer.from(c)));s.on('end',()=>s.destroy());});
  await new Promise<void>(r=>healthy.listen(0,'127.0.0.1',()=>r()));
  const relay=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:(healthy.address() as net.AddressInfo).port,allowMinecraftUpstream:true});await relay.start();
  const client=await peer(relay.address.port);
  const payload=Buffer.from('queued-before-connect');
  client.write(payload);
  // Write lands while upstream is still connecting (or already connected); either way bytes must
  // arrive exactly once and in order, never dropped and never duplicated by the buffer release.
  await new Promise(r=>setTimeout(r,30));
  expect(Buffer.concat(received)).toEqual(payload);
  expect(relay.sessions()[0]?.metrics().forwardedBytes['client-to-server']).toBe(payload.length);
  client.destroy();await relay.stop();for(const s of healthySockets)s.destroy();await new Promise<void>(r=>healthy.close(()=>r()));

  const dead=net.createServer(s=>s.destroy());await new Promise<void>(r=>dead.listen(0,'127.0.0.1',()=>r()));
  const failing=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:(dead.address() as net.AddressInfo).port,allowMinecraftUpstream:true,budgets:{closeFlushMs:100}});await failing.start();
  const client2=await peer(failing.address.port);const closed=new Promise<void>(r=>client2.once('close',()=>r()));client2.write(Buffer.from('hello'));
  await closed;await new Promise(r=>setTimeout(r,20));
  expect(failing.sessions()).toHaveLength(0);
  await failing.stop();await new Promise<void>(r=>dead.close(()=>r()));
 });

 it('FEC-381 closes a session whose target port refuses the connection',async()=>{
  const probe=net.createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',()=>r()));const port=(probe.address() as net.AddressInfo).port;await new Promise<void>(r=>probe.close(()=>r()));
  const relay=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:port,allowMinecraftUpstream:true,budgets:{closeFlushMs:50}});await relay.start();
  const client=await peer(relay.address.port);client.on('error',()=>{});const closed=new Promise<void>(r=>client.once('close',()=>r()));client.write(Buffer.from('x'));
  await closed;await new Promise(r=>setTimeout(r,20));expect(relay.sessions()).toHaveLength(0);
  await relay.stop();
 });

 it('FEC-382 binds each relay session to the fixed target with an independent upstream',async()=>{
  const targets=new Map<number,{server:net.Server,sockets:Set<net.Socket>}>();
  const open=async()=>{const server=net.createServer({allowHalfOpen:true});const sockets=new Set<net.Socket>();server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('data',()=>{});});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));const port=(server.address() as net.AddressInfo).port;targets.set(port,{server,sockets});return port;};
  const portA=await open();const portB=await open();
  const relayA=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:portA,allowMinecraftUpstream:true});await relayA.start();
  const relayB=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:portB,allowMinecraftUpstream:true});await relayB.start();
  const first=await peer(relayA.address.port);const second=await peer(relayA.address.port);first.write(Buffer.from('one'));second.write(Buffer.from('two'));
  await new Promise(r=>setTimeout(r,30));
  expect(targets.get(portA)!.sockets.size).toBe(2);expect(targets.get(portB)!.sockets.size).toBe(0);
  expect(relayA.sessions()).toHaveLength(2);expect(relayA.sessions()[0].server.remotePort).toBe(portA);expect(relayA.sessions()[1].server.remotePort).toBe(portA);
  expect(relayA.sessions()[0].server).not.toBe(relayA.sessions()[1].server);
  // A relay configured for B never shares A's client: each binding has its own upstream socket.
  const third=await peer(relayB.address.port);third.write(Buffer.from('three'));await new Promise(r=>setTimeout(r,30));
  expect(targets.get(portB)!.sockets.size).toBe(1);expect(targets.get(portA)!.sockets.size).toBe(2);
  expect(relayB.sessions()[0].server).not.toBe(relayA.sessions()[0].server);
  first.destroy();second.destroy();third.destroy();
  await relayA.stop();await relayB.stop();
  for(const {server,sockets} of targets.values()){for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));}
 });

 it('FEC-006 flushes queued bytes on a normal close and reports zero undelivered bytes',async()=>{
  let received=Buffer.alloc(0);let closedResolve!:()=>void;const upstreamClosed=new Promise<void>(r=>{closedResolve=r;});
  const upstream=net.createServer({allowHalfOpen:true},s=>{s.on('data',c=>{received=Buffer.concat([received,Buffer.from(c)]);});s.on('end',()=>{setTimeout(()=>{s.end();closedResolve();},10);});});
  await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',()=>r()));
  const relay=createRawTcpRelay({listenPort:0,targetHost:'127.0.0.1',targetPort:(upstream.address() as net.AddressInfo).port,allowMinecraftUpstream:true,budgets:{closeFlushMs:500}});let session:import('../../src/bridge/relay/raw.js').RelaySession|undefined;relay.onSession(s=>{session=s;});await relay.start();
  const client=await peer(relay.address.port);const payload=Buffer.alloc(4096,5);client.write(payload);client.end();
  await upstreamClosed;
  for(let i=0;i<50&&relay.sessions().length>0;i++)await new Promise(r=>setTimeout(r,10));
  expect(relay.sessions()).toHaveLength(0);
  expect(received.subarray(-payload.length)).toEqual(payload);
  const metrics=session!.metrics();
  expect(metrics.undeliveredBytes).toEqual({'client-to-server':0,'server-to-client':0});
  expect(metrics.closeReason).toBe('closed');
  await relay.stop();await new Promise<void>(r=>upstream.close(()=>r()));
 });
});
