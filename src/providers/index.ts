import { OpenAIProvider, FetchTransport } from './openai/index.js';
import { AnthropicProvider } from './anthropic/index.js';
import { UnavailableProvider, type ModelProvider } from './scripted/index.js';
import type { HttpTransport } from './shared.js';

export type ConfiguredProviderName = 'openai' | 'anthropic';

export type ConfiguredProviderOptions = {
  provider: ConfiguredProviderName;
  /** Default false. Only this flag plus a key may construct a live network transport. */
  allowModelNetwork?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Test/offline injection. An injected transport never counts as enabled network access. */
  transport?: HttpTransport;
  maxTokens?: number;
};

export type ConfiguredProvider = {
  provider: ModelProvider;
  name: ConfiguredProviderName;
  configured: boolean;
  networkEnabled: boolean;
  reason?: string;
};

/**
 * Single gate from configuration to transport.
 *
 * Wiring contract for the runtime factory (owned by another stream):
 *   createConfiguredProvider({ provider: options.modelProvider, allowModelNetwork: options.allowModelNetwork,
 *     apiKey: options.apiKey, baseUrl: options.baseUrl, model: options.model, transport: options.transport })
 * must replace the direct `new FetchTransport({ allowModelNetwork: true })` construction. The factory must
 * not construct a live FetchTransport itself, and provider metadata must use `networkEnabled`/`configured`
 * from this result rather than `allowModelNetwork ?? false`.
 */
export function createConfiguredProvider(options: ConfiguredProviderOptions): ConfiguredProvider {
  const provider = options.provider;
  const injected = options.transport;
  if (!injected && !options.allowModelNetwork) return { provider: new UnavailableProvider('model-network-disabled'), name: provider, configured: false, networkEnabled: false, reason: 'model-network-disabled' };
  if (!options.apiKey && !injected) return { provider: new UnavailableProvider('model-provider-not-configured'), name: provider, configured: false, networkEnabled: false, reason: 'model-provider-not-configured' };
  const transport = injected ?? new FetchTransport({ allowModelNetwork: true });
  const baseUrl = options.baseUrl ?? (provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com/v1');
  const model = options.model ?? 'configured-model';
  const instance = provider === 'openai'
    ? new OpenAIProvider(transport, baseUrl, model, options.apiKey)
    : new AnthropicProvider(transport, baseUrl, model, options.apiKey, '2023-06-01', {}, options.maxTokens);
  return { provider: instance, name: provider, configured: true, networkEnabled: Boolean(options.allowModelNetwork && !injected) };
}
