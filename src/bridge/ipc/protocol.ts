import { z } from 'zod';
export const IPC_PROTOCOL_VERSION=1 as const;
export const IpcHelloSchema=z.object({type:z.literal('hello'),protocolVersion:z.literal(IPC_PROTOCOL_VERSION),process:z.enum(['runtime','relay','observer']),sessionEpoch:z.string().min(1),bootEpoch:z.string().min(1),capabilities:z.array(z.string())}).strict();
export const IpcRequestSchema=z.object({type:z.literal('request'),protocolVersion:z.literal(IPC_PROTOCOL_VERSION),requestId:z.string().min(1),sessionEpoch:z.string().min(1),command:z.enum(['status','capabilities','observe','start-observer','stop-observer','shutdown']),payload:z.unknown(),timeoutMs:z.number().int().positive().default(5000)}).strict();
export const IpcResponseSchema=z.object({type:z.literal('response'),protocolVersion:z.literal(IPC_PROTOCOL_VERSION),requestId:z.string(),sessionEpoch:z.string(),ok:z.boolean(),result:z.unknown().optional(),error:z.object({code:z.string(),message:z.string()}).optional()}).strict();
export const IpcEventSchema=z.object({type:z.literal('event'),protocolVersion:z.literal(IPC_PROTOCOL_VERSION),sessionEpoch:z.string(),event:z.enum(['observer','gap','relay-state','diagnostic']),payload:z.unknown()}).strict();
export const IpcMessageSchema=z.discriminatedUnion('type',[IpcHelloSchema,IpcRequestSchema,IpcResponseSchema,IpcEventSchema]);
export type IpcMessage=z.infer<typeof IpcMessageSchema>; export type IpcRequest=z.infer<typeof IpcRequestSchema>;
export function parseIpcMessage(value:unknown):IpcMessage{return IpcMessageSchema.parse(value);}
export function assertIpcCommand(command:string):void{if(!IpcRequestSchema.shape.command._def.values.includes(command as never))throw new Error('ipc-command-not-allowed');}
