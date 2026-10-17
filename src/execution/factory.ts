import { FakeClientBridge } from '../bridge/fake/index.js';
import type { ClientBridgeCapabilities } from '../bridge/capabilities.js';
import { SQLiteStore } from '../persistence/store.js';
import { SessionRuntime } from './session.js';
import { ToolRouter, AgentLoop } from '../agent/router.js';
import { UnavailableProvider, type ModelProvider } from '../providers/scripted/index.js';
import { OpenAIProvider, FetchTransport } from '../providers/openai/index.js';
import { AnthropicProvider } from '../providers/anthropic/index.js';
import type { Clock } from '../contracts/index.js';
import { ManualClock } from '../contracts/index.js';

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
};
export type RuntimeAssembly = { bridge: ClientBridgeCapabilities; store: SQLiteStore; session: SessionRuntime; router: ToolRouter; provider: ModelProvider; loop: AgentLoop; clock: Clock; close(): void };

export function createRuntime(options: RuntimeFactoryOptions = {}): RuntimeAssembly {
  const profile = options.profile ?? 'simulated';
  if (profile === 'unsupported') throw new Error('unsupported-profile');
  const bridge = new FakeClientBridge();
  const store = new SQLiteStore(options.db ?? ':memory:');
  const clock = options.clock ?? new ManualClock();
  const session = new SessionRuntime(bridge, store);
  const router = new ToolRouter(bridge, store, session.events);
  const provider = options.provider ?? createProvider(options);
  const loop = new AgentLoop(provider, router);
  return { bridge, store, session, router, provider, loop, clock, close: () => store.close() };
}

function createProvider(options: RuntimeFactoryOptions): ModelProvider {
  const provider = options.modelProvider ?? 'scripted';
  if (provider === 'scripted') return new UnavailableProvider('scripted provider not configured');
  if (!options.allowModelNetwork) return new UnavailableProvider('model-network-disabled');
  const transport = new FetchTransport({ allowModelNetwork: true });
  const baseUrl = options.baseUrl ?? (provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1');
  const model = options.model ?? 'configured-model';
  return provider === 'openai' ? new OpenAIProvider(transport, baseUrl, model, options.apiKey) : new AnthropicProvider(transport, baseUrl, model, options.apiKey);
}
