import { randomUUID } from 'node:crypto';
import { IpcMessageSchema, type IpcMessage, type IpcRequest } from './protocol.js';

type Channel = { send(message: unknown): boolean; on(event:'message'|'disconnect', listener:(value?:unknown)=>void): Channel; off?(event:'message'|'disconnect', listener:(value?:unknown)=>void): Channel; disconnect?():void };
export type IpcQueued = { inFlight:number; sent:number; queued:number };
export type IpcEndpoint = { readonly sessionEpoch:string; send(message:IpcMessage):boolean; request<T=unknown>(request:Omit<IpcRequest,'type'|'protocolVersion'|'requestId'|'sessionEpoch'|'timeoutMs'> & { requestId?:string; sessionEpoch?:string; timeoutMs?:number }):Promise<T>; subscribe(listener:(message:IpcMessage)=>void):()=>void; queued():IpcQueued; close():Promise<void> };
type Waiter = { timer:ReturnType<typeof setTimeout>; sessionEpoch:string; resolve:(v:unknown)=>void; reject:(e:Error)=>void };

export function createIpcEndpoint(channel:Channel, options:{defaultTimeoutMs?:number;maxPending?:number;maxQueuedMessages?:number;sessionEpoch?:string}={}):IpcEndpoint {
  const timeout=options.defaultTimeoutMs??5000, maxPending=options.maxPending??128, maxQueue=options.maxQueuedMessages??256;
  const endpointEpoch=options.sessionEpoch??`ipc_${randomUUID()}`;
  const pending=new Map<string,Waiter>(); const listeners=new Set<(m:IpcMessage)=>void>();
  // FEC-050: outbound backpressure uses the real outbound queue. `sent` counts messages written to
  // the channel whose matching response has not arrived yet; it is only decremented on response,
  // disconnect/close, or rejection — never synchronously right after send().
  const sentIds=new Set<string>();
  let closed=false;
  const onMessage=(value:unknown)=>{
    let message:IpcMessage; try{ message=IpcMessageSchema.parse(value); }catch{ return; }
    if(message.type==='response'){
      sentIds.delete(message.requestId);
      const waiter=pending.get(message.requestId);
      // Stale/foreign session responses must not settle a current request.
      if(waiter&&waiter.sessionEpoch===message.sessionEpoch){pending.delete(message.requestId);clearTimeout(waiter.timer);message.ok?waiter.resolve(message.result):waiter.reject(new Error(message.error?.code??'ipc-request-failed'));}
    }
    for(const listener of listeners){ try{ listener(message); }catch{ /* subscriber isolation */ } }
  };
  const detach=()=>{ if(channel.off){ channel.off('message',onMessage); channel.off('disconnect',onDisconnect); } };
  // FEC-048: any disconnect (remote or local close) clears waiters, queued sends and listeners.
  const onDisconnect=()=>{ closed=true; for(const [id,waiter] of pending){ clearTimeout(waiter.timer); waiter.reject(new Error('ipc-disconnected')); pending.delete(id); } sentIds.clear(); listeners.clear(); detach(); };
  channel.on('message',onMessage).on('disconnect',onDisconnect);
  return {
    sessionEpoch:endpointEpoch,
    send(message){
      if(closed)return false;
      if(sentIds.size>=maxQueue)return false;
      try{
        if(!channel.send(message))return false;
      }catch{ return false; }
      if(message.type==='request')sentIds.add(message.requestId);
      return true;
    },
    request(request){
      if(closed)return Promise.reject(new Error('ipc-closed'));
      if(pending.size>=maxPending)return Promise.reject(new Error('ipc-backpressure'));
      const requestId=request.requestId??`req_${randomUUID()}`;
      if(pending.has(requestId))return Promise.reject(new Error('duplicate-request-id'));
      const sessionEpoch=request.sessionEpoch??endpointEpoch;
      const message={ ...request, type:'request' as const, protocolVersion:1 as const, requestId, sessionEpoch, timeoutMs:request.timeoutMs??timeout };
      return new Promise<unknown>((resolve,reject)=>{
        const timer=setTimeout(()=>{ pending.delete(requestId); sentIds.delete(requestId); reject(new Error('ipc-timeout')); },message.timeoutMs);
        pending.set(requestId,{timer,sessionEpoch,resolve,reject});
        if(!this.send(message)){ clearTimeout(timer); pending.delete(requestId); reject(new Error('ipc-backpressure')); }
      }) as Promise<never>;
    },
    subscribe(listener){ listeners.add(listener); return()=>listeners.delete(listener); },
    queued(){ return { inFlight:pending.size, sent:sentIds.size, queued:Math.max(pending.size,sentIds.size) }; },
    async close(){ if(closed){ detach(); return; } onDisconnect(); channel.disconnect?.(); }
  };
}
