import net, { type AddressInfo, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

export type RelayBudgets = { highWaterMarkBytes:number; lowWaterMarkBytes:number; hardLimitBytes:number; writeStallMs:number; closeFlushMs:number };
export type RelayConfig = { listenHost?:string; listenPort:number; targetHost:string; targetPort:number; allowMinecraftUpstream:boolean; rewriteHandshake?:boolean; handshakeLimitBytes?:number; handshakeTimeoutMs?:number; budgets?:Partial<RelayBudgets> };
export type RelayDirection = 'client-to-server'|'server-to-client';
export type RelaySessionState = 'connecting'|'handshaking'|'forwarding'|'half-closed'|'closing'|'closed'|'failed';
export type RelayMetrics = { queuedBytes:Record<RelayDirection,number>; forwardedBytes:Record<RelayDirection,number>; state:RelaySessionState; closeReason?:string };

const defaults:RelayBudgets = { highWaterMarkBytes:256*1024, lowWaterMarkBytes:64*1024, hardLimitBytes:4*1024*1024, writeStallMs:30_000, closeFlushMs:2_000 };
function mergeBudgets(input?:Partial<RelayBudgets>):RelayBudgets { return { ...defaults, ...input }; }
function readVarInt(buf:Buffer, offset=0):{value:number,size:number}|undefined { let value=0; for(let i=0;i<5 && offset+i<buf.length;i++){ const b=buf[offset+i]; value |= (b&127) << (7*i); if(!(b&128)) return {value:value>>>0,size:i+1}; } return undefined; }
function encodeVarInt(value:number){const out:number[]=[]; do {let b=value&127; value >>>=7;if(value)b|=128;out.push(b);}while(value);return Buffer.from(out);}
function rewriteHandshake(frame:Buffer, host:string, port:number):Buffer {
  const outer=readVarInt(frame); if(!outer || outer.size+outer.value!==frame.length) throw new Error('invalid-handshake-frame');
  const body=frame.subarray(outer.size); const id=readVarInt(body); if(!id || id.value!==0) throw new Error('not-handshake');
  let at=id.size; const protocol=readVarInt(body,at); if(!protocol) throw new Error('invalid-handshake-protocol'); at+=protocol.size;
  const hostLen=readVarInt(body,at); if(!hostLen || at+hostLen.size+hostLen.value>body.length) throw new Error('invalid-handshake-host'); at+=hostLen.size;
  const portAt=at+hostLen.value; const tail=body.subarray(portAt+2); if(tail.length<1) throw new Error('invalid-handshake-port');
  const hostBytes=Buffer.from(host,'utf8'); const next=Buffer.concat([body.subarray(0, id.size+protocol.size), encodeVarInt(hostBytes.length), hostBytes, Buffer.from([(port>>>8)&255,port&255]), tail]);
  return Buffer.concat([encodeVarInt(next.length),next]);
}

export interface RelaySession { readonly sessionEpoch:string; readonly client:Socket; readonly server:Socket; readonly state:RelaySessionState; metrics():RelayMetrics; close(reason?:string):Promise<void>; }
export interface RawTcpRelay { readonly address:AddressInfo; start():Promise<void>; stop():Promise<void>; sessions():readonly RelaySession[]; onSession(listener:(s:RelaySession)=>void):()=>void; }

class Session implements RelaySession {
  readonly sessionEpoch = `relay_${randomUUID()}`; state:RelaySessionState='connecting';
  private closed=false; private reason?:string; private readonly stats:RelayMetrics={queuedBytes:{'client-to-server':0,'server-to-client':0},forwardedBytes:{'client-to-server':0,'server-to-client':0},state:'connecting'};
  constructor(readonly client:Socket, readonly server:Socket, private readonly config:Required<Pick<RelayConfig,'rewriteHandshake'|'handshakeLimitBytes'|'handshakeTimeoutMs'>> & { targetHost:string; targetPort:number; budgets:RelayBudgets }, private readonly onClosed:()=>void){ this.stats.state='handshaking'; this.state='handshaking'; this.install(); }
  metrics(){return {...this.stats,queuedBytes:{...this.stats.queuedBytes},forwardedBytes:{...this.stats.forwardedBytes}};}
  private install(){ const pair:[[Socket,Socket],[Socket,Socket]]=[[this.client,this.server],[this.server,this.client]]; let first=Buffer.alloc(0); let handshakeDone=!this.config.rewriteHandshake; let timer:ReturnType<typeof setTimeout>|undefined;
    if(!handshakeDone) timer=setTimeout(()=>void this.close('handshake-timeout'),this.config.handshakeTimeoutMs);
    for(const [source,dest] of pair){ const dir:RelayDirection=source===this.client?'client-to-server':'server-to-client'; let queued=0; let stalled:ReturnType<typeof setTimeout>|undefined;
      source.on('data',(chunk:Buffer)=>{ if(this.closed)return; if(source===this.client&&!handshakeDone){ first=Buffer.concat([first,chunk]); if(first.length>this.config.handshakeLimitBytes)return void this.close('handshake-limit'); const parsed=readVarInt(first); if(!parsed||first.length<parsed.size+parsed.value)return; const frame=first.subarray(0,parsed.size+parsed.value); first=first.subarray(frame.length); try { const out=rewriteHandshake(frame,this.config.targetHost,this.config.targetPort); if(!this.write(dest,out,dir)) source.pause(); handshakeDone=true; if(timer)clearTimeout(timer); this.state='forwarding'; this.stats.state='forwarding'; if(first.length)this.write(dest,first,dir); } catch { void this.close('handshake-rewrite-failed'); } return; }
        if(chunk.length>this.config.budgets.hardLimitBytes-queued)return void this.close(`${dir}-hard-limit`); queued+=chunk.length; this.stats.queuedBytes[dir]=queued; const ok=this.write(dest,chunk,dir); if(!ok||queued>=this.config.budgets.highWaterMarkBytes)source.pause(); if(stalled)clearTimeout(stalled); stalled=setTimeout(()=>void this.close(`${dir}-write-stall`),this.config.budgets.writeStallMs); dest.once('drain',()=>{queued=0;this.stats.queuedBytes[dir]=0;if(stalled)clearTimeout(stalled);if(!this.closed)source.resume();}); });
      source.on('end',()=>{this.state='half-closed';this.stats.state='half-closed';dest.end();}); source.on('error',()=>void this.close(`${dir}-source-error`)); dest.on('error',()=>void this.close(`${dir}-destination-error`)); }
  }
  private write(dest:Socket,chunk:Buffer,dir:RelayDirection){ if(this.closed)return false; this.stats.forwardedBytes[dir]+=chunk.length; return dest.write(chunk); }
  async close(reason='closed'){if(this.closed)return;this.closed=true;this.reason=reason;this.state='closing';this.stats.state='closing';for(const s of [this.client,this.server]){s.removeAllListeners('data');s.end();} await new Promise<void>(resolve=>setTimeout(resolve,Math.min(10,this.config.budgets.closeFlushMs)));for(const s of [this.client,this.server])s.destroy();this.state=reason==='closed'?'closed':'failed';this.stats.state=this.state;this.stats.closeReason=reason;this.onClosed();}
}

export function createRawTcpRelay(config:RelayConfig):RawTcpRelay {
  if(!config.allowMinecraftUpstream) throw new Error('minecraft-upstream-disabled');
  const sessions=new Set<Session>(); const listeners=new Set<(s:RelaySession)=>void>(); let server:net.Server|undefined; let address:AddressInfo={address:config.listenHost??'127.0.0.1',family:'IPv4',port:config.listenPort}; const budgets=mergeBudgets(config.budgets);
  const api:RawTcpRelay={get address(){return address;},async start(){if(server)return;server=net.createServer(client=>{const upstream=net.createConnection({host:config.targetHost,port:config.targetPort});const session=new Session(client,upstream,{targetHost:config.targetHost,targetPort:config.targetPort,rewriteHandshake:config.rewriteHandshake??false,handshakeLimitBytes:config.handshakeLimitBytes??8192,handshakeTimeoutMs:config.handshakeTimeoutMs??5000,budgets},()=>sessions.delete(session));sessions.add(session);listeners.forEach(l=>l(session));});await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(config.listenPort,config.listenHost??'127.0.0.1',()=>{address=server!.address() as AddressInfo;resolve();});});},async stop(){const active=[...sessions].map(s=>s.close('relay-stop'));await Promise.all(active);if(server){await new Promise<void>(resolve=>server!.close(()=>resolve()));server=undefined;}},sessions:()=>[...sessions],onSession(listener){listeners.add(listener);return()=>listeners.delete(listener);}}; return api;
}
