import { FakeClientBridge } from '../bridge/fake/index.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import { SQLiteStore } from '../persistence/store.js';
import { SessionRuntime } from './session.js';
import { ToolRouter, AgentLoop } from '../agent/router.js';
import { Executor, InputArbiter } from './runtime.js';
import { ExecutionAdmission } from './admission.js';
import { RuntimeOwnershipLock, type OwnershipLockOptions } from './ownership.js';
import { MemoryService } from '../autonomous/memory.js';
import { UnavailableProvider, type ModelProvider } from '../providers/scripted/index.js';
import { OpenAIProvider, FetchTransport } from '../providers/openai/index.js';
import { AnthropicProvider } from '../providers/anthropic/index.js';
import type { Clock } from '../contracts/index.js';
import { ManualClock, SystemClock } from '../contracts/index.js';
import { EventHub } from '../diagnostics/events.js';
import { ControlService } from '../control/service.js';
import { GoalManager, TaskScheduler } from '../autonomous/tasks.js';
import { SessionSupervisor } from '../autonomous/session.js';
import type { ProviderMetadata } from '../control/dto.js';
import { navigate } from '../skills/navigation.js';
import type { Motor } from '../motor/primitives.js';

export type RuntimeProfile = 'simulated' | 'client-offline' | 'unsupported';
export type RuntimeNavPort = { navigate: typeof navigate };
export type RuntimeMotorPort = Pick<Motor, 'orientTo' | 'walkCorridor' | 'stepUp' | 'jumpShort' | 'controlledDrop'>;

/** The explicit dependency container every profile is assembled from. */
export type RuntimeDependencies = {
  clock: Clock;
  store: SQLiteStore;
  events: EventHub;
  provider: ModelProvider;
  body: ClientBridgeCapabilities;
  nav: RuntimeNavPort;
  motor?: RuntimeMotorPort;
};

export type RuntimeFactoryOptions = {
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
  allowModelNetwork?: boolean;
  modelProvider?: 'scripted' | 'openai' | 'anthropic';
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Whether body input may be dispatched. Defaults to on for the simulated profile only. */
  inputsEnabled?: boolean;
  /** Consecutive recovery attempts allowed before the session stays suspended. */
  maxRecoveryAttempts?: number;
  lockOptions?: OwnershipLockOptions;
};
export type RuntimeAssembly = {
  bridge: ClientBridgeCapabilities;
  store: SQLiteStore;
  session: SessionRuntime;
  router: ToolRouter;
  provider: ModelProvider;
  loop: AgentLoop;
  clock: Clock;
  control: ControlService;
  goalManager: import('../autonomous/tasks.js').GoalManager;
  scheduler: import('../autonomous/tasks.js').TaskScheduler;
  sessionSupervisor: import('../autonomous/session.js').SessionSupervisor;
  /** Explicit dependency container the runtime was assembled from. */
  dependencies: RuntimeDependencies;
  ownerId: string;
  inputsEnabled: boolean;
  ownership?: RuntimeOwnershipLock;
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

export function createRuntime(options: RuntimeFactoryOptions = {}): RuntimeAssembly {
  const profile = options.profile ?? 'simulated';
  if (profile === 'unsupported') throw new Error('unsupported-profile');
  const providedBody = options.body ?? options.bridge;
  if (profile === 'client-offline') {
    if (!providedBody) throw new Error('client-offline-body-unavailable');
    assertRealBody(providedBody);
  }
  const bridge = providedBody ?? new FakeClientBridge();
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
    const clock = options.clock ?? (profile === 'simulated' ? new ManualClock() : new SystemClock());
    const events = options.events ?? new EventHub(1024, store, bridge.context);
    const inputsEnabled = options.inputsEnabled ?? profile === 'simulated';
    const session = new SessionRuntime(bridge, store, { events, maxRecoveryAttempts: options.maxRecoveryAttempts });
    const arbiter = new InputArbiter(() => clock.now(), () => `${bridge.context.connectionEpoch}:${bridge.context.bodyEpoch}:${bridge.context.worldGenerationId}`);
    const executor = new Executor(bridge, store, arbiter, { clock, inputsEnabled: () => inputsEnabled });
    const admission = new ExecutionAdmission(store, bridge, session.ownerId, () => inputsEnabled);
    const provider = options.provider ?? createProvider(options);
    const router = new ToolRouter(bridge, store, session.events, executor, new MemoryService(store), () => clock.now(), admission);
    const loop = new AgentLoop(provider, router);
    const nav: RuntimeNavPort = options.nav ?? { navigate };
    const motor = options.motor;
    const providerName = options.modelProvider ?? inferProviderName(provider);
    const providerMetadata: ProviderMetadata = {
      provider: providerName,
      configured: !(provider instanceof UnavailableProvider),
      model: options.model,
      networkEnabled: options.allowModelNetwork ?? false,
      transport: options.provider ? 'fixture' : provider instanceof UnavailableProvider ? 'unavailable' : 'network',
    };
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
    const dependencies: RuntimeDependencies = { clock, store, events: session.events, provider, body: bridge, nav, motor };
    let closed = false;
    const assembly = {
      bridge, store, session, router, provider, loop, clock, control, goalManager, scheduler, sessionSupervisor,
      dependencies, ownerId: session.ownerId, inputsEnabled, ownership,
      close() {
        if (closed) return;
        closed = true;
        unsubscribeScheduler();
        scheduler.close();
        void sessionSupervisor.stop();
        const shutdown = (bridge as { shutdown?: () => Promise<void> }).shutdown;
        if (typeof shutdown === 'function') void shutdown.call(bridge).catch(() => undefined);
        try { if (ownsStore) store.close(); } finally { ownership?.release(); }
      },
    } as RuntimeAssembly;
    control.attach(assembly);
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

function createProvider(options: RuntimeFactoryOptions): ModelProvider {
  const provider = options.modelProvider ?? 'scripted';
  if (provider === 'scripted') return new UnavailableProvider('scripted provider not configured');
  if (!options.allowModelNetwork) return new UnavailableProvider('model-network-disabled');
  if (!options.apiKey) return new UnavailableProvider('model-provider-not-configured');
  const transport = new FetchTransport({ allowModelNetwork: true });
  const baseUrl = options.baseUrl ?? (provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1');
  const model = options.model ?? 'configured-model';
  return provider === 'openai' ? new OpenAIProvider(transport, baseUrl, model, options.apiKey) : new AnthropicProvider(transport, baseUrl, model, options.apiKey);
}