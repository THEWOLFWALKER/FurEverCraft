import { z } from 'zod';

export const SkillIdSchema = z.enum(['navigate_to','observe_ui','send_chat','place_one','wait_for_condition','look_at','explore_area','dig_one','collect_nearby','gather_blocks','return_to_place']);
export type SkillId = z.infer<typeof SkillIdSchema>;
export const SkillManifestSchema = z.object({ id: SkillIdSchema, version: z.string(), resources: z.array(z.string()), cancellable: z.boolean(), parameters: z.record(z.unknown()), prerequisites: z.array(z.string()).default([]), progress: z.array(z.string()).default([]), terminalOutcomes: z.array(z.string()).default([]), cancellation: z.string().default('cooperative') });
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const skillManifests: readonly SkillManifest[] = [
  { id: 'navigate_to', version: '1.0.0', resources: ['movement','view'], cancellable: true, parameters: { type: 'object', required: ['x','y'] }, prerequisites: ['current-position'], progress: ['dispatch','verify'], terminalOutcomes: ['confirmed','failed','canceled'], cancellation: 'cooperative' },
  { id: 'observe_ui', version: '1.0.0', resources: ['ui'], cancellable: true, parameters: { type: 'object' }, prerequisites: ['ui-observation'], progress: ['dispatch','verify'], terminalOutcomes: ['confirmed','failed','canceled'], cancellation: 'cooperative' },
  { id: 'send_chat', version: '1.0.0', resources: ['ui','textEntry'], cancellable: true, parameters: { type: 'object', required: ['text'] }, prerequisites: ['chat-ui'], progress: ['dispatch','verify'], terminalOutcomes: ['confirmed','ambiguous','failed','canceled'], cancellation: 'cooperative' },
  { id: 'place_one', version: '1.0.0', resources: ['hands','view'], cancellable: true, parameters: { type: 'object', required: ['x','y'] }, prerequisites: ['free-target','inventory'], progress: ['dispatch','verify'], terminalOutcomes: ['confirmed','ambiguous','failed','canceled'], cancellation: 'cooperative' },
  { id: 'wait_for_condition', version: '1.0.0', resources: [], cancellable: true, parameters: { type: 'object', required: ['ms'] }, prerequisites: ['clock'], progress: ['dispatch','verify'], terminalOutcomes: ['confirmed','failed','canceled'], cancellation: 'cooperative' },
  { id: 'look_at', version: '1.0.0', resources: ['view'], cancellable: true, parameters: { type: 'object', required: ['x','y'] }, prerequisites: ['orientation'], progress: ['dispatch','verify'], terminalOutcomes: ['confirmed','failed','canceled'], cancellation: 'cooperative' },
  { id: 'explore_area', version: '1.0.0', resources: ['movement','view'], cancellable: true, parameters: { type: 'object', required: ['radius'] }, prerequisites: ['local-observation'], progress: ['dispatch','observe','verify'], terminalOutcomes: ['confirmed','partial','failed','canceled'], cancellation: 'cooperative' },
  { id: 'dig_one', version: '1.0.0', resources: ['hands','view'], cancellable: true, parameters: { type: 'object', required: ['x','y'] }, prerequisites: ['reachable-target','tool'], progress: ['dispatch','verify'], terminalOutcomes: ['confirmed','ambiguous','failed','canceled'], cancellation: 'cooperative' },
  { id: 'collect_nearby', version: '1.0.0', resources: ['movement','hands'], cancellable: true, parameters: { type: 'object' }, prerequisites: ['entity-observation'], progress: ['dispatch','verify'], terminalOutcomes: ['confirmed','partial','failed','canceled'], cancellation: 'cooperative' },
  { id: 'gather_blocks', version: '1.0.0', resources: ['movement','hands','view'], cancellable: true, parameters: { type: 'object', required: ['block'] }, prerequisites: ['known-target'], progress: ['dispatch','verify'], terminalOutcomes: ['confirmed','partial','failed','canceled'], cancellation: 'cooperative' },
  { id: 'return_to_place', version: '1.0.0', resources: ['movement','view'], cancellable: true, parameters: { type: 'object', required: ['placeId'] }, prerequisites: ['remembered-place'], progress: ['dispatch','verify'], terminalOutcomes: ['confirmed','failed','canceled'], cancellation: 'cooperative' },
];
export function findSkills(query?: string) { return skillManifests.filter(s => !query || s.id.includes(query)); }
export function findSkill(id: string) { return skillManifests.find(skill => skill.id === id); }
