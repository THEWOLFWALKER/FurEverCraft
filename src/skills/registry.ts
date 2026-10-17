import { z } from 'zod';

export const SkillIdSchema = z.enum(['navigate_to','observe_ui','send_chat','place_one','wait_for_condition']);
export type SkillId = z.infer<typeof SkillIdSchema>;
export const SkillManifestSchema = z.object({ id: SkillIdSchema, version: z.string(), resources: z.array(z.string()), cancellable: z.boolean(), parameters: z.record(z.unknown()) });
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const skillManifests: readonly SkillManifest[] = [
  { id: 'navigate_to', version: '1.0.0', resources: ['movement','view'], cancellable: true, parameters: { type: 'object', required: ['x','y'] } },
  { id: 'observe_ui', version: '1.0.0', resources: ['ui'], cancellable: true, parameters: { type: 'object' } },
  { id: 'send_chat', version: '1.0.0', resources: ['ui','textEntry'], cancellable: true, parameters: { type: 'object', required: ['text'] } },
  { id: 'place_one', version: '1.0.0', resources: ['hands','view'], cancellable: true, parameters: { type: 'object', required: ['x','y'] } },
  { id: 'wait_for_condition', version: '1.0.0', resources: [], cancellable: true, parameters: { type: 'object', required: ['ms'] } },
];
export function findSkills(query?: string) { return skillManifests.filter(s => !query || s.id.includes(query)); }
export function findSkill(id: string) { return skillManifests.find(skill => skill.id === id); }
