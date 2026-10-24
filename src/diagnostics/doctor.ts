import type { RuntimeAssembly } from '../execution/factory.js';
import type { BridgeServiceStatus } from '../bridge/service/orchestrator.js';
import { redact } from './redaction.js';
import { bodyStateView, type BodyStateView } from '../motor/contracts.js';

/**
 * Doctor: a read-only report of the capabilities the assembled Runtime and its
 * Store actually have right now.
 *
 * The report never starts recovery, dispatches input, opens a network socket or
 * calls a model. When a capability is missing it is labelled `disabled` or
 * `unavailable` with a reason instead of being optimistically reported as on.
 */

export type CapabilityState = 'available' | 'disabled' | 'unavailable' | 'unknown';

export type DoctorCapability = {
  state: CapabilityState;
  reason?: string;
};

export type DoctorProviderReport = DoctorCapability & {
  provider: 'scripted' | 'openai' | 'anthropic' | 'unknown';
  configured: boolean;
  model?: string;
  transport: 'fixture' | 'network' | 'unavailable' | 'unknown';
  networkEnabled: boolean;
  canonicalPath: boolean;
};

export type DoctorBodyReport = DoctorCapability & {
  mode: '3d' | 'legacy-2d' | 'unknown';
  threeDimensional: boolean;
  legacy2d: boolean;
  source: string;
  dimension: string;
  inputs: DoctorCapability;
  jump: 'none' | 'short' | 'unknown';
  capabilities: Record<string, unknown>;
  observation?: { revision: string; freshness: string; gap: boolean };
};

export type DoctorOwnershipReport = DoctorCapability & {
  path?: string;
  pid?: number;
  hostname?: string;
  runtimeId?: string;
  epoch?: string;
};

export type DoctorRecoveryReport = DoctorCapability & {
  sessionState: string;
  attempts: number;
  budget: number;
  pendingEffects: number;
  effectCounts: Record<string, number>;
  lastFault?: { kind: string; seq: string; reason: string };
};

export type DoctorKnowledgeReport = DoctorCapability & {
  activeReleaseId?: string;
  activeVersion?: string;
  releaseCount: number;
  coverage?: { unknown: boolean; sources: unknown; namespaces: unknown; conflicts: number };
};

export type DoctorBridgeServiceReport = DoctorCapability & {
  attached: boolean;
  status?: BridgeServiceStatus | null;
  bridge?: unknown;
};

export type DoctorStoreReport = DoctorCapability & {
  path: string;
  durable: boolean;
  health: 'ok' | 'error';
  executions: number;
  effects: number;
  goals: number;
};

export type DoctorReport = {
  version: 1;
  generatedAt: number;
  status: 'ok' | 'degraded' | 'unavailable';
  profile: {
    id: string;
    simulated: boolean;
    source: string;
    dimension: string;
    worldGenerationId?: string;
    connectionEpoch: string;
    bodyEpoch: string;
  };
  provider: DoctorProviderReport;
  network: DoctorCapability;
  paidModelApi: DoctorCapability;
  body: DoctorBodyReport;
  ownership: DoctorOwnershipReport;
  recovery: DoctorRecoveryReport;
  knowledge: DoctorKnowledgeReport;
  bridgeService: DoctorBridgeServiceReport;
  store: DoctorStoreReport;
  external: { osInput: DoctorCapability; screenCapture: DoctorCapability; liveMinecraft: DoctorCapability };
  warnings: string[];
};

export type DoctorOptions = { generatedAt?: number };

const nowOf = (options: DoctorOptions): number => options.generatedAt ?? Date.now();

const counts = (values: string[]): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
};

const providerReasonOf = (runtime: RuntimeAssembly): string | undefined => {
  // UnavailableProvider exposes the concrete fail-closed reason at runtime; prefer it over guessing.
  const reason = (runtime.provider as unknown as { reason?: unknown }).reason;
  return typeof reason === 'string' ? reason : undefined;
};

function providerReport(runtime: RuntimeAssembly): DoctorProviderReport {
  const metadata = runtime.providerMetadata;
  const networkEnabled = metadata.networkEnabled === true && metadata.transport === 'network';
  const concrete = providerReasonOf(runtime);
  let state: CapabilityState = 'unavailable';
  let reason: string | undefined;
  if (metadata.transport === 'fixture') state = 'available';
  else if (metadata.configured && metadata.transport === 'network') state = 'available';
  else if (metadata.provider === 'scripted') reason = 'scripted-provider-no-model';
  else if (concrete === 'model-provider-not-configured') reason = 'model-provider-not-configured';
  else if (concrete === 'model-network-disabled' || !networkEnabled) reason = 'network-gate-disabled';
  else reason = 'provider-transport-unavailable';
  return {
    state,
    ...(reason ? { reason } : {}),
    provider: metadata.provider,
    configured: metadata.configured,
    ...(metadata.model ? { model: metadata.model } : {}),
    transport: metadata.transport,
    networkEnabled,
    canonicalPath: runtime.canonicalProviderPath,
  };
}

function networkReport(runtime: RuntimeAssembly): DoctorCapability {
  const metadata = runtime.providerMetadata;
  if (metadata.transport === 'fixture') return { state: 'disabled', reason: 'injected-fixture-transport' };
  if (metadata.transport === 'network' && metadata.networkEnabled === true) return { state: 'available' };
  if (metadata.provider !== 'scripted' && providerReasonOf(runtime) === 'model-provider-not-configured') {
    return { state: 'disabled', reason: 'provider-not-configured' };
  }
  return { state: 'disabled', reason: 'network-gate-disabled' };
}

function bodyReport(runtime: RuntimeAssembly): DoctorBodyReport {
  const adapter = runtime.bodyAdapter;
  if (adapter) {
    let observation: BodyStateView | undefined;
    let observationError: string | undefined;
    try { observation = bodyStateView(adapter); } catch (error) { observationError = error instanceof Error ? error.message : String(error); }
    const capabilities = adapter.capabilities as unknown as Record<string, unknown>;
    const threeDimensional = capabilities.threeDimensional === true && observation?.threeDimensional !== false;
    // A failed synchronous observation is not a healthy body view, even if the adapter's
    // declared capabilities are 3D.
    const state: CapabilityState = observationError ? 'unavailable' : threeDimensional ? 'available' : 'unavailable';
    return {
      state,
      ...(observationError ? { reason: `observation-error:${observationError}` } : threeDimensional ? {} : { reason: 'adapter-not-three-dimensional' }),
      mode: threeDimensional ? '3d' : 'unknown',
      threeDimensional,
      legacy2d: false,
      source: adapter.source,
      dimension: adapter.context.dimension,
      inputs: runtime.inputsEnabled
        ? { state: 'available' }
        : { state: 'disabled', reason: 'input-gate-disabled' },
      jump: capabilities.jump === 'short' ? 'short' : capabilities.jump === 'none' ? 'none' : 'unknown',
      capabilities: redact(capabilities) as Record<string, unknown>,
      ...(observation ? { observation: { revision: observation.revision, freshness: observation.freshness, gap: observation.gap } } : {}),
    };
  }
  // No adapter: the assembled body is the explicit legacy planar bridge. Planar
  // x/y is never promoted to a 3D pose.
  const bridge = runtime.bridge as unknown as {
    lookAt?: unknown; walk?: unknown; dig?: unknown;
    capabilities?: { source?: string; limitations?: string[] };
  };
  const capabilities = {
    threeDimensional: false,
    turn: typeof bridge.lookAt === 'function',
    walk: typeof bridge.walk === 'function',
    dig: typeof bridge.dig === 'function',
    jump: 'none',
    stepUp: false,
    controlledDrop: false,
  };
  return {
    state: 'available',
    reason: 'legacy-2d-body',
    mode: 'legacy-2d',
    threeDimensional: false,
    legacy2d: true,
    source: String(bridge.capabilities?.source ?? 'legacy-2d'),
    dimension: runtime.bridge.context.dimension,
    inputs: runtime.inputsEnabled ? { state: 'available' } : { state: 'disabled', reason: 'input-gate-disabled' },
    jump: 'none',
    capabilities,
  };
}

function ownershipReport(runtime: RuntimeAssembly): DoctorOwnershipReport {
  const lock = runtime.ownership;
  if (!lock) return { state: 'unavailable', reason: 'in-memory-store-no-lock' };
  if (!lock.held) return { state: 'disabled', reason: 'lock-not-held', path: lock.lockPath };
  const owner = lock.owner;
  return {
    state: 'available',
    path: lock.lockPath,
    ...(owner ? { pid: owner.pid, hostname: owner.hostname, runtimeId: owner.runtimeId, epoch: owner.epoch } : {}),
  };
}

function storeReport(runtime: RuntimeAssembly): DoctorStoreReport {
  let path = '<unavailable>';
  let health: 'ok' | 'error' = 'error';
  let reason: string | undefined;
  try {
    path = runtime.store.db.name;
    const check = runtime.store.db.pragma('quick_check') as Array<{ quick_check?: string }>;
    health = check?.[0]?.quick_check === 'ok' ? 'ok' : 'error';
    if (health === 'error') reason = 'store-integrity-check-failed';
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  let executions = 0; let effects = 0; let goals = 0;
  try {
    executions = runtime.store.listExecutions().length;
    effects = runtime.store.listEffects().length;
    goals = runtime.store.listGoals().length;
  } catch (error) {
    health = 'error'; reason = reason ?? (error instanceof Error ? error.message : String(error));
  }
  return {
    state: health === 'ok' ? 'available' : 'unavailable',
    ...(reason ? { reason } : {}),
    path,
    durable: path !== ':memory:',
    health,
    executions,
    effects,
    goals,
  };
}

function recoveryReport(runtime: RuntimeAssembly): DoctorRecoveryReport {
  const session = runtime.session;
  let pendingEffects = 0;
  let effectStatuses: string[] = [];
  let reason: string | undefined;
  try {
    const effects = runtime.store.listEffects();
    effectStatuses = effects.map(effect => String(effect.status));
    pendingEffects = runtime.store.pendingEffects().length;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  let lastFault: DoctorRecoveryReport['lastFault'];
  try {
    const latest = Number(runtime.store.getLatestCriticalSequence() ?? '0');
    const from = String(Math.max(0, latest - 1000));
    const events = runtime.store.getCriticalEvents(from, 1000) as Array<{ seq: string; kind: string; payload?: unknown }>;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.kind !== 'runtime.recovery_failed' && event.kind !== 'runtime.stopping' && event.kind !== 'session.failed') continue;
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
      lastFault = { kind: event.kind, seq: event.seq, reason: String(payload.reason ?? payload.error ?? payload.suspended ?? event.kind) };
      break;
    }
  } catch (error) {
    reason = reason ?? (error instanceof Error ? error.message : String(error));
  }
  const suspended = session.state === 'suspended';
  const state: CapabilityState = suspended ? 'unavailable'
    : session.state === 'recoverable-failure' ? 'disabled'
      : session.state === 'running' ? 'available'
        : session.state === 'idle' ? 'disabled' : 'unknown';
  const stateReason = suspended ? 'recovery-budget-exhausted'
    : session.state === 'recoverable-failure' ? 'recovery-retry-available'
      : session.state === 'idle' ? 'session-not-started'
        : session.state === 'starting' ? 'session-starting' : undefined;
  return {
    state,
    ...(reason ? { reason } : stateReason ? { reason: stateReason } : {}),
    sessionState: session.state,
    attempts: session.recoveryAttempts,
    budget: session.recoveryBudget,
    pendingEffects,
    effectCounts: counts(effectStatuses),
    ...(lastFault ? { lastFault } : {}),
  };
}

function knowledgeReport(runtime: RuntimeAssembly): DoctorKnowledgeReport {
  try {
    const releases = runtime.knowledge.listReleases();
    const activeReleaseId = runtime.knowledge.activeReleaseId();
    if (!activeReleaseId) return { state: 'unavailable', reason: 'no-active-release', releaseCount: releases.length };
    const active = releases.find(release => release.releaseId === activeReleaseId);
    const coverage = runtime.knowledge.coverage(activeReleaseId);
    return {
      state: coverage.unknown ? 'unavailable' : 'available',
      ...(coverage.unknown ? { reason: coverage.reason ?? 'knowledge-coverage-unknown' } : {}),
      activeReleaseId,
      ...(active?.version ? { activeVersion: active.version } : {}),
      releaseCount: releases.length,
      coverage: { unknown: coverage.unknown, sources: coverage.sources, namespaces: coverage.namespaces, conflicts: coverage.conflicts },
    };
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error), releaseCount: 0 };
  }
}

function bridgeServiceReport(runtime: RuntimeAssembly): DoctorBridgeServiceReport {
  const bridge = (runtime.bridge as { capabilities?: unknown }).capabilities;
  if (!runtime.bridgeService) {
    return { state: 'unavailable', reason: 'bridge-service-not-attached', attached: false, ...(bridge === undefined ? {} : { bridge: redact(bridge) }) };
  }
  try {
    const status = runtime.bridgeService.status();
    const state: CapabilityState = status.state === 'running' ? 'available'
      : status.state === 'degraded' ? 'disabled'
        : status.state === 'failed' ? 'unavailable'
          : status.state === 'stopped' || status.state === 'idle' ? 'disabled' : 'unknown';
    return {
      state,
      ...(state === 'available' ? {} : { reason: `bridge-service-${status.state}` }),
      attached: true,
      status: redact(status) as BridgeServiceStatus,
      ...(bridge === undefined ? {} : { bridge: redact(bridge) }),
    };
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error), attached: true, ...(bridge === undefined ? {} : { bridge: redact(bridge) }) };
  }
}

function externalReport(runtime: RuntimeAssembly): DoctorReport['external'] {
  const capabilities = (runtime.bridge as { capabilities?: { nativeInput?: boolean; screenCapture?: boolean; protocolObservation?: boolean } }).capabilities;
  return {
    osInput: capabilities?.nativeInput === true
      ? { state: 'available' }
      : { state: 'disabled', reason: 'os-input-gate-disabled' },
    screenCapture: capabilities?.screenCapture === true
      ? { state: 'available' }
      : { state: 'disabled', reason: 'screen-capture-gate-disabled' },
    // There is no live Minecraft connection in this offline assembly. Never claim one.
    liveMinecraft: { state: 'disabled', reason: 'live-minecraft-not-connected' },
  };
}

/** Build a truthful doctor report from an assembled Runtime. Read-only. */
export function collectDoctorReport(runtime: RuntimeAssembly, options: DoctorOptions = {}): DoctorReport {
  const provider = providerReport(runtime);
  const network = networkReport(runtime);
  const body = bodyReport(runtime);
  const ownership = ownershipReport(runtime);
  const recovery = recoveryReport(runtime);
  const knowledge = knowledgeReport(runtime);
  const bridgeService = bridgeServiceReport(runtime);
  const store = storeReport(runtime);
  const external = externalReport(runtime);
  const context = runtime.bridge.context;

  const warnings: string[] = [];
  const check = (name: string, capability: { state: CapabilityState; reason?: string }) => {
    if (capability.state !== 'available') warnings.push(`${name}:${capability.reason ?? capability.state}`);
  };
  check('provider', provider); check('network', network); check('body', body);
  // A legacy body is usable but cannot serve 3D actions; keep that boundary visible.
  if (!body.threeDimensional) warnings.push(`body:${body.reason ?? 'legacy-2d-body'}`);
  check('body-inputs', body.inputs); check('ownership', ownership); check('recovery', recovery);
  check('knowledge', knowledge); check('bridge-service', bridgeService); check('store', store);
  check('os-input', external.osInput); check('screen-capture', external.screenCapture);

  const blockers = store.state !== 'available' || recovery.state === 'unavailable';
  const degraded = provider.state !== 'available' || network.state !== 'available' || !body.threeDimensional
    || ownership.state !== 'available' || knowledge.state !== 'available' || bridgeService.state !== 'available';
  const status: DoctorReport['status'] = blockers ? 'unavailable' : degraded ? 'degraded' : 'ok';

  return {
    version: 1,
    generatedAt: nowOf(options),
    status,
    profile: {
      id: context.serverProfileId,
      simulated: context.serverProfileId === 'simulated',
      source: String((runtime.bridge as { capabilities?: { source?: string } }).capabilities?.source ?? 'simulated'),
      dimension: context.dimension,
      ...(context.worldGenerationId ? { worldGenerationId: context.worldGenerationId } : {}),
      connectionEpoch: context.connectionEpoch,
      bodyEpoch: context.bodyEpoch,
    },
    provider,
    network,
    paidModelApi: network.state === 'available' ? { state: 'available' } : { state: 'disabled', reason: 'offline-batch-paid-api-disabled' },
    body,
    ownership,
    recovery,
    knowledge,
    bridgeService,
    store,
    external,
    warnings,
  };
}

export type UnavailableDoctorInput = {
  profile: string;
  reason: string;
  dbPath?: string;
  generatedAt?: number;
};

/**
 * An explicit report for a runtime that could not be assembled at all (for
 * example client-offline without a real body, or a storage path owned by
 * another process). Every capability is unavailable; nothing is guessed.
 */
export function unavailableDoctorReport(input: UnavailableDoctorInput): DoctorReport {
  const capability: DoctorCapability = { state: 'unavailable', reason: input.reason };
  const body: DoctorBodyReport = { ...capability, mode: 'unknown', threeDimensional: false, legacy2d: false, source: 'unavailable', dimension: 'unknown', inputs: capability, jump: 'unknown', capabilities: {} };
  return {
    version: 1,
    generatedAt: input.generatedAt ?? Date.now(),
    status: 'unavailable',
    profile: { id: input.profile, simulated: false, source: 'unavailable', dimension: 'unknown', connectionEpoch: 'unknown', bodyEpoch: 'unknown' },
    provider: { ...capability, provider: 'unknown', configured: false, transport: 'unavailable', networkEnabled: false, canonicalPath: false },
    network: { state: 'disabled', reason: 'network-gate-disabled' },
    paidModelApi: { state: 'disabled', reason: 'offline-batch-paid-api-disabled' },
    body,
    ownership: { ...capability, ...(input.dbPath ? { path: `${input.dbPath}.owner.lock` } : {}) },
    recovery: { ...capability, sessionState: 'unavailable', attempts: 0, budget: 0, pendingEffects: 0, effectCounts: {} },
    knowledge: { ...capability, releaseCount: 0 },
    bridgeService: { ...capability, attached: false },
    store: { ...capability, path: input.dbPath ?? '<unavailable>', durable: false, health: 'error', executions: 0, effects: 0, goals: 0 },
    external: {
      osInput: { state: 'disabled', reason: 'os-input-gate-disabled' },
      screenCapture: { state: 'disabled', reason: 'screen-capture-gate-disabled' },
      liveMinecraft: { state: 'disabled', reason: 'live-minecraft-not-connected' },
    },
    warnings: [`runtime:${input.reason}`],
  };
}
