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
});
