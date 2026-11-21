import { createTargetRegistry } from '../compat/target.js';
import type { AdapterRegistry, ResolvedBundle } from '../compat/registry.js';
import { FakeClientBridge } from '../bridge/fake/index.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import { SQLiteStore } from '../persistence/store.js';
import { SessionRuntime } from './session.js';
import { ToolRouter, AgentLoop, memoryScopeOf } from '../agent/router.js';
import { Executor, InputArbiter, leaseContextEpoch } from './runtime.js';
import { ExecutionAdmission } from './admission.js';
import { RuntimeOwnershipLock, type OwnershipLockOptions } from './ownership.js';
import { MemoryService, type MemoryScope } from '../autonomous/memory.js';
import { canonicalScopeKey, resolveStableScope, type StableScope } from '../contracts/context.js';
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
import { SessionSupervisor } from '../autonomous/session.js';
import type { ProviderMetadata } from '../control/dto.js';
import { navigate } from '../skills/navigation.js';
import type { MotorFactory } from '../motor/controller.js';

export type RuntimeProfile = 'simulated' | 'simulated-3d' | 'client-offline' | 'unsupported';
export type RuntimeNavPort = { navigate: typeof navigate };
export type RuntimeMotorPort = MotorFactory;

/** The explicit dependency container every profile is assembled from. */
export type RuntimeDependencies = {
  gameBundle: ResolvedBundle;
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
  adapterRegistry?: AdapterRegistry;
  gameBundleId?: string;
  profile?: RuntimeProfile;
  db?: string;
  clock?: Clock;
  store?: SQLiteStore;
  events?: EventHub;
  provider?: ModelProvider;
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
  shutdownGraceMs?: number;
};
export type ShutdownReport = { complete: boolean; uncertain: string[] };
export type RuntimeAssembly = {
  gameBundle: ResolvedBundle;
  bridge: ClientBridgeCapabilities;
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
  sessionSupervisor: import('../autonomous/session.js').SessionSupervisor;
  /** Durable, scoped memory (places/episodes) consumed by router and control. */
  memory: MemoryService;
  memoryScope: MemoryScope;
  /**
   * Canonical stable scope key for this runtime's control/memory reads and durable writes,
   * derived once from `bridge.context` (tolerant of a body that does not expose account
   * identity). Control reads and writes must both use this so they cannot disagree.
   */
  runtimeScopeKey: () => string;
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
  inputsEnabled: boolean;
  ownership?: RuntimeOwnershipLock;
  startBridgeService?(): Promise<void>;
  close(): Promise<ShutdownReport>;
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

type ResolvedProvider = { provider: ModelProvider; metadata: ProviderMetadata; canonical: boolean; providerName: ProviderMetadata['provider'] };

/**
 * The only provider gate. A configured network provider is built by createConfiguredProvider;
 * the factory never constructs a FetchTransport directly and metadata comes from that result.
 */
function resolveProvider(options: RuntimeFactoryOptions): ResolvedProvider {
  if (options.provider) {
    // Injected providers are the scripted/fixture path. They are never treated as
    // network-enabled and keep the legacy AgentLoop.
    const providerName = options.modelProvider ?? inferProviderName(options.provider);
    return {
      provider: options.provider,
      metadata: {
        provider: providerName,
        configured: !(options.provider instanceof UnavailableProvider),
        ...(options.model ? { model: options.model } : {}),
        networkEnabled: false,
        transport: 'fixture',
      },
      canonical: false,
      providerName,
    };
  }
  const requested = options.modelProvider ?? 'scripted';
  if (requested === 'scripted') {
    return {
      provider: new UnavailableProvider('scripted provider not configured'),
      metadata: { provider: 'scripted', configured: false, ...(options.model ? { model: options.model } : {}), networkEnabled: false, transport: 'unavailable' },
      canonical: false,
      providerName: 'scripted',
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
  return {
    provider: configured.provider,
    metadata: {
      provider: configured.name,
      configured: configured.configured,
      ...(options.model ? { model: options.model } : {}),
      // Truth comes from the gate, not from the raw option: an injected transport is offline
      // and a disabled gate can never report networkEnabled=true.
      networkEnabled: configured.networkEnabled,
      transport: options.transport ? 'fixture' : configured.networkEnabled ? 'network' : 'unavailable',
    },
    // The canonical ProviderSession path is the production path only for a configured provider.
    canonical: configured.configured,
    providerName: configured.name,
  };
}

export function createRuntime(options: RuntimeFactoryOptions = {}): RuntimeAssembly {
  const profile = options.profile ?? 'simulated';
  const gameBundle = (options.adapterRegistry ?? createTargetRegistry()).resolve(options.gameBundleId ?? 'java-26.3-candidate', { release: '26.3', protocol: 777 });
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
    let closing = false;
    const controlOpen = () => !closing && (!bridgeService || bridgeService.status().admissionOpen) && (simulatedProfile || gameBundle.assess(['protocol.decode', 'control.motion']).available);
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
    // The runtime's internal stable scope. This is the single place a local/fixture runtime that
    // does not expose account identity derives a *stable* scope: it mirrors the public
    // `resolveStableScope` rule exactly when the identity is complete, and falls back to a
    // profile-scoped sentinel only when account/world/dimension is genuinely absent. Control
    // reads, memory and receipts all derive from this one value, so a write and its later read
    // always agree instead of one side resolving where the other leaves the scope unresolved.
    const runtimeStableScope = (): StableScope => {
      const resolved = resolveStableScope(bridge.context);
      return resolved.status === 'resolved' ? resolved.scope : {
        serverProfileId: bridge.context.serverProfileId ?? 'simulated',
        accountId: bridge.context.accountId ?? 'local',
        worldGenerationId: bridge.context.worldGenerationId ?? 'local',
        dimensionId: bridge.context.dimension ?? 'overworld',
      };
    };
    const runtimeScopeKey = () => canonicalScopeKey(runtimeStableScope());
    const memoryScope = memoryScopeOf(bridge.context);
    const knowledge = new KnowledgeService({ store });
    const lifecycle = new SkillLifecycle(undefined, { now: () => clock.now() });
    const nav: RuntimeNavPort = options.nav ?? { navigate };
    const motor = options.motor;
    const router = new ToolRouter(bridge, store, session.events, executor, memory, () => clock.now(), admission, { knowledge, lifecycle, memoryScope, nav, ...(motor ? { motor } : {}) });
    const loop = new AgentLoop(provider, router, 8, { canonical: resolvedProvider.canonical, providerName: resolvedProvider.providerName });
    const providerMetadata = resolvedProvider.metadata;
    const control = new ControlService(undefined, providerMetadata);
    const goalManager = new GoalManager(store, session.events);
    // The scheduler's wake hook really advances one decision turn through the same AgentLoop.
    const scheduler = new TaskScheduler(session.events, async (reason) => {
      if (control.pausedValue || control.stoppingValue) return;
      // Use the actual active goal (and its revision) so user goals can progress; without one
      // there is nothing to drive and the wake is a no-op.
      const active = store.listGoals().find(goal => goal.status === 'active');
      if (!active) return;
      await loop.run([{ role: 'user', content: `Scheduler wake: ${reason}. Continue the active goal or report the next blocked step.` }], undefined, undefined, { goalId: active.goal_id, goalRevision: active.revision, store, owner: session.ownerId });
    }, 25);
    const sessionSupervisor = new SessionSupervisor(session.events);
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
    const dependencies: RuntimeDependencies = { gameBundle, clock, store, events: session.events, provider, body: bridge, nav, motor, ...(bodyAdapter ? { bodyAdapter } : {}) };
    let shutdownPromise: Promise<ShutdownReport> | undefined;
    const startBridgeService = bridgeService ? async () => { await bridgeService.start(); } : undefined;
    const assembly = {
      gameBundle, bridge, store, session, router, provider, providerMetadata, loop, clock, control, goalManager, scheduler, sessionSupervisor,
      memory, memoryScope, runtimeScopeKey, knowledge, lifecycle, ...(bodyAdapter ? { bodyAdapter } : {}),
      providerSession: loop.providerSession, canonicalProviderPath: loop.canonicalPath,
      ...(bridgeService ? { bridgeService, startBridgeService } : {}),
      dependencies, ownerId: session.ownerId, inputsEnabled, ownership,
      close(): Promise<ShutdownReport> {
        if (shutdownPromise) return shutdownPromise;
        let resolveShutdown!: (report: ShutdownReport) => void;
        shutdownPromise = new Promise<ShutdownReport>(resolve => { resolveShutdown = resolve; });
        const uncertain: string[] = [];
        const attempt = (name: string, fn: () => unknown) => { try { fn(); } catch { uncertain.push(name); } };
        closing = true;
        control.beginShutdown();
        unsubscribeScheduler();
        unsubscribeBridgeService?.();
        scheduler.close();
        attempt('execution-cancel-failed', () => executor.cancelAll('runtime-close'));
        attempt('lifecycle-cancel-failed', () => lifecycle.humanControl('runtime-close'));
        attempt('provider-cancel-failed', () => provider.cancel());
        const shutdown = (bridge as { shutdown?: () => Promise<void> }).shutdown;
        const finalize = (): ShutdownReport => {
          try {
            if (ownsStore) store.close();
            const released = ownership?.release();
            return released === false ? { complete: false, uncertain: ['ownership-release-failed'] } : { complete: true, uncertain: [] };
          } catch { return { complete: false, uncertain: ['storage-close-failed'] }; }
        };
        // Fixture-only runtimes have no asynchronous body resources; keep their cleanup
        // synchronous for older callers while returning the same awaitable contract.
        if (!bridgeService && !shutdown && executor.idle && !uncertain.length) {
          void sessionSupervisor.stop();
          resolveShutdown(finalize());
          return shutdownPromise;
        }
        void (async (): Promise<ShutdownReport> => {
          const cleanup = async (name: string, fn: () => unknown) => {
            try { await fn(); } catch { uncertain.push(name); }
          };
          const work = Promise.all([
            cleanup('execution-settlement-failed', () => executor.whenIdle()),
            cleanup('session-stop-failed', () => sessionSupervisor.stop()),
            cleanup('bridge-stop-failed', () => bridgeService?.stop('runtime-close')),
            cleanup('body-shutdown-failed', () => shutdown?.call(bridge)),
          ]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), options.shutdownGraceMs ?? 3_000); });
          const completed = await Promise.race([work.then(() => true), deadline]);
          if (timer) clearTimeout(timer);
          if (!completed) uncertain.push('shutdown-deadline-exceeded');
          const bridgeShutdown = bridgeService?.status().shutdown;
          if (bridgeShutdown?.forced) uncertain.push('bridge-forced-shutdown-unverified');
          if (bridgeShutdown?.releaseUncertain) uncertain.push('bridge-release-unverified');
          if (bridgeShutdown?.errors.length) uncertain.push(...bridgeShutdown.errors);
          // Unknown cleanup retains DB ownership; another owner must not race old finalizers.
          if (uncertain.length) return { complete: false, uncertain };
          return finalize();
        })().then(resolveShutdown, () => resolveShutdown({ complete: false, uncertain: [...uncertain, 'unexpected-shutdown-failure'] }));
        return shutdownPromise;

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