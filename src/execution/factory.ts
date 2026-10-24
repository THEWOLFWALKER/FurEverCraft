import { FakeClientBridge } from '../bridge/fake/index.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import { SQLiteStore } from '../persistence/store.js';
import { SessionRuntime } from './session.js';
import { ToolRouter, AgentLoop, memoryScopeOf } from '../agent/router.js';
import { Executor, InputArbiter, leaseContextEpoch } from './runtime.js';
import { ExecutionAdmission } from './admission.js';
import { RuntimeOwnershipLock, type OwnershipLockOptions } from './ownership.js';
import { MemoryService, type MemoryScope } from '../autonomous/memory.js';
import { KnowledgeService } from '../autonomous/knowledge.js';
import { UnavailableProvider, type ModelProvider } from '../providers/scripted/index.js';
import { createConfiguredProvider } from '../providers/index.js';
import type { HttpTransport } from '../providers/shared.js';
import type { ProviderSession } from '../providers/session.js';
import { SkillLifecycle } from '../skills/lifecycle.js';
import { attachBodyAdapter, type BodyAdapter } from '../motor/contracts.js';
import { createSimulatedBodyAdapter } from '../fixtures/body-adapter.js';
import type { BridgeService } from '../bridge/service/orchestrator.js';
import type { Clock } from '../contracts/index.js';
import { ManualClock, SystemClock } from '../contracts/index.js';
import { EventHub } from '../diagnostics/events.js';
import { ControlService } from '../control/service.js';
import { GoalManager, TaskScheduler } from '../autonomous/tasks.js';
import type { ProviderMetadata } from '../control/dto.js';
import { navigate } from '../skills/navigation.js';
import type { MotorFactory } from '../motor/controller.js';

export type RuntimeProfile = 'simulated' | 'simulated-3d' | 'client-offline' | 'unsupported';
export type RuntimeNavPort = { navigate: typeof navigate };
export type RuntimeMotorPort = MotorFactory;

/** The explicit dependency container every profile is assembled from. */
export type RuntimeDependencies = {
  clock: Clock;
  store: SQLiteStore;
  events: EventHub;
  provider: ModelProvider;
  body: ClientBridgeCapabilities;
  nav: RuntimeNavPort;
  motor?: RuntimeMotorPort;
  /** Optional attached 3D body; absent means the explicitly legacy 2D path. */
  bodyAdapter?: BodyAdapter;
};

export type RuntimeFactoryOptions = {
  profile?: RuntimeProfile;
  db?: string;
  clock?: Clock;
  store?: SQLiteStore;
  events?: EventHub;
  provider?: ModelProvider;
  /**
   * Explicit provider registry for the canonical loop (for example `{ openai, anthropic }`).
   * Supplying this enables provider switching: every entry is registered, and the initial
   * provider is selected by `modelProvider` (or the first entry). These providers are injected
   * dependencies, hence offline (`networkEnabled: false`).
   */
  providers?: Record<string, ModelProvider>;
  /** Explicit body adapter. `bridge` is the legacy alias for the same dependency. */
  body?: ClientBridgeCapabilities;
  bridge?: ClientBridgeCapabilities;
  nav?: RuntimeNavPort;
  motor?: RuntimeMotorPort;
  /**
   * Optional 3D body. When supplied it is validated against the bridge context and
   * attached before the router/skills exist, so every tool path sees the same body.
   * Omitting it on the `simulated` profile keeps the explicit legacy 2D demo path.
   */
  bodyAdapter?: BodyAdapter;
  allowModelNetwork?: boolean;
  modelProvider?: 'scripted' | 'openai' | 'anthropic';
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Injected provider transport. Never counts as enabled network access. */
  transport?: HttpTransport;
  /** Optional P09 bridge-service orchestration owned/stopped with this runtime. */
  bridgeService?: { service: BridgeService; autostart?: boolean };
  /** Whether body input may be dispatched. Defaults to on for the simulated profile only. */
  inputsEnabled?: boolean;
  /** Execution lease/watchdog window in clock milliseconds. */
  leaseTtl?: number;
  watchdogTtl?: number;
  /** Consecutive recovery attempts allowed before the session stays suspended. */
  maxRecoveryAttempts?: number;
  lockOptions?: OwnershipLockOptions;
};
export type RuntimeAssembly = {
  bridge: ClientBridgeCapabilities;
  /** The profile this runtime was actually assembled from, separate from the body/server id. */
  runtimeProfile: RuntimeProfile;
  store: SQLiteStore;
  session: SessionRuntime;
  router: ToolRouter;
  provider: ModelProvider;
  providerMetadata: ProviderMetadata;
  loop: AgentLoop;
  clock: Clock;
  control: ControlService;
  goalManager: import('../autonomous/tasks.js').GoalManager;
  scheduler: import('../autonomous/tasks.js').TaskScheduler;
  /** Durable, scoped memory (places/episodes) consumed by router and control. */
  memory: MemoryService;
  memoryScope: MemoryScope;
  /** Release-backed knowledge service shared by every knowledge tool. */
  knowledge: KnowledgeService;
  /** Pause/cancel/human-control state for in-flight skill runs. */
  lifecycle: SkillLifecycle;
  /** Attached 3D body, or undefined for the explicit legacy 2D path. */
  bodyAdapter?: BodyAdapter;
  /** Present only when the canonical provider session is the production loop. */
  providerSession?: ProviderSession;
  canonicalProviderPath: boolean;
  /** P09 bridge service orchestration attached to this runtime, when provided. */
  bridgeService?: BridgeService;
  /** Explicit dependency container the runtime was assembled from. */
  dependencies: RuntimeDependencies;
  ownerId: string;
  /** Raw configured input gate; does not by itself prove input can be dispatched. */
  inputsEnabled: boolean;
  /**
   * Effective control state from the attached bridge service. Without an attached service
   * the runtime's own input setting is authoritative and this is always open.
   */
  controlOpen(): boolean;
  ownership?: RuntimeOwnershipLock;
  startBridgeService?(): Promise<void>;
  close(): void;
};

/**
 * A client-offline runtime must be attached to a real client body. A simulated/fake body is
 * never substituted: the profile fails closed instead of pretending offline capability.
 */
function assertRealBody(body: ClientBridgeCapabilities): void {
  if (body instanceof FakeClientBridge) throw new Error('client-offline-requires-real-body');
  const profileMarker = (body as { capabilities?: { source?: string } }).capabilities?.source;
  if (profileMarker === 'simulated' || profileMarker === 'fixture' || body.context?.serverProfileId === 'simulated') {
    throw new Error('client-offline-requires-real-body');
  }
}

/** The 3D adapter must describe the same stable world the bridge is attached to. */
function assertBodyAdapterContext(bridge: ClientBridgeCapabilities, adapter: BodyAdapter): void {
  const expected = bridge.context;
  const actual = adapter.context;
  const mismatch = (field: string) => new Error(`body-adapter-context-mismatch:${field}`);
  if (actual.serverProfileId !== expected.serverProfileId) throw mismatch('serverProfileId');
  if ((actual.accountId ?? undefined) !== (expected.accountId ?? undefined)) throw mismatch('accountId');
  if ((actual.worldGenerationId ?? undefined) !== (expected.worldGenerationId ?? undefined)) throw mismatch('worldGenerationId');
  if (actual.dimension !== expected.dimension) throw mismatch('dimension');
}

type ResolvedProvider = {
  provider: ModelProvider;
  metadata: ProviderMetadata;
  canonical: boolean;
  /** Registry key used by ProviderSession/AgentLoop (may be a caller-defined name). */
  providerName: string;
  registry: Record<string, ModelProvider>;
  metadataByName: Record<string, ProviderMetadata>;
};

function metadataProviderName(name: string): ProviderMetadata['provider'] {
  return name === 'openai' || name === 'anthropic' || name === 'scripted' ? name : 'unknown';
}

/** Injected providers are fixture/offline dependencies; metadata must say so. */
function injectedMetadata(name: string, provider: ModelProvider, model?: string): ProviderMetadata {
  return {
    provider: metadataProviderName(name),
    configured: !(provider instanceof UnavailableProvider),
    ...(model ? { model } : {}),
    networkEnabled: false,
    transport: 'fixture',
  };
}

/**
 * The only provider gate. A configured network provider is built by createConfiguredProvider;
 * the factory never constructs a FetchTransport directly and metadata comes from that result.
 *
 * Every resolved assembly also returns a registry of all providers it could switch to. A
 * singleton configuration registers only itself (an honest boundary); an explicit injected
 * registry registers every entry.
 */
function resolveProvider(options: RuntimeFactoryOptions): ResolvedProvider {
  if (options.providers) {
    const registry: Record<string, ModelProvider> = { ...options.providers };
    // An explicitly injected single provider is also registered when its inferred key is free.
    if (options.provider) {
      const inferred = inferProviderName(options.provider);
      if (!(inferred in registry)) registry[inferred] = options.provider;
    }
    if (Object.keys(registry).length === 0) throw new Error('provider-registry-empty');
    const requested = options.modelProvider;
    if (requested && !registry[requested]) throw new Error(`provider-registry-missing:${requested}`);
    const providerName = requested ?? Object.keys(registry)[0]!;
    const metadataByName: Record<string, ProviderMetadata> = Object.fromEntries(
      Object.entries(registry).map(([name, provider]) => [name, injectedMetadata(name, provider, options.model)]),
    );
    return {
      provider: registry[providerName]!,
      metadata: { ...metadataByName[providerName]! },
      canonical: true,
      providerName,
      registry,
      metadataByName,
    };
  }
  if (options.provider) {
    // Injected providers are the scripted/fixture path. They are never treated as
    // network-enabled and keep the legacy AgentLoop.
    const providerName = options.modelProvider ?? inferProviderName(options.provider);
    const metadata = injectedMetadata(providerName, options.provider, options.model);
    return {
      provider: options.provider,
      metadata: { ...metadata },
      canonical: false,
      providerName,
      registry: { [providerName]: options.provider },
      metadataByName: { [providerName]: metadata },
    };
  }
  const requested = options.modelProvider ?? 'scripted';
  if (requested === 'scripted') {
    const metadata: ProviderMetadata = { provider: 'scripted', configured: false, ...(options.model ? { model: options.model } : {}), networkEnabled: false, transport: 'unavailable' };
    const provider = new UnavailableProvider('scripted provider not configured');
    return {
      provider,
      metadata: { ...metadata },
      canonical: false,
      providerName: 'scripted',
      registry: { scripted: provider },
      metadataByName: { scripted: metadata },
    };
  }
  const configured = createConfiguredProvider({
    provider: requested,
    allowModelNetwork: options.allowModelNetwork,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    transport: options.transport,
  });
  const metadata: ProviderMetadata = {
    provider: configured.name,
    configured: configured.configured,
    ...(options.model ? { model: options.model } : {}),
    // Truth comes from the gate, not from the raw option: an injected transport is offline
    // and a disabled gate can never report networkEnabled=true.
    networkEnabled: configured.networkEnabled,
    transport: options.transport ? 'fixture' : configured.networkEnabled ? 'network' : 'unavailable',
  };
  return {
    provider: configured.provider,
    metadata: { ...metadata },
    // The canonical ProviderSession path is the production path only for a configured provider.
    canonical: configured.configured,
    providerName: configured.name,
    registry: { [configured.name]: configured.provider },
    metadataByName: { [configured.name]: metadata },
  };
}

export function createRuntime(options: RuntimeFactoryOptions = {}): RuntimeAssembly {
  const profile = options.profile ?? 'simulated';
  if (!['simulated', 'simulated-3d', 'client-offline', 'unsupported'].includes(profile)) throw new Error(`unknown-profile:${profile}`);
  if (profile === 'unsupported') throw new Error('unsupported-profile');
  const providedBody = options.body ?? options.bridge;
  if (profile === 'client-offline') {
    if (!providedBody) throw new Error('client-offline-body-unavailable');
    assertRealBody(providedBody);
  }
  if (profile === 'simulated-3d' && providedBody && !(providedBody instanceof FakeClientBridge)) {
    // The 3D profile is an explicit simulation. It must never attach a simulated
    // fixture adapter to a real client-shaped body.
    throw new Error('simulated-3d-requires-simulated-body');
  }
  const bridge = providedBody ?? new FakeClientBridge();
  const simulatedProfile = profile === 'simulated' || profile === 'simulated-3d';
  const clock = options.clock ?? (simulatedProfile ? new ManualClock() : new SystemClock());
  const bodyAdapter = options.bodyAdapter ?? (profile === 'simulated-3d' ? createSimulatedBodyAdapter(bridge.context, clock) : undefined);
  if (bodyAdapter) {
    // A simulated/fixture adapter is never a substitute for a missing real client body.
    if (profile === 'client-offline' && bodyAdapter.source !== 'observed-server') throw new Error('client-offline-requires-real-body');
    // The explicit 3D simulation profile must not silently attach a real-body adapter.
    if (profile === 'simulated-3d' && bodyAdapter.source !== 'simulated') throw new Error('simulated-3d-requires-simulated-adapter');
    assertBodyAdapterContext(bridge, bodyAdapter);
    // Attach before the router/skills are constructed: there is only one body path.
    attachBodyAdapter(bridge, bodyAdapter);
  }
  // An injected persistent store is still one storage path and must be protected by the same
  // cross-process owner lock as a store this factory opens itself.
  const injectedDb = options.store?.db.name;
  const dbPath = options.db ?? (injectedDb && injectedDb !== ':memory:' ? injectedDb : ':memory:');
  const ownsStore = options.store === undefined;
  const ownership = dbPath !== ':memory:' ? new RuntimeOwnershipLock(dbPath, options.lockOptions) : undefined;
  // Acquire cross-process ownership before touching the shared store so a second instance fails
  // closed instead of racing migrations. Releasing is only allowed for the record we wrote.
  ownership?.acquire();
  let store: SQLiteStore;
  try {
    store = options.store ?? new SQLiteStore(dbPath);
  } catch (error) {
    ownership?.release();
    throw error;
  }
  try {
    // A fresh owner is the only process allowed on this store. Any receipt still pending was
    // written by a dead process, so settle it as unknown before commands can be replayed.
    // A failure here must fail construction (and release ownership) rather than replay accepted.
    store.recoverPendingReceipts();
    const events = options.events ?? new EventHub(1024, store, bridge.context);
    const inputsEnabled = options.inputsEnabled ?? simulatedProfile;
    const bridgeService = options.bridgeService?.service;
    // An attached bridge service owns relay/observer/helper control. Its admission gate starts
    // closed and a failure re-closes it; the runtime must enforce that state instead of only
    // reporting it. Without an attached service the runtime's own inputs setting is authoritative.
    const controlOpen = () => !bridgeService || bridgeService.status().admissionOpen;
    const arbiter = new InputArbiter(() => clock.now(), () => leaseContextEpoch(bridge.context));
    // A 3D navigation skill advances virtual time while it plans/executes bounded steps; the
    // legacy 1s default would abort legitimate routes. Progress still renews the watchdog, and
    // the controller's own maxTicks/maxWallClock budget remains the hard bound.
    const leaseTtl = options.leaseTtl ?? (bodyAdapter ? 300_000 : undefined);
    const watchdogTtl = options.watchdogTtl ?? (bodyAdapter ? 300_000 : undefined);
    const executor = new Executor(bridge, store, arbiter, { clock, inputsEnabled: () => inputsEnabled && controlOpen(), ...(leaseTtl !== undefined ? { leaseTtl } : {}), ...(watchdogTtl !== undefined ? { watchdogTtl } : {}) });
    // Recovery may only suspend executions that are not actively owned by this process.
    const session = new SessionRuntime(bridge, store, { events, maxRecoveryAttempts: options.maxRecoveryAttempts, isExecutionActive: executionId => executor.isActive(executionId) });
    const admission = new ExecutionAdmission(store, bridge, session.ownerId, () => inputsEnabled, controlOpen);
    const resolvedProvider = resolveProvider(options);
    const provider = resolvedProvider.provider;
    const memory = new MemoryService(store, [], { now: () => clock.now() });
    // The stable scope is derived from the current body context. Connection/body epochs are
    // excluded, but a dimension/account/world change must move control reads to the new scope
    // instead of leaving them pointed at the scope captured at assembly time.
    const scopeOf = () => memoryScopeOf(bridge.context);
    const memoryScope = scopeOf();
    const knowledge = new KnowledgeService({ store });
    const lifecycle = new SkillLifecycle(undefined, { now: () => clock.now() });
    const nav: RuntimeNavPort = options.nav ?? { navigate };
    const motor = options.motor;
    const router = new ToolRouter(bridge, store, session.events, executor, memory, () => clock.now(), admission, { knowledge, lifecycle, memoryScope, nav, ...(motor ? { motor } : {}) });
    const loop = new AgentLoop(provider, router, 8, {
      canonical: resolvedProvider.canonical,
      providerName: resolvedProvider.providerName,
      providers: resolvedProvider.registry,
      providerMetadata: resolvedProvider.metadata,
      providerMetadataByName: resolvedProvider.metadataByName,
    });
    const providerMetadata = resolvedProvider.metadata;
    const control = new ControlService(undefined, providerMetadata);
    const goalManager = new GoalManager(store, session.events, () => bridge.context);
    // The scheduler's wake hook really advances one decision turn through the same AgentLoop.
    const scheduler = new TaskScheduler(session.events, async (reason) => {
      if (control.pausedValue || control.stoppingValue) return;
      // Only a goal in this exact body scope may drive a turn: a goal from another
      // account/world/dimension is not this runtime's work.
      const active = store.findGoalForScope(scopeOf(), ['active']);
      if (!active) return;
      await loop.run([{ role: 'user', content: `Scheduler wake: ${reason}. Continue the active goal or report the next blocked step.` }], undefined, undefined, { goalId: active.goal_id, goalRevision: active.revision, store, owner: session.ownerId });
    }, 25);
    // Wire the scheduler to the event stream so goal/execution/effect/session events coalesce
    // into a single wake instead of a per-tick model call.
    const unsubscribeScheduler = session.events.subscribe(event => scheduler.observe(event));
    // Control loss in the bridge service (relay/observer/helper death, IPC control loss) must
    // reach the execution layer: admission closes and every active write is aborted, not just
    // reported in the service status. A later explicit armControl is required before new input.
    const unsubscribeBridgeService = bridgeService?.on?.(event => {
      const controlLost = event.type === 'control-revoked' || event.type === 'helper-exit'
        || event.type === 'relay-exit' || event.type === 'observer-failure' || event.type === 'fatal'
        || (event.type === 'ipc-overflow' && (event.controlLost === true || event.globalUnknown === true));
      if (!controlLost) return;
      try { executor.cancelAll(`bridge:${event.type}`); } catch { /* cancellation is best effort */ }
      try { lifecycle.humanControl(`bridge:${event.type}`); } catch { /* lifecycle may already be closed */ }
    });
    const dependencies: RuntimeDependencies = { clock, store, events: session.events, provider, body: bridge, nav, motor, ...(bodyAdapter ? { bodyAdapter } : {}) };
    let closed = false;
    const startBridgeService = bridgeService ? async () => { await bridgeService.start(); } : undefined;
    const assembly = {
      bridge, runtimeProfile: profile, store, session, router, provider, providerMetadata, loop, clock, control, goalManager, scheduler,
      memory, knowledge, lifecycle, ...(bodyAdapter ? { bodyAdapter } : {}),
      /** Recomputed on read so a dimension/world change closes the previous scope immediately. */
      get memoryScope() { return scopeOf(); },
      providerSession: loop.providerSession, canonicalProviderPath: loop.canonicalPath,
      ...(bridgeService ? { bridgeService, startBridgeService } : {}),
      dependencies, ownerId: session.ownerId, inputsEnabled, controlOpen, ownership,
      close() {
        if (closed) return;
        closed = true;
        unsubscribeScheduler();
        unsubscribeBridgeService?.();
        scheduler.close();
        if (bridgeService) void bridgeService.stop('runtime-close').catch(() => undefined);
        const shutdown = (bridge as { shutdown?: () => Promise<void> }).shutdown;
        if (typeof shutdown === 'function') void shutdown.call(bridge).catch(() => undefined);
        try { if (ownsStore) store.close(); } finally { ownership?.release(); }
      },
    } as RuntimeAssembly;
    control.attach(assembly);
    if (options.bridgeService?.autostart && startBridgeService) void startBridgeService().catch(() => undefined);
    return assembly;
  } catch (error) {
    // Construction failed after ownership was taken: never leak the shared store or its lock.
    ownership?.release();
    if (ownsStore) { try { store.close(); } catch { /* preserve the original failure */ } }
    throw error;
  }
}

function inferProviderName(provider: ModelProvider): 'scripted' | 'openai' | 'anthropic' {
  const name = provider.constructor?.name ?? '';
  if (name.startsWith('Anthropic')) return 'anthropic';
  if (name.startsWith('OpenAI')) return 'openai';
  return 'scripted';
}