import { z } from 'zod';

const JsonObject = z.record(z.unknown());
export const CommandNameSchema = z.enum([
  'goal.set', 'goal.revise', 'message', 'chat', 'pause', 'resume', 'stop', 'cancel', 'save', 'quit',
]);
export type CommandName = z.infer<typeof CommandNameSchema>;

export const CommandRequestSchema = z.object({
  requestId: z.string().min(1).max(256),
  command: CommandNameSchema,
  payload: JsonObject.default({}),
  expectedRevision: z.number().int().nonnegative().optional(),
}).strict();
export type CommandRequest = z.infer<typeof CommandRequestSchema>;

export const GoalSetPayloadSchema = z.object({ goalId: z.string().min(1), text: z.string().min(1), status: z.enum(['active', 'paused', 'completed', 'canceled']).optional() }).strict();
export const GoalRevisePayloadSchema = z.object({ goalId: z.string().min(1), change: z.string().min(1), expectedRevision: z.number().int().nonnegative().optional() }).strict();
export const MessagePayloadSchema = z.object({ text: z.string().min(1), goalId: z.string().optional(), goalRevision: z.number().int().nonnegative().optional() }).strict();
export const ChatPayloadSchema = z.object({ text: z.string().min(1) }).strict();
export const CancelPayloadSchema = z.object({ executionId: z.string().min(1) }).strict();

export const CommandStateSchema = z.enum(['accepted', 'terminal', 'unknown', 'conflict', 'rejected']);
export type CommandState = z.infer<typeof CommandStateSchema>;
export type CommandResult = {
  requestId: string;
  command: CommandName;
  state: CommandState;
  code?: string;
  result?: unknown;
  payloadHash: string;
};

export type ProviderMetadata = {
  provider: 'scripted' | 'openai' | 'anthropic' | 'unknown';
  configured: boolean;
  model?: string;
  networkEnabled?: boolean;
  transport: 'fixture' | 'network' | 'unavailable' | 'unknown';
};
