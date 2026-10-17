import { randomUUID } from 'node:crypto';
import { IpcMessageSchema, type IpcMessage, type IpcRequest } from './protocol.js';

type Channel = { send(message: unknown): boolean; on(event:'message'|'disconnect', listener:(value?:unknown)=>void): Channel; off?(event:'message'|'disconnect', listener:(value?:unknown)=>void): Channel; disconnect?():void };
export type IpcEndpoint = { readonly sessionEpoch:string; send(message:IpcMessage):boolean; request<T=unknown>(request:Omit<IpcRequest,'type'|'protocolVersion'|'requestId'|'sessionEpoch'|'timeoutMs'> & { requestId?:string; sessionEpoch?:string; timeoutMs?:number }):Promise<T>; subscribe(listener:(message:IpcMessage)=>void):()=>void; close():Promise<void> };
type Waiter = { timer:ReturnType<typeof setTimeout>; sessionEpoch:string; resolve:(v:unknown)=>void; reject:(e:Error)=>void };

export function createIpcEndpoint(channel:Channel, options:{defaultTimeoutMs?:number;maxPending?:number;maxQueuedMessages?:number;sessionEpoch?:string}={}):IpcEndpoint {
  const timeout=options.defaultTimeoutMs??5000, maxPending=options.maxPending??128, maxQueue=options.maxQueuedMessages??256;
  const endpointEpoch=options.sessionEpoch??`ipc_${randomUUID()}`;
  const pending=new Map<string,Waiter>(); const listeners=new Set<(m:IpcMessage)=>void>();
  let closed=false;
  const onMessage=(value:unknown)=>{
    let message:IpcMessage; try{ message=IpcMessageSchema.parse(value); }catch{ return; }
    if(message.type==='response'){
      const waiter=pending.get(message.requestId);
      // Stale/foreign session responses must not settle a current request.
      if(waiter&&waiter.sessionEpoch===message.sessionEpoch){pending.delete(message.requestId);clearTimeout(waiter.timer);message.ok?waiter.resolve(message.result):waiter.reject(new Error(message.error?.code??'ipc-request-failed'));}
    }
    for(const listener of listeners){ try{ listener(message); }catch{ /* subscriber isolation */ } }
  };
  const onDisconnect=()=>{ closed=true; for(const [id,waiter] of pending){ clearTimeout(waiter.timer); waiter.reject(new Error('ipc-disconnected')); pending.delete(id); } listeners.clear(); if(channel.off){ channel.off('message',onMessage); channel.off('disconnect',onDisconnect); } };
  channel.on('message',onMessage).on('disconnect',onDisconnect);
  // In-flight request count is the bounded queue measure; send() is gated by it so a slow peer cannot be flooded unbounded.
  return {
    sessionEpoch:endpointEpoch,
    send(message){ if(closed||pending.size>=maxQueue)return false; try{ return channel.send(message); }catch{ return false; } },
    request(request){
      if(closed)return Promise.reject(new Error('ipc-closed'));
      if(pending.size>=maxPending)return Promise.reject(new Error('ipc-backpressure'));
      const requestId=request.requestId??`req_${randomUUID()}`;
      if(pending.has(requestId))return Promise.reject(new Error('duplicate-request-id'));
      const sessionEpoch=request.sessionEpoch??endpointEpoch;
      const message={ ...request, type:'request' as const, protocolVersion:1 as const, requestId, sessionEpoch, timeoutMs:request.timeoutMs??timeout };
      if(pending.size>=maxQueue)return Promise.reject(new Error('ipc-backpressure'));
      return new Promise<unknown>((resolve,reject)=>{
        const timer=setTimeout(()=>{ pending.delete(requestId); reject(new Error('ipc-timeout')); },message.timeoutMs);
        pending.set(requestId,{timer,sessionEpoch,resolve,reject});
        if(!this.send(message)){ clearTimeout(timer); pending.delete(requestId); reject(new Error('ipc-backpressure')); }
      }) as Promise<never>;
    },
    subscribe(listener){ listeners.add(listener); return()=>listeners.delete(listener); },
    async close(){ if(closed)return; onDisconnect(); channel.disconnect?.(); }
  };
}
