/**
 * One classifier shared by the router, provider fan-out and skill discovery.
 *
 * A tool is exactly one of:
 *   - read          no external effect; a batch of reads may fan out concurrently.
 *   - write         external effect (chat, body input, durable memory).
 *   - control-write changes agent/control state (goal revision, execution cancel).
 *
 * The classifier is intentionally data-driven: `start_skill` is resolved through the
 * skill registry's `writes` flag instead of a hard-coded list, because the effect of
 * `start_skill` depends on the skill named in its arguments.
 */
import { findSkill } from '../skills/registry.js';
import type { ToolCall } from './scripted/index.js';

export type ToolClass = 'read' | 'write' | 'control-write';

/** Tools that mutate control state and must never run concurrently with other mutations. */
export const DEFAULT_CONTROL_WRITE_TOOLS: readonly string[] = ['revise_goal', 'cancel_execution'];
/** Tools with external/non-control writes. `start_skill` is also listed for public compatibility. */
export const DEFAULT_WRITE_TOOLS: readonly string[] = ['start_skill', 'send_chat', 'remember_place'];

/**
 * Public write-tool list (write + control-write). `start_skill` remains present so callers
 * that only know the historical writeTools contract still see it, while classification
 * resolves the actual skill dynamically.
 */
export const defaultWriteTools: readonly string[] = [...DEFAULT_WRITE_TOOLS, ...DEFAULT_CONTROL_WRITE_TOOLS];

export type ToolClassifierOptions = {
  /** Explicit additional write tools. Control-write classification still wins. */
  writeTools?: Iterable<string>;
  /** Explicit additional control-write tools. */
  controlWriteTools?: Iterable<string>;
  /** Override the skill registry lookup (tests/fixtures). Return undefined for an unknown skill. */
  skillWrites?: (skillId: string) => boolean | undefined;
};

const parseArgs = (value: string): Record<string, unknown> | undefined => {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
};

/**
 * Classify a concrete tool call. Unknown names are reads only when they are not declared
 * as writes; an actual unknown tool fails in the router without performing work.
 */
export function classifyToolCall(call: Pick<ToolCall, 'name' | 'arguments'>, options: ToolClassifierOptions = {}): ToolClass {
  // Explicit options extend the built-in classification; they never downgrade a tool that
  // the shared registry already knows is effectful.
  const controlWrites = new Set(DEFAULT_CONTROL_WRITE_TOOLS);
  for (const name of options.controlWriteTools ?? []) controlWrites.add(name);
  if (controlWrites.has(call.name)) return 'control-write';

  // Dynamic skill classification: the registry is the single source of truth for whether
  // a skill changes the body/world. A malformed/unknown skill falls through to the caller's
  // explicit write list; the router will reject it before doing anything.
  if (call.name === 'start_skill') {
    const skill = parseArgs(call.arguments)?.skill;
    if (typeof skill === 'string') {
      const writes = options.skillWrites ? options.skillWrites(skill) : findSkill(skill)?.writes;
      if (writes !== undefined) return writes ? 'write' : 'read';
    }
  }

  const writes = new Set(DEFAULT_WRITE_TOOLS);
  for (const name of options.writeTools ?? []) writes.add(name);
  return writes.has(call.name) ? 'write' : 'read';
}

export function createToolClassifier(options: ToolClassifierOptions = {}) {
  return (call: Pick<ToolCall, 'name' | 'arguments'>) => classifyToolCall(call, options);
}

/** Mutation means the call must be serialized in model order. */
export const isMutationClass = (toolClass: ToolClass) => toolClass !== 'read';
