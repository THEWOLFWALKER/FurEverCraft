import { FakeClientBridge } from '../bridge/fake/index.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import { SQLiteStore } from '../persistence/store.js';
import { SessionRuntime } from './session.js';
import { ToolRouter, AgentLoop } from '../agent/router.js';
import { Executor, InputArbiter } from './runtime.js';
import { MemoryService } from '../autonomous/memory.js';
import { UnavailableProvider, type ModelProvider } from '../providers/scripted/index.js';
import { OpenAIProvider, FetchTransport } from '../providers/openai/index.js';
import { AnthropicProvider } from '../providers/anthropic/index.js';
import type { Clock } from '../contracts/index.js';
import { ManualClock, SystemClock } from '../contracts/index.js';
import { ControlService } from '../control/service.js';
import { GoalManager, TaskScheduler } from '../autonomous/tasks.js';
import { SessionSupervisor } from '../autonomous/session.js';
import type { ProviderMetadata } from '../control/dto.js';

export type RuntimeProfile = 'simulated' | 'client-offline' | 'unsupported';
export type RuntimeFactoryOptions = {
  profile?: RuntimeProfile;
  db?: string;
  clock?: Clock;
  provider?: ModelProvider;
  allowModelNetwork?: boolean;
  modelProvider?: 'scripted' | 'openai' | 'anthropic';
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  bridge?: ClientBridgeCapabilities;
};
export type RuntimeAssembly = { bridge: ClientBridgeCapabilities; store: SQLiteStore; session: SessionRuntime; router: ToolRouter; provider: ModelProvider; loop: AgentLoop; clock: Clock; control: ControlService; goalManager: import('../autonomous/tasks.js').GoalManager; scheduler: import('../autonomous/tasks.js').TaskScheduler; sessionSupervisor: import('../autonomous/session.js').SessionSupervisor; close(): void };

const activeRuntimes = new Set<string>();
export function createRuntime(options: RuntimeFactoryOptions = {}): RuntimeAssembly {
  const profile = options.profile ?? 'simulated';
  if (profile === 'unsupported') throw new Error('unsupported-profile');
  if (profile === 'client-offline' && !options.bridge) throw new Error('client-offline-bridge-unavailable');
  const bridge = options.bridge ?? new FakeClientBridge();
  const store = new SQLiteStore(options.db ?? ':memory:');
  const lockKey = options.db && options.db !== ':memory:' ? options.db : undefined;
  if (lockKey && activeRuntimes.has(lockKey)) { store.close(); throw new Error('runtime-control-owned'); }
  if (lockKey) activeRuntimes.add(lockKey);
  const clock = options.clock ?? (profile === 'simulated' ? new ManualClock() : new SystemClock());
  const session = new SessionRuntime(bridge, store);
  const arbiter = new InputArbiter(() => clock.now());
  const executor = new Executor(bridge, store, arbiter, { clock });
  const provider = options.provider ?? createProvider(options);
  const router = new ToolRouter(bridge, store, session.events, executor, new MemoryService(store), () => clock.now());
  const loop = new AgentLoop(provider, router);
  const providerName = options.modelProvider ?? 'scripted';
  const providerMetadata: ProviderMetadata = {
    provider: providerName,
    configured: !(provider instanceof UnavailableProvider),
    model: options.model,
    networkEnabled: options.allowModelNetwork ?? false,
    transport: options.provider ? 'fixture' : provider instanceof UnavailableProvider ? 'unavailable' : 'network',
  };
  const control = new ControlService(undefined as unknown as RuntimeAssembly, providerMetadata);
  const goalManager = new GoalManager(store, session.events);
  const scheduler = new TaskScheduler(session.events, async () => undefined, 25);
  const sessionSupervisor = new SessionSupervisor(session.events);
  let closed = false;
  const assembly = { bridge, store, session, router, provider, loop, clock, control, goalManager, scheduler, sessionSupervisor, close() { if (closed) return; closed = true; scheduler.close(); void sessionSupervisor.stop(); try { store.close(); } finally { if (lockKey) activeRuntimes.delete(lockKey); } } } as RuntimeAssembly;
  control.attach(assembly);
  return assembly;
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
