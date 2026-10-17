import { z } from 'zod';
import { nextId } from '../contracts/index.js';
import type { WindowsHelperDriver } from './windows/driver.js';
import type { NormalizedObservation, ProtocolSession } from './protocol/session.js';

export const ClientBridgeProfileSchema = z.object({
  profile: z.enum(['simulated', 'client-offline', 'unsupported']),
  serverProfileId: z.string().default('client-offline'),
  allowMinecraftUpstream: z.boolean().default(false),
  allowOsInput: z.boolean().default(false),
  allowScreenCapture: z.boolean().default(false),
  allowAuth: z.boolean().default(false),
  observationLimit: z.number().int().positive().max(10_000).default(256),
});
export type ClientBridgeProfile = z.input<typeof ClientBridgeProfileSchema>;
type ProtocolObserver = Pick<ProtocolSession, 'subscribe'> & { readonly sessionEpoch?: string };
type WindowState = { focused?: boolean; visible?: boolean; minimized?: boolean; [key: string]: unknown };
type CaptureResult = { data?: string; mimeType?: string; source?: string; limitation?: string; [key: string]: unknown };

export type BridgeCapabilities = {
  profile: ClientBridgeProfile['profile']; protocolObservation: boolean; protocolForwarding: boolean;
  nativeInput: boolean; windowHealth: boolean; screenCapture: boolean; authentication: boolean;
  stableNavigation: false; source: 'fixture' | 'simulated' | 'client'; limitations: string[];
};
export type AuthPrompt = 'login' | 'register' | 'reject' | 'unknown' | 'ordinary';
export type AuthDecision = 'AUTH_REQUIRED' | 'AUTH_REJECTED' | 'AUTH_AMBIGUOUS' | 'AUTH_NOT_REQUIRED';
export type CredentialHandle = { username: string; secret: string };
export type AuthExecutor = (request: { action: 'login' | 'register'; credential: CredentialHandle }) => Promise<void>;
export type CompositeClientBridgeOptions = { protocol?: ProtocolObserver; windows?: WindowsHelperDriver; profile: ClientBridgeProfile; authExecutor?: AuthExecutor; credentials?: () => CredentialHandle | undefined };

export class CompositeClientBridge {
  readonly profile: z.output<typeof ClientBridgeProfileSchema>;
  readonly capabilities: BridgeCapabilities;
  readonly identity: { readonly connectionEpoch: string };
  private readonly observations: NormalizedObservation[] = [];
  private readonly unsubscribe?: () => void;
  private bound = false;
  private sensitive = false;
  private closed = false;

  constructor(private readonly options: CompositeClientBridgeOptions) {
    this.profile = ClientBridgeProfileSchema.parse(options.profile);
    const source = this.profile.profile === 'simulated' ? 'simulated' : options.protocol ? 'client' : 'fixture';
    const limitations: string[] = [];
    if (!options.protocol) limitations.push('protocol-observer-unavailable');
    if (!this.profile.allowOsInput || !options.windows) limitations.push('native-input-disabled');
    if (!this.profile.allowScreenCapture || !options.windows) limitations.push('screen-capture-disabled');
    if (!this.profile.allowAuth || !options.authExecutor || !options.credentials) limitations.push('authentication-disabled');
    if (this.profile.profile !== 'client-offline') limitations.push('offline-profile-required-for-real-client-actions');
    this.capabilities = {
      profile: this.profile.profile, protocolObservation: Boolean(options.protocol),
      protocolForwarding: Boolean(options.protocol && this.profile.allowMinecraftUpstream),
      nativeInput: Boolean(options.windows && this.profile.allowOsInput), windowHealth: Boolean(options.windows),
      screenCapture: Boolean(options.windows && this.profile.allowScreenCapture),
      authentication: Boolean(this.profile.allowAuth && options.authExecutor && options.credentials),
      stableNavigation: false, source, limitations,
    };
    this.identity = { connectionEpoch: options.protocol?.sessionEpoch ?? nextId('connection') };
    if (options.protocol) this.unsubscribe = options.protocol.subscribe(observation => this.record(observation));
  }
  observe(): readonly NormalizedObservation[] { return this.observations.slice(); }
  drainObservations() { const result = { observations: this.observations.slice(), gap: this.observations.length >= this.profile.observationLimit }; this.observations.length = 0; return result; }
  async bindWindow(pid: number, hwnd: string) { this.requireOpen(); if (!this.options.windows || !this.capabilities.windowHealth) throw new Error('window-health-unavailable'); const result = await this.options.windows.bindWindow(pid, hwnd); this.bound = true; return result; }
  async setHeldInputs(inputs: Record<string, boolean>, generation: number, leaseUntil: number) { this.requireAction('nativeInput'); await this.assertWindowUsable(); return this.options.windows!.setHeldInputs(inputs, generation, leaseUntil); }
  async moveRelative(dx: number, dy: number, commandId: string, leaseUntil: number) { this.requireAction('nativeInput'); await this.assertWindowUsable(); return this.options.windows!.moveRelative(dx, dy, commandId, leaseUntil); }
  async click(button: string, commandId: string, leaseUntil: number) { this.requireAction('nativeInput'); await this.assertWindowUsable(); return this.options.windows!.click(button, commandId, leaseUntil); }
  async typeText(text: string, commandId: string, leaseUntil: number, sensitive = false) { this.requireAction('nativeInput'); await this.assertWindowUsable(); this.sensitive = sensitive; try { return await this.options.windows!.typeText(text, commandId, leaseUntil); } finally { this.sensitive = false; } }
  async captureWindow(): Promise<CaptureResult> { this.requireAction('screenCapture'); await this.assertWindowUsable(); if (this.sensitive) throw new Error('capture-suppressed-sensitive-period'); const result = await this.options.windows!.captureWindow() as CaptureResult; return { ...result, source: result.source ?? 'os-capture' }; }
  async authenticate(prompt: AuthPrompt): Promise<AuthDecision> {
    if (prompt === 'ordinary') return 'AUTH_NOT_REQUIRED'; if (prompt === 'reject') return 'AUTH_REJECTED';
    if (prompt !== 'login' && prompt !== 'register') return 'AUTH_AMBIGUOUS'; if (!this.capabilities.authentication) return 'AUTH_AMBIGUOUS';
    const credentials = this.options.credentials!(); if (!credentials?.username || !credentials.secret) return 'AUTH_AMBIGUOUS';
    this.sensitive = true; try { await this.options.authExecutor!({ action: prompt, credential: credentials }); return 'AUTH_REQUIRED'; } finally { this.sensitive = false; }
  }
  async heartbeat() { this.requireOpen(); if (!this.options.windows) throw new Error('window-health-unavailable'); return this.options.windows.heartbeat(); }
  async releaseOwnedInputs() { if (!this.options.windows) return undefined; return this.options.windows.releaseOwnedInputs(); }
  async shutdown() { if (this.closed) return; this.closed = true; this.unsubscribe?.(); await this.releaseOwnedInputs(); if (this.options.windows) await this.options.windows.shutdown(); }
  private record(observation: NormalizedObservation) { if (this.sensitive) return; if (this.observations.length >= this.profile.observationLimit) this.observations.shift(); this.observations.push(observation); }
  private requireOpen() { if (this.closed) throw new Error('bridge-closed'); }
  private requireAction(capability: 'nativeInput' | 'screenCapture') { this.requireOpen(); if (!this.capabilities[capability]) throw new Error(`${capability}-disabled`); }
  private async assertWindowUsable() { if (!this.bound) throw new Error('window-not-bound'); const state = await this.options.windows!.getWindowState() as WindowState; if (state.focused === false || state.visible === false || state.minimized === true) { await this.options.windows!.releaseOwnedInputs(); throw new Error('window-not-usable'); } }
}
