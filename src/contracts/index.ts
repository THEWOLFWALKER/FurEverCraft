import { z } from 'zod';

export const BodyContextSchema = z.object({ serverProfileId: z.string(), accountId: z.string().optional(), worldGenerationId: z.string().optional(), connectionEpoch: z.string(), bodyEpoch: z.string(), dimension: z.string() });
export type BodyContext = z.infer<typeof BodyContextSchema>;
export const CellSchema = z.enum(['free','blocked','unknown']);
export const FieldEvidenceSchema = z.object({ source: z.enum(['simulated','observed-server','predicted','historical','model']), observedAt: z.number(), expiresAt: z.number().optional(), freshness: z.enum(['current','stale','unknown']), available: z.boolean(), evidenceRef: z.string().optional() });
export type FieldEvidence = z.infer<typeof FieldEvidenceSchema>;
export const WorldSnapshotSchema = z.object({ context: BodyContextSchema, revision: z.string(), position: z.object({x:z.number().int(), y:z.number().int()}), cells: z.record(z.string(), CellSchema), inventory: z.number().int().nonnegative(), ui: z.enum(['gameplay','chat','inventory']), source: z.enum(['simulated','observed-server','predicted','historical','model']), freshness: z.enum(['current','stale','unknown']), gap: z.boolean(), fields: z.record(FieldEvidenceSchema).default({}) });
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;
export const GoalSchema = z.object({ goalId:z.string(), revision:z.number().int().nonnegative(), status:z.enum(['active','paused','completed','canceled']), text:z.string() });
export type Goal = z.infer<typeof GoalSchema>;
export const ExecutionSchema = z.object({ executionId:z.string(), proposalId:z.string(), proposalHash:z.string(), goalId:z.string(), skillId:z.string(), skillVersion:z.string(), status:z.enum(['queued','running','stopping','verifying','suspended','succeeded','failed','canceled']), reason:z.string().optional(), outcome:z.string().optional() });
export type Execution = z.infer<typeof ExecutionSchema>;
export const EffectSchema = z.object({ effectId:z.string(), executionId:z.string(), status:z.enum(['prepared','may-have-dispatched','verifying','confirmed','partial','ambiguous']), intent:z.record(z.unknown()), evidence:z.record(z.unknown()).optional() });
export type Effect = z.infer<typeof EffectSchema>;
export const InputPlanSchema = z.object({ commandId:z.string(), executionId:z.string(), context:BodyContextSchema, leaseId:z.string(), sequence:z.string(), sourceEpoch:z.string(), generatedAt:z.number(), clockDomain:z.string(), maxAge:z.number(), observationRef:z.string(), leaseUntil:z.number(), kind:z.enum(['walk','look','click','text']), payload:z.record(z.unknown()) });
export type InputPlan = z.infer<typeof InputPlanSchema>;
export type Clock = { now(): number; schedule(at:number, fn:()=>void): string; cancel(id:string): void };
export class SystemClock implements Clock {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  now() { return performance.now(); }
  schedule(at: number, fn: () => void) {
    const id = nextId('timer');
    // setTimeout overflows for delays above 2^31-1 ms and fires immediately; clamp to the
    // maximum and re-arm so long TTLs do not collapse into an instant timeout.
    const MAX_DELAY = 2_147_483_647;
    const arm = () => {
      const remaining = Math.max(0, at - this.now());
      const timer = setTimeout(() => {
        if (at - this.now() > 0) { arm(); return; }
        this.timers.delete(id); fn();
      }, Math.min(remaining, MAX_DELAY));
      this.timers.set(id, timer);
    };
    arm();
    return id;
  }
  cancel(id: string) { const timer = this.timers.get(id); if (timer) clearTimeout(timer); this.timers.delete(id); }
}
export class ManualClock implements Clock { private t=0; private q=new Map<string,{at:number;fn:()=>void}>(); now(){return this.t} schedule(at:number,fn:()=>void){const id=nextId('timer');this.q.set(id,{at,fn});return id} cancel(id:string){this.q.delete(id)} advance(ms:number){this.t+=ms; const ready=[...this.q.entries()].filter(([,v])=>v.at<=this.t).sort((a,b)=>a[1].at-b[1].at); for(const [id,v] of ready){this.q.delete(id);v.fn()}} }
export const nextId=(prefix:string)=>`${prefix}_${Math.random().toString(36).slice(2,10)}`;
export const hashProposal=(value:unknown)=>JSON.stringify(value, Object.keys(value as object).sort());
export type EventRecord={seq:string;eventId:string;kind:string;payload:unknown;context:BodyContext};
