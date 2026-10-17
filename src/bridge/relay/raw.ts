import net, { type AddressInfo, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';

export type RelayBudgets = { highWaterMarkBytes:number; lowWaterMarkBytes:number; hardLimitBytes:number; writeStallMs:number; closeFlushMs:number };
export type RelayConfig = { listenHost?:string; listenPort:number; targetHost:string; targetPort:number; allowMinecraftUpstream:boolean; rewriteHandshake?:boolean; handshakeLimitBytes?:number; handshakeTimeoutMs?:number; allowedNextStates?:number[]; budgets?:Partial<RelayBudgets> };
export type RelayDirection = 'client-to-server'|'server-to-client';
export type RelaySessionState = 'connecting'|'handshaking'|'forwarding'|'half-closed'|'closing'|'closed'|'failed';
export type RelayMetrics = { queuedBytes:Record<RelayDirection,number>; forwardedBytes:Record<RelayDirection,number>; undeliveredBytes:Record<RelayDirection,number>; state:RelaySessionState; closeReason?:string };

const defaults:RelayBudgets = { highWaterMarkBytes:256*1024, lowWaterMarkBytes:64*1024, hardLimitBytes:4*1024*1024, writeStallMs:30_000, closeFlushMs:2_000 };
const validNextStates=new Set([1,2]);
function mergeBudgets(input?:Partial<RelayBudgets>):RelayBudgets { return { ...defaults, ...input }; }
function readVarInt(buf:Buffer, offset=0):{value:number,size:number}|undefined { let value=0; for(let i=0;i<5 && offset+i<buf.length;i++){ const b=buf[offset+i]; value |= (b&127) << (7*i); if(!(b&128)) return {value:value>>>0,size:i+1}; } return undefined; }
function encodeVarInt(value:number){const out:number[]=[]; do {let b=value&127; value >>>=7;if(value)b|=128;out.push(b);}while(value);return Buffer.from(out);}
function rewriteHandshake(frame:Buffer, host:string, port:number, allowedNextStates:Set<number>):Buffer {
  const outer=readVarInt(frame); if(!outer || outer.size+outer.value!==frame.length) throw new Error('invalid-handshake-frame');
  const body=frame.subarray(outer.size); const id=readVarInt(body); if(!id || id.value!==0) throw new Error('not-handshake');
  let at=id.size; const protocol=readVarInt(body,at); if(!protocol) throw new Error('invalid-handshake-protocol'); at+=protocol.size;
  const hostLen=readVarInt(body,at); if(!hostLen || at+hostLen.size+hostLen.value>body.length) throw new Error('invalid-handshake-host'); at+=hostLen.size;
  const portAt=at+hostLen.value; if(portAt+2>body.length) throw new Error('invalid-handshake-port'); const next=readVarInt(body,portAt+2); if(!next || !allowedNextStates.has(next.value)) throw new Error('invalid-handshake-next-state');
  const hostBytes=Buffer.from(host,'utf8'); const rest=Buffer.concat([body.subarray(0, id.size+protocol.size), encodeVarInt(hostBytes.length), hostBytes, Buffer.from([(port>>>8)&255,port&255]), body.subarray(portAt+2)]);
  return Buffer.concat([encodeVarInt(rest.length),rest]);
}

export interface RelaySession { readonly sessionEpoch:string; readonly client:Socket; readonly server:Socket; readonly state:RelaySessionState; metrics():RelayMetrics; close(reason?:string):Promise<void>; }
export interface RawTcpRelay { readonly address:AddressInfo; start():Promise<void>; stop():Promise<void>; sessions():readonly RelaySession[]; onSession(listener:(s:RelaySession)=>void):()=>void; }

class Session implements RelaySession {
  readonly sessionEpoch=`relay_${randomUUID()}`; state:RelaySessionState='connecting';
  private closed=false; private reason?:string; private finishing?:Promise<void>;
  private readonly stats:RelayMetrics={queuedBytes:{'client-to-server':0,'server-to-client':0},forwardedBytes:{'client-to-server':0,'server-to-client':0},undeliveredBytes:{'client-to-server':0,'server-to-client':0},state:'connecting'};
  constructor(readonly client:Socket, readonly server:Socket, private readonly config:{targetHost:string;targetPort:number;rewriteHandshake:boolean;handshakeLimitBytes:number;handshakeTimeoutMs:number;allowedNextStates:Set<number>;budgets:RelayBudgets}, private readonly onClosed:()=>void){ this.stats.state='handshaking'; this.state='handshaking'; this.install(); }
  metrics(){return {...this.stats,queuedBytes:{...this.stats.queuedBytes},forwardedBytes:{...this.stats.forwardedBytes},undeliveredBytes:{...this.stats.undeliveredBytes}};}
  private install(){ let first=Buffer.alloc(0); let handshakeDone=!this.config.rewriteHandshake; let handshakeTimer:ReturnType<typeof setTimeout>|undefined;
    if(handshakeDone){ this.state='forwarding'; this.stats.state='forwarding'; }
    if(!handshakeDone) handshakeTimer=setTimeout(()=>void this.close('handshake-timeout'),this.config.handshakeTimeoutMs);
    const clientDir:RelayDirection='client-to-server'; const serverDir:RelayDirection='server-to-client';
    const stalled:Record<RelayDirection,ReturnType<typeof setTimeout>|undefined>={[clientDir]:undefined,[serverDir]:undefined};
    let endsRemaining=2;
    const forward=(dest:Socket,source:Socket,chunk:Buffer,dir:RelayDirection)=>{
      const queued=dest.writableLength; if(queued+chunk.length>this.config.budgets.hardLimitBytes){ void this.close(`${dir}-hard-limit`); return; }
      this.stats.forwardedBytes[dir]+=chunk.length;
      const ok=dest.write(chunk); this.stats.queuedBytes[dir]=dest.writableLength;
      if(!ok){ source.pause(); if(stalled[dir])clearTimeout(stalled[dir]); stalled[dir]=setTimeout(()=>void this.close(`${dir}-write-stall`),this.config.budgets.writeStallMs); }
    };
    const onDrain=(source:Socket,dir:RelayDirection)=>()=>{ this.stats.queuedBytes[dir]=0; if(stalled[dir]){clearTimeout(stalled[dir]);stalled[dir]=undefined;} if(!this.closed&&source.isPaused())source.resume(); };
    const pair:Array<[Socket,Socket,RelayDirection]> = [[this.client,this.server,clientDir],[this.server,this.client,serverDir]];
    for(const [source,dest,dir] of pair){ const other=dir===clientDir?serverDir:clientDir;
      source.on('data',(chunk:Buffer)=>{ if(this.closed)return; if(source===this.client&&!handshakeDone){ first=Buffer.concat([first,chunk]); if(first.length>this.config.handshakeLimitBytes)return void this.close('handshake-limit'); const parsed=readVarInt(first); if(!parsed||first.length<parsed.size+parsed.value)return; const frame=first.subarray(0,parsed.size+parsed.value); first=first.subarray(frame.length); try { const out=rewriteHandshake(frame,this.config.targetHost,this.config.targetPort,this.config.allowedNextStates); handshakeDone=true; if(handshakeTimer)clearTimeout(handshakeTimer); handshakeTimer=undefined; this.state='forwarding'; this.stats.state='forwarding'; forward(dest,source,out,dir); if(first.length){ forward(dest,source,first,dir); first=Buffer.alloc(0); } } catch { void this.close('handshake-rewrite-failed'); } return; }
        forward(dest,source,chunk,dir); });
      dest.on('drain',onDrain(source,dir));
      source.on('end',()=>{ if(this.closed)return; endsRemaining-=1; if(this.state==='forwarding'){this.state='half-closed';this.stats.state='half-closed';} dest.end(); if(endsRemaining<=0) void this.close('closed'); });
      source.on('close',()=>{ if(this.closed)return; endsRemaining-=1; if(endsRemaining<=0) void this.close('closed'); });
      source.on('error',()=>void this.close(`${dir}-source-error`)); dest.on('error',()=>void this.close(`${dir}-destination-error`));
    }
  }
  async close(reason='closed'){ if(this.finishing)return this.finishing; this.finishing=this.doClose(reason); return this.finishing; }
  private async doClose(reason:string){
    if(this.closed)return;
    this.closed=true; this.reason=reason; this.state='closing'; this.stats.state='closing';
    const clients=[this.client,this.server];
    await this.flush(clients);
    for(const s of clients) s.destroy();
    this.state=reason==='closed'?'closed':'failed'; this.stats.state=this.state; this.stats.closeReason=reason; this.onClosed();
  }
  private flush(clients:Socket[]):Promise<void>{
    return new Promise<void>(resolve=>{
      let pending=0; let done=false;
      const finish=()=>{ if(done)return; done=true; resolve(); };
      const timer=setTimeout(()=>{ if(!done){ this.stats.undeliveredBytes={ 'client-to-server':this.server.writableLength, 'server-to-client':this.client.writableLength }; finish(); } },this.config.budgets.closeFlushMs);
      for(const s of clients){ if(s.writableLength>0){ pending+=1; s.once('drain',()=>{ pending-=1; if(pending<=0){ clearTimeout(timer); finish(); } }); } }
      if(pending===0){ clearTimeout(timer); finish(); }
    });
  }
}

export function createRawTcpRelay(config:RelayConfig):RawTcpRelay {
  if(!config.allowMinecraftUpstream) throw new Error('minecraft-upstream-disabled');
  const sessions=new Set<Session>(); const listeners=new Set<(s:RelaySession)=>void>(); let server:net.Server|undefined; let stopping=false;
  let address:AddressInfo={address:config.listenHost??'127.0.0.1',family:'IPv4',port:config.listenPort}; const budgets=mergeBudgets(config.budgets);
  const allowedNextStates=new Set(config.allowedNextStates??[...validNextStates]);
  const api:RawTcpRelay={get address(){return address;},async start(){if(server)return;stopping=false;const created=net.createServer(client=>{ if(stopping){client.destroy();return;} const upstream=net.createConnection({host:config.targetHost,port:config.targetPort});const session=new Session(client,upstream,{targetHost:config.targetHost,targetPort:config.targetPort,rewriteHandshake:config.rewriteHandshake??false,handshakeLimitBytes:config.handshakeLimitBytes??8192,handshakeTimeoutMs:config.handshakeTimeoutMs??5000,allowedNextStates,budgets},()=>sessions.delete(session));sessions.add(session);listeners.forEach(l=>l(session));});
    await new Promise<void>((resolve,reject)=>{ created.once('error',reject); created.listen(config.listenPort,config.listenHost??'127.0.0.1',()=>{address=created.address() as AddressInfo;resolve();}); }).then(()=>{server=created;},error=>{created.close();throw error;});},
    async stop(){ stopping=true; if(server){ const closing=server; server=undefined; await new Promise<void>(resolve=>closing.close(()=>resolve())); } await Promise.all([...sessions].map(s=>s.close('relay-stop'))); },
    sessions:()=>[...sessions],onSession(listener){listeners.add(listener);return()=>listeners.delete(listener);}};
  return api;
}
