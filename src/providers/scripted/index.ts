export type CanonicalTextPart = { type: 'text'; text: string };
export type CanonicalImagePart = { type: 'image'; ref: string; mediaType?: string; detail?: string };
export type CanonicalToolCall = { id: string; name: string; arguments: string };
export type CanonicalToolResult = { toolCallId: string; content: unknown; isError?: boolean };
export type CanonicalMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | CanonicalTextPart[];
  images?: CanonicalImagePart[];
  toolCalls?: CanonicalToolCall[];
  toolResult?: CanonicalToolResult;
  termination?: string;
  providerSource?: string;
};

export type ModelMessage = CanonicalMessage & { toolCallId?: string };
export type ToolCall = CanonicalToolCall;
export type ModelResponse = { text?: string; toolCalls?: ToolCall[]; stopReason: string; usage?: { inputTokens: number; outputTokens: number } };
export interface ModelProvider { complete(messages: ModelMessage[], tools: unknown[], signal?: AbortSignal): Promise<ModelResponse>; cancel(): void }
export class ScriptedModelProvider implements ModelProvider { private i=0; constructor(private readonly responses:ModelResponse[]){} async complete(_messages:ModelMessage[],_tools:unknown[],_signal?:AbortSignal){return this.responses[Math.min(this.i++,this.responses.length-1)]??{stopReason:'end_turn',text:''}} cancel(){} }
export class UnavailableProvider implements ModelProvider { constructor(private readonly reason='network disabled'){} async complete(_messages:ModelMessage[],_tools:unknown[],_signal?:AbortSignal){return {stopReason:'unavailable',text:this.reason}} cancel(){} }
