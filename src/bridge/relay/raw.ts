import net, { type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

export type RelayBudgets = { highWaterMarkBytes:number; lowWaterMarkBytes:number; hardLimitBytes:number; writeStallMs:number; closeFlushMs:number; halfCloseMs:number; connectTimeoutMs:number };
export type RelayConfig = {
  listenHost?: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  allowMinecraftUpstream: boolean;
  /** Rewrite only the first downstream handshake frame; every later byte is forwarded verbatim. */
  rewriteHandshake?: boolean;
  handshakeLimitBytes?: number;
  handshakeTimeoutMs?: number;
  allowedNextStates?: number[];
  budgets?: Partial<RelayBudgets>;
  /**
   * Passive observation tap. It receives every source chunk (including bytes the observer
   * cannot interpret) and is invoked inside a try/catch so an observer failure can never
   * block or alter forwarding.
   */
  onChunk?: (direction: RelayDirection, chunk: Buffer) => void;
  /** Injected network layer for offline lifecycle tests; defaults to node:net. */
  network?: RelayNetwork;
};
export type RelayDirection = 'client-to-server'|'server-to-client';
export type RelaySessionState = 'connecting'|'handshaking'|'forwarding'|'half-closed'|'closing'|'closed'|'failed';
export type RelayMetrics = { queuedBytes:Record<RelayDirection,number>; forwardedBytes:Record<RelayDirection,number>; undeliveredBytes:Record<RelayDirection,number>; state:RelaySessionState; closeReason?:string };

/**
 * Structural socket surface used by the relay. Production uses node:net; tests inject a
 * deterministic loopback implementation without a game engine or real TCP stack.
 */
export type RelaySocket = {
  readonly writableLength: number;
  readonly writableEnded: boolean;
  readonly remotePort?: number;
  write(chunk: Buffer): boolean;
  end(): void;
  destroy(): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  once(event: string, listener: (...args: any[]) => void): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
};

export type RelayServer = {
  once(event: 'error'|'listening', listener: (error?: Error) => void): unknown;
  listen(port: number, host: string, callback: () => void): unknown;
  address(): AddressInfo | string | null;
  close(callback?: (error?: Error) => void): unknown;
};

export type RelayNetwork = {
  createServer(options: { allowHalfOpen: boolean }, onConnection: (socket: RelaySocket) => void): RelayServer;
  connect(options: { host: string; port: number; allowHalfOpen: boolean }): RelaySocket;
};

export const nodeRelayNetwork: RelayNetwork = {
  createServer(options, onConnection) {
    return net.createServer(options, socket => onConnection(socket as unknown as RelaySocket)) as unknown as RelayServer;
  },
  connect(options) {
    return net.createConnection(options) as unknown as RelaySocket;
  },
};

const defaults:RelayBudgets = { highWaterMarkBytes:256*1024, lowWaterMarkBytes:64*1024, hardLimitBytes:4*1024*1024, writeStallMs:30_000, closeFlushMs:2_000, halfCloseMs:30_000, connectTimeoutMs:10_000 };
const validNextStates=new Set([1,2]);
function mergeBudgets(input?:Partial<RelayBudgets>):RelayBudgets { return { ...defaults, ...input }; }
function readVarInt(buf:Buffer, offset=0):{value:number,size:number}|undefined { let value=0; for(let i=0;i<5 && offset+i<buf.length;i++){ const b=buf[offset+i]!; value += (b&127) * 2 ** (7*i); if(!(b&128)) return {value,size:i+1}; } return undefined; }
function encodeVarInt(value:number){const out:number[]=[]; do {let b=value&127; value=Math.floor(value/128);if(value)b|=128;out.push(b);}while(value);return Buffer.from(out);}
function rewriteHandshake(frame:Buffer, host:string, port:number, allowedNextStates:Set<number>):Buffer {
  const outer=readVarInt(frame); if(!outer || outer.size+outer.value!==frame.length) throw new Error('invalid-handshake-frame');
  const body=frame.subarray(outer.size); const id=readVarInt(body); if(!id || id.value!==0) throw new Error('not-handshake');
  let at=id.size; const protocol=readVarInt(body,at); if(!protocol) throw new Error('invalid-handshake-protocol'); at+=protocol.size;
  const hostLen=readVarInt(body,at); if(!hostLen || at+hostLen.size+hostLen.value>body.length) throw new Error('invalid-handshake-host'); at+=hostLen.size;
  const portAt=at+hostLen.value; if(portAt+2>body.length) throw new Error('invalid-handshake-port'); const next=readVarInt(body,portAt+2); if(!next || !allowedNextStates.has(next.value)) throw new Error('invalid-handshake-next-state');
  const hostBytes=Buffer.from(host,'utf8'); const rest=Buffer.concat([body.subarray(0, id.size+protocol.size), encodeVarInt(hostBytes.length), hostBytes, Buffer.from([(port>>>8)&255,port&255]), body.subarray(portAt+2)]);
  return Buffer.concat([encodeVarInt(rest.length),rest]);
}

export interface RelaySession { readonly sessionEpoch:string; readonly client:RelaySocket; readonly server:RelaySocket; readonly state:RelaySessionState; metrics():RelayMetrics; close(reason?:string):Promise<void>; }
export interface RawTcpRelay { readonly address:AddressInfo; start():Promise<void>; stop():Promise<void>; sessions():readonly RelaySession[]; onSession(listener:(s:RelaySession)=>void):()=>void; }

class Session implements RelaySession {
  readonly sessionEpoch=`relay_${randomUUID()}`; state:RelaySessionState='connecting';
  private closed=false; private reason?:string; private finishing?:Promise<void>;
  private handshakeTimer?:ReturnType<typeof setTimeout>;
  private connectTimer?:ReturnType<typeof setTimeout>;
  private halfCloseTimer?:ReturnType<typeof setTimeout>;
  private readonly stats:RelayMetrics={queuedBytes:{'client-to-server':0,'server-to-client':0},forwardedBytes:{'client-to-server':0,'server-to-client':0},undeliveredBytes:{'client-to-server':0,'server-to-client':0},state:'connecting'};
  constructor(readonly client:RelaySocket, readonly server:RelaySocket, private readonly config:{targetHost:string;targetPort:number;rewriteHandshake:boolean;handshakeLimitBytes:number;handshakeTimeoutMs:number;allowedNextStates:Set<number>;budgets:RelayBudgets;onChunk?:(direction:RelayDirection, chunk:Buffer)=>void}, private readonly onClosed:()=>void){ this.stats.state='handshaking'; this.state='handshaking'; this.install(); }
  metrics(){return {...this.stats,queuedBytes:{...this.stats.queuedBytes},forwardedBytes:{...this.stats.forwardedBytes},undeliveredBytes:{...this.stats.undeliveredBytes}};}
  /** Observer failures are isolated from the forwarding path. */
  private notifyObserver(direction:RelayDirection, chunk:Buffer){
    if(!this.config.onChunk)return;
    try { this.config.onChunk(direction, chunk); } catch { /* observation must never block relay forwarding */ }
  }
  private install(){ let first=Buffer.alloc(0); let handshakeDone=!this.config.rewriteHandshake;
    // Upstream connects asynchronously. Client bytes are buffered only up to the hard
    // limit until 'connect'; a failed connect terminates the whole session.
    let upstreamConnected=false; const upstreamPending:Buffer[]=[]; let upstreamPendingBytes=0; let clientEndedBeforeConnect=false;
    let clientPausedForUpstream=false;
    const clientDir:RelayDirection='client-to-server'; const serverDir:RelayDirection='server-to-client';
    const stalled:Record<RelayDirection,ReturnType<typeof setTimeout>|undefined>={[clientDir]:undefined,[serverDir]:undefined};
    const sources:Record<RelayDirection,RelaySocket|undefined>={[clientDir]:undefined,[serverDir]:undefined};
    const clearStall=(dir:RelayDirection)=>{ if(stalled[dir]){clearTimeout(stalled[dir]);stalled[dir]=undefined;} };
    const armStall=(dir:RelayDirection)=>{ clearStall(dir); stalled[dir]=setTimeout(()=>void this.close(`${dir}-write-stall`),this.config.budgets.writeStallMs); };
    const pauseClient=()=>{ if(!this.client.isPaused())this.client.pause(); clientPausedForUpstream=true; };
    const resumeClient=()=>{ if(clientPausedForUpstream){ clientPausedForUpstream=false; if(!this.closed&&this.client.isPaused())this.client.resume(); } };
    const queueForUpstream=(chunk:Buffer)=>{
      if(this.closed)return;
      upstreamPending.push(Buffer.from(chunk)); upstreamPendingBytes+=chunk.length;
      if(upstreamPendingBytes>this.config.budgets.hardLimitBytes){ void this.close('client-to-server-hard-limit'); return; }
      // Bounded buffering before connect also applies backpressure to the live client.
      if(upstreamPendingBytes>=this.config.budgets.highWaterMarkBytes) pauseClient();
    };
    const releaseUpstream=()=>{ if(this.closed)return; upstreamConnected=true; const pending=Buffer.concat(upstreamPending); upstreamPending.length=0; upstreamPendingBytes=0;
      if(pending.length){
        this.stats.forwardedBytes[clientDir]+=pending.length;
        sources[clientDir]=this.client;
        const ok=this.server.write(pending); this.stats.queuedBytes[clientDir]=this.server.writableLength;
        if(!ok){ pauseClient(); armStall(clientDir); } else resumeClient();
      } else resumeClient();
      if(clientEndedBeforeConnect&&!this.server.writableEnded)this.server.end();
    };
    this.connectTimer=setTimeout(()=>void this.close('upstream-connect-timeout'),this.config.budgets.connectTimeoutMs);
    this.server.once('connect',()=>{ if(this.connectTimer){clearTimeout(this.connectTimer);this.connectTimer=undefined;} releaseUpstream(); });
    if(handshakeDone){ this.state='forwarding'; this.stats.state='forwarding'; }
    if(!handshakeDone) this.handshakeTimer=setTimeout(()=>void this.close('handshake-timeout'),this.config.handshakeTimeoutMs);
    // Each socket contributes exactly one terminal event: an 'end' followed by 'close' on
    // the same socket must not be counted twice, or the peer's reply could be destroyed early.
    const accounted=new Set<RelaySocket>();
    const endedSockets=new Set<RelaySocket>();
    const settle=(socket:RelaySocket)=>{ if(accounted.has(socket))return false; accounted.add(socket); return true; };
    const forward=(dest:RelaySocket,source:RelaySocket,chunk:Buffer,dir:RelayDirection)=>{
      if(this.closed||chunk.length===0)return;
      if(dir===clientDir&&!upstreamConnected){ queueForUpstream(chunk); return; }
      const queued=dest.writableLength; if(queued+chunk.length>this.config.budgets.hardLimitBytes){ void this.close(`${dir}-hard-limit`); return; }
      this.stats.forwardedBytes[dir]+=chunk.length;
      sources[dir]=source;
      const ok=dest.write(chunk); this.stats.queuedBytes[dir]=dest.writableLength;
      if(!ok){
        if(source===this.client) pauseClient(); else source.pause();
        armStall(dir);
      } else if(dest.writableLength<=this.config.budgets.lowWaterMarkBytes){
        clearStall(dir);
        if(source.isPaused()){ if(source===this.client) resumeClient(); else source.resume(); }
      }
    };
    // Each direction resumes the source that actually experienced backpressure. The two
    // directions are independent: one stalled writer must not be resumed by the other.
    const onDrain=(dir:RelayDirection)=>()=>{ this.stats.queuedBytes[dir]=0; clearStall(dir); const source=sources[dir]; if(!this.closed&&source?.isPaused()){ if(source===this.client)resumeClient(); else source.resume(); } };
    const pair:Array<[RelaySocket,RelaySocket,RelayDirection]> = [[this.client,this.server,clientDir],[this.server,this.client,serverDir]];
    for(const [source,dest,dir] of pair){
      source.on('data',(chunk:Buffer)=>{ if(this.closed)return; this.notifyObserver(dir,chunk); if(source===this.client&&!handshakeDone){ first=Buffer.concat([first,chunk]); const parsed=readVarInt(first); if(parsed && parsed.value>this.config.handshakeLimitBytes)return void this.close('handshake-limit'); if(first.length>this.config.handshakeLimitBytes)return void this.close('handshake-limit'); if(!parsed||first.length<parsed.size+parsed.value)return; const frame=Buffer.from(first.subarray(0,parsed.size+parsed.value)); first=Buffer.from(first.subarray(frame.length)); try { const out=rewriteHandshake(frame,this.config.targetHost,this.config.targetPort,this.config.allowedNextStates); handshakeDone=true; if(this.handshakeTimer){clearTimeout(this.handshakeTimer);this.handshakeTimer=undefined;} this.state='forwarding'; this.stats.state='forwarding'; forward(dest,source,out,dir); if(first.length){ forward(dest,source,first,dir); first=Buffer.alloc(0); } } catch { void this.close('handshake-rewrite-failed'); } return; }
        forward(dest,source,chunk,dir); });
      dest.on('drain',onDrain(dir));
      source.on('end',()=>{ if(this.closed)return; endedSockets.add(source); if(!settle(source))return; if(source===this.client&&!upstreamConnected){ clientEndedBeforeConnect=true; return; } if(this.state!=='closing'){this.state='half-closed';this.stats.state='half-closed';} if(!dest.writableEnded)dest.end(); if(accounted.size>=2) void this.close('closed'); else if(!this.halfCloseTimer) this.halfCloseTimer=setTimeout(()=>void this.close('half-close-timeout'),this.config.budgets.halfCloseMs); });
      // An abrupt close (no preceding 'end') must release the session; otherwise the peer
      // socket and its buffered resources would leak on an ungraceful disconnect.
      source.on('close',()=>{ if(this.closed)return; if(!settle(source))return; if(!endedSockets.has(source)){ void this.close(`${dir}-abort`); return; } if(accounted.size>=2) void this.close('closed'); });
      source.on('error',()=>void this.close(`${dir}-source-error`)); dest.on('error',()=>void this.close(`${dir}-destination-error`));
      // A failed upstream connect must terminate the session, not leave the client attached.
      if(dest===this.server) dest.on('close',()=>{ if(!upstreamConnected&&!this.closed)void this.close('upstream-connect-failed'); });
    }
  }
  async close(reason='closed'){ if(this.finishing)return this.finishing; this.finishing=this.doClose(reason); return this.finishing; }
  private async doClose(reason:string){
    if(this.closed)return;
    this.closed=true; this.reason=reason; this.state='closing'; this.stats.state='closing';
    if(this.handshakeTimer){clearTimeout(this.handshakeTimer);this.handshakeTimer=undefined;}
    if(this.connectTimer){clearTimeout(this.connectTimer);this.connectTimer=undefined;}
    if(this.halfCloseTimer){clearTimeout(this.halfCloseTimer);this.halfCloseTimer=undefined;}
    const clients=[this.client,this.server];
    await this.flush(clients);
    for(const s of clients) s.destroy();
    this.state=reason==='closed'||reason==='relay-stop'||reason==='client-closed'?'closed':'failed'; this.stats.state=this.state; this.stats.closeReason=reason; this.onClosed();
  }
  private flush(clients:RelaySocket[]):Promise<void>{
    return new Promise<void>(resolve=>{
      let pending=0; let done=false;
      const finish=()=>{ if(done)return; done=true; resolve(); };
      const timer=setTimeout(()=>{ if(!done){ this.stats.undeliveredBytes={ 'client-to-server':this.server.writableLength, 'server-to-client':this.client.writableLength }; finish(); } },this.config.budgets.closeFlushMs);
      for(const s of clients){
        if(s.writableLength>0){ pending+=1; s.once('drain',()=>{ pending-=1; if(pending<=0){ clearTimeout(timer); finish(); } }); }
        // End the writable side so pending bytes can be flushed and 'drain' can fire.
        if(!s.writableEnded) s.end();
      }
      if(pending===0){ clearTimeout(timer); finish(); }
    });
  }
}

export function createRawTcpRelay(config:RelayConfig):RawTcpRelay {
  if(!config.allowMinecraftUpstream) throw new Error('minecraft-upstream-disabled');
  const network=config.network??nodeRelayNetwork;
  const sessions=new Set<Session>(); const listeners=new Set<(s:RelaySession)=>void>(); let server:RelayServer|undefined; let stopping=false;
  let address:AddressInfo={address:config.listenHost??'127.0.0.1',family:'IPv4',port:config.listenPort}; const budgets=mergeBudgets(config.budgets);
  const allowedNextStates=new Set(config.allowedNextStates??[...validNextStates]);
  const api:RawTcpRelay={get address(){return address;},async start(){if(server)return;stopping=false;const created=network.createServer({allowHalfOpen:true},client=>{ if(stopping){client.destroy();return;} const upstream=network.connect({host:config.targetHost,port:config.targetPort,allowHalfOpen:true});const session=new Session(client,upstream,{targetHost:config.targetHost,targetPort:config.targetPort,rewriteHandshake:config.rewriteHandshake??false,handshakeLimitBytes:config.handshakeLimitBytes??8192,handshakeTimeoutMs:config.handshakeTimeoutMs??5000,allowedNextStates,budgets,onChunk:config.onChunk},()=>sessions.delete(session));sessions.add(session);listeners.forEach(l=>l(session));});
    await new Promise<void>((resolve,reject)=>{ created.once('error',reject); created.listen(config.listenPort,config.listenHost??'127.0.0.1',()=>{address=created.address() as AddressInfo;resolve();}); }).then(()=>{server=created;},error=>{created.close();throw error;});},
    async stop(){ stopping=true; const active=[...sessions].map(s=>s.close('relay-stop')); if(server){ const closing=server; server=undefined; await new Promise<void>(resolve=>closing.close(()=>resolve())); } await Promise.all(active); },
    sessions:()=>[...sessions],onSession(listener){listeners.add(listener);return()=>listeners.delete(listener);}};
  return api;
}
