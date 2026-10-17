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
});
