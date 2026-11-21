import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BodyContext, Clock } from './index.js';

/**
 * L2 section 1: the stable identity of a world. Unlike BodyContext it has no connection
 * epochs, so it can survive reconnects while still separating accounts, worlds and
 * dimensions. Every field is required: an identity that is missing any of them is
 * `unresolved`, never a partially matching scope.
 */
export const StableScopeSchema = z.object({
  serverProfileId: z.string().min(1),
  accountId: z.string().min(1),
  worldGenerationId: z.string().min(1),
  dimensionId: z.string().min(1),
});
export type StableScope = z.infer<typeof StableScopeSchema>;
export type UnresolvedScope = { status: 'unresolved'; missing: string[] };
export type ResolvedScope = { status: 'resolved'; scope: StableScope };
export type ScopeResolution = ResolvedScope | UnresolvedScope;

/** The immutable per-execution identity captured when work is admitted. */
export const ExecutionContextSchema = z.object({
  scope: StableScopeSchema,
  connectionEpoch: z.string().min(1),
  bodyEpoch: z.string().min(1),
  registryEpoch: z.string().min(1),
  observerEpoch: z.string().min(1),
  helperEpoch: z.string().min(1),
  runtimeOwnerId: z.string().min(1),
  executionId: z.string().min(1),
  plannerGeneration: z.number().int().nonnegative(),
  controlGeneration: z.number().int().nonnegative(),
  goalId: z.string().min(1),
  goalRevision: z.number().int().nonnegative(),
  bundleId: z.string().min(1),
  bundleDigest: z.string().min(1),
});
export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

/** Provenance attached to an observation. Synthetic evidence never counts as client truth. */
export const EvidenceRefSchema = z.object({
  id: z.string().min(1),
  source: z.enum(['client-reported', 'server-observed', 'predicted', 'historical', 'model', 'synthetic', 'simulated']),
  scope: StableScopeSchema,
  connectionEpoch: z.string(),
  bodyEpoch: z.string(),
  observerEpoch: z.string(),
  registryEpoch: z.string(),
  streamId: z.string().optional(),
  sequence: z.string().optional(),
  observedMono: z.number(),
  clockDomainId: z.string().min(1),
  receivedUtc: z.string().min(1),
  validUntilMono: z.number().optional(),
  fieldRevision: z.string(),
  bundleDigest: z.string(),
  provenanceRef: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

/** Canonical JSON is sorted by key at every level so equal scopes hash identically. */
export function canonicalJson(value: unknown): string {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, walk(entry)]));
    }
    return item;
  };
  return JSON.stringify(walk(value));
}

/** `scope_key` is never a concatenated string: it is a hash over canonical full scope JSON. */
export function canonicalScopeKey(scope: StableScope): string {
  return createHash('sha256').update(canonicalJson(scope)).digest('hex');
}

/**
 * BodyContext is the bridge's wire-facing record (it uses `dimension` and optional identity).
 * This is the only supported conversion to a stable scope. **Every durable field is required**:
 * an identity missing account/world/dimension is `unresolved`, never a partially matching scope,
 * so two accounts/worlds can never collide on a scope that omits the distinguishing field. A
 * local/fixture runtime that does not expose one of these fields still needs a stable internal
 * scope; that is supplied by the runtime assembly (see `memoryScopeOf`/factory), never by
 * loosening this resolver.
 *
 * A stored body context may carry the dimension under either name: bridge wire records use
 * `dimension` while a `StableScope` uses `dimensionId`. Both are accepted (v0.2 semantics) so a
 * durable row written from a resolved scope is found again by the read that resolves it.
 */
export function resolveStableScope(context: Partial<BodyContext> | undefined): ScopeResolution {
  if (!context) return { status: 'unresolved', missing: ['context'] };
  const record = context as Record<string, unknown>;
  const dimension = typeof record.dimension === 'string' && record.dimension
    ? record.dimension
    : typeof record.dimensionId === 'string' && record.dimensionId ? record.dimensionId : undefined;
  const missing: string[] = [];
  if (!context.serverProfileId) missing.push('serverProfileId');
  if (!context.accountId) missing.push('accountId');
  if (!context.worldGenerationId) missing.push('worldGenerationId');
  if (!dimension) missing.push('dimensionId');
  if (missing.length) return { status: 'unresolved', missing };
  return {
    status: 'resolved',
    scope: {
      serverProfileId: context.serverProfileId,
      accountId: context.accountId,
      worldGenerationId: context.worldGenerationId,
      dimensionId: dimension,
    } as StableScope,
  };
}

/**
 * Tracks the current session context. The provider is the only source of scope for tools;
 * the model can never choose it. A world/account/dimension change invalidates the previous
 * resolution until a fresh resolved context is observed.
 */
export interface ContextProvider {
  current(): { status: 'resolved'; context: ExecutionContext } | { status: 'unresolved'; missing: string[] };
  /** Capture a snapshot for admission. Returns undefined when identity is unresolved. */
  capture(executionId: string, goalId: string, goalRevision: number, extras: ContextExtras): ExecutionContext | undefined;
}

export type ContextExtras = {
  registryEpoch?: string;
  observerEpoch?: string;
  helperEpoch?: string;
  runtimeOwnerId?: string;
  plannerGeneration?: number;
  controlGeneration?: number;
  bundleId?: string;
  bundleDigest?: string;
};

export type ContextSource = {
  /** Current bridge context, copied by the provider so later mutation cannot rewrite history. */
  bodyContext(): Partial<BodyContext>;
  extras?: () => ContextExtras;
};

export class SessionContextProvider implements ContextProvider {
  constructor(private readonly source: ContextSource) {}

  current(): { status: 'resolved'; context: ExecutionContext } | { status: 'unresolved'; missing: string[] } {
    const body = this.source.bodyContext();
    const scope = resolveStableScope(body);
    if (scope.status === 'unresolved') return scope;
    const extras = this.source.extras?.() ?? {};
    const connectionEpoch = body.connectionEpoch;
    const bodyEpoch = body.bodyEpoch;
    if (!connectionEpoch || !bodyEpoch) {
      return { status: 'unresolved', missing: [connectionEpoch ? 'bodyEpoch' : 'connectionEpoch'] };
    }
    return {
      status: 'resolved',
      context: {
        scope: scope.scope,
        connectionEpoch,
        bodyEpoch,
        registryEpoch: extras.registryEpoch ?? 'unresolved',
        observerEpoch: extras.observerEpoch ?? 'unresolved',
        helperEpoch: extras.helperEpoch ?? 'unresolved',
        runtimeOwnerId: extras.runtimeOwnerId ?? 'unresolved',
        executionId: 'unresolved',
        plannerGeneration: extras.plannerGeneration ?? 0,
        controlGeneration: extras.controlGeneration ?? 0,
        goalId: 'unresolved',
        goalRevision: 0,
        bundleId: extras.bundleId ?? 'unresolved',
        bundleDigest: extras.bundleDigest ?? 'unresolved',
      },
    };
  }

  capture(executionId: string, goalId: string, goalRevision: number, extras: ContextExtras): ExecutionContext | undefined {
    const current = this.current();
    if (current.status !== 'resolved') return undefined;
    return {
      ...current.context,
      ...extras,
      executionId,
      goalId,
      goalRevision,
    };
  }

  /** Re-check a captured context against the live one right before an async boundary. */
  matches(captured: ExecutionContext): { ok: true } | { ok: false; reason: string } {
    const current = this.current();
    if (current.status !== 'resolved') return { ok: false, reason: `context-unresolved:${current.missing.join(',')}` };
    const live = current.context;
    if (canonicalScopeKey(live.scope) !== canonicalScopeKey(captured.scope)) return { ok: false, reason: 'scope-changed' };
    if (live.connectionEpoch !== captured.connectionEpoch) return { ok: false, reason: 'connection-epoch-changed' };
    if (live.bodyEpoch !== captured.bodyEpoch) return { ok: false, reason: 'body-epoch-changed' };
    if (captured.controlGeneration !== 0 && live.controlGeneration !== captured.controlGeneration) return { ok: false, reason: 'control-generation-changed' };
    return { ok: true };
  }
}

/**
 * Two time domains must never be interchangeable just because both are numbers:
 * `clock.now()` is monotonic process time for timers/leases; `utcNow()` is wall-clock
 * ISO text for persisted freshness. Restarting does not make monotonic time durable.
 */
export interface TimeServices {
  readonly clock: Clock;
  utcNow(): string;
  readonly clockDomainId: string;
}

export function createTimeServices(clock: Clock, clockDomainId = `clock_${Math.random().toString(36).slice(2, 10)}`): TimeServices {
  return { clock, clockDomainId, utcNow: () => new Date(Date.now()).toISOString() };
}
