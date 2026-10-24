import { z } from 'zod';

export const SkillIdSchema = z.enum(['navigate_to','observe_ui','send_chat','place_one','wait_for_condition','look_at','explore_area','dig_one','collect_nearby','gather_blocks','return_to_place']);
export type SkillId = z.infer<typeof SkillIdSchema>;
export const SkillLifecycleStateSchema = z.enum(['queued','running','stopping','verifying','suspended','succeeded','failed','canceled']);
export type SkillLifecycleState = z.infer<typeof SkillLifecycleStateSchema>;
export const SkillManifestSchema = z.object({
  id: SkillIdSchema, version: z.string(), resources: z.array(z.string()), cancellable: z.boolean(), parameters: z.record(z.unknown()),
  prerequisites: z.array(z.string()).default([]), progress: z.array(z.string()).default([]), terminalOutcomes: z.array(z.string()).default([]),
  cancellation: z.string().default('cooperative'),
  /** True when invoking the skill can change the world or inventory and therefore needs an effect barrier. */
  writes: z.boolean().default(false),
  /** False when the skill is atomic and must restart rather than resume after pause. */
  suspendable: z.boolean().default(true),
  /** Extra evidence names the skill must observe before claiming a confirmed outcome. */
  evidence: z.array(z.string()).default([]),
  /**
   * Coordinate contract. `world-3d` skills require x/y/z and delegate to the
   * attached BodyAdapter; `legacy-2d` skills still use the planar bridge until
   * a real 3D contract exists and must be labelled as such.
   */
  coordinateSpace: z.enum(['world-3d', 'legacy-2d']).default('legacy-2d'),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const skillManifests: readonly SkillManifest[] = [
  { id: 'navigate_to', version: '2.0.0', resources: ['movement','view'], cancellable: true, parameters: { type: 'object', required: ['x','y','z'] }, prerequisites: ['current-position'], progress: ['prepare','dispatch','verify'], terminalOutcomes: ['confirmed','failed','canceled'], cancellation: 'cooperative', writes: false, suspendable: true, evidence: ['target-reached'], coordinateSpace: 'world-3d' },
  { id: 'observe_ui', version: '1.0.0', resources: ['ui'], cancellable: true, parameters: { type: 'object' }, prerequisites: ['ui-observation'], progress: ['prepare','dispatch','verify'], terminalOutcomes: ['confirmed','failed','canceled'], cancellation: 'cooperative', writes: false, suspendable: true, evidence: ['snapshot'], coordinateSpace: 'legacy-2d' },
  { id: 'send_chat', version: '1.0.0', resources: ['ui','textEntry'], cancellable: true, parameters: { type: 'object', required: ['text'] }, prerequisites: ['chat-ui'], progress: ['prepare','dispatch','verify'], terminalOutcomes: ['confirmed','ambiguous','failed','canceled'], cancellation: 'cooperative', writes: true, suspendable: true, evidence: ['non-ambiguous-receipt'], coordinateSpace: 'legacy-2d' },
  { id: 'place_one', version: '1.0.0', resources: ['hands','view'], cancellable: true, parameters: { type: 'object', required: ['x','y'] }, prerequisites: ['free-target','inventory'], progress: ['prepare','dispatch','verify'], terminalOutcomes: ['confirmed','ambiguous','failed','canceled'], cancellation: 'cooperative', writes: true, suspendable: true, evidence: ['accepted-receipt','observed-blocked'], coordinateSpace: 'legacy-2d' },
  { id: 'wait_for_condition', version: '1.0.0', resources: [], cancellable: true, parameters: { type: 'object', required: ['ms'] }, prerequisites: ['clock'], progress: ['prepare','dispatch','verify'], terminalOutcomes: ['confirmed','failed','canceled'], cancellation: 'cooperative', writes: false, suspendable: false, evidence: ['deadline-elapsed'], coordinateSpace: 'legacy-2d' },
  { id: 'look_at', version: '1.0.0', resources: ['view'], cancellable: true, parameters: { type: 'object', required: ['x','y'] }, prerequisites: ['orientation'], progress: ['prepare','dispatch','verify'], terminalOutcomes: ['confirmed','failed','canceled'], cancellation: 'cooperative', writes: false, suspendable: true, evidence: ['accepted-orientation'], coordinateSpace: 'legacy-2d' },
  { id: 'explore_area', version: '1.0.0', resources: ['movement','view'], cancellable: true, parameters: { type: 'object', required: ['radius'] }, prerequisites: ['local-observation'], progress: ['prepare','dispatch','observe','verify'], terminalOutcomes: ['confirmed','partial','failed','canceled'], cancellation: 'cooperative', writes: false, suspendable: true, evidence: ['snapshot'], coordinateSpace: 'world-3d' },
  { id: 'dig_one', version: '1.0.0', resources: ['hands','view'], cancellable: true, parameters: { type: 'object', required: ['x','y'] }, prerequisites: ['reachable-target','tool'], progress: ['prepare','dispatch','verify'], terminalOutcomes: ['confirmed','ambiguous','failed','canceled'], cancellation: 'cooperative', writes: true, suspendable: true, evidence: ['accepted-receipt','observed-free'], coordinateSpace: 'legacy-2d' },
  { id: 'collect_nearby', version: '1.0.0', resources: ['movement','hands'], cancellable: true, parameters: { type: 'object' }, prerequisites: ['entity-observation'], progress: ['prepare','dispatch','verify'], terminalOutcomes: ['confirmed','partial','ambiguous','failed','canceled'], cancellation: 'cooperative', writes: true, suspendable: true, evidence: ['collected-count','inventory-delta'], coordinateSpace: 'legacy-2d' },
  { id: 'gather_blocks', version: '1.0.0', resources: ['movement','hands','view'], cancellable: true, parameters: { type: 'object', required: ['block'], properties: { block: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 16 } } }, prerequisites: ['known-target'], progress: ['prepare','dispatch','verify'], terminalOutcomes: ['confirmed','partial','ambiguous','failed','canceled'], cancellation: 'cooperative', writes: true, suspendable: true, evidence: ['accepted-receipt','observed-free','requested-count'], coordinateSpace: 'world-3d' },
  { id: 'return_to_place', version: '1.0.0', resources: ['movement','view'], cancellable: true, parameters: { type: 'object', required: ['placeId'] }, prerequisites: ['remembered-place'], progress: ['prepare','dispatch','verify'], terminalOutcomes: ['confirmed','failed','canceled'], cancellation: 'cooperative', writes: false, suspendable: true, evidence: ['fresh-place','target-reached'], coordinateSpace: 'world-3d' },
];
export function findSkills(query?: string) { return skillManifests.filter(s => !query || s.id.includes(query)); }
export function findSkill(id: string) { return skillManifests.find(skill => skill.id === id); }

/** Return every declared prerequisite that is not positively observed. Unknown is not satisfied. */
export function missingPreconditions(manifest: SkillManifest, observed: Readonly<Record<string, boolean | undefined>> = {}): string[] {
  return manifest.prerequisites.filter(name => observed[name] !== true);
}
export function hasAllPreconditions(manifest: SkillManifest, observed: Readonly<Record<string, boolean | undefined>> = {}): boolean {
  return missingPreconditions(manifest, observed).length === 0;
}
