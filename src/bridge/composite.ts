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
type ProtocolObserver = Pick<ProtocolSession, 'subscribe'> & { readonly sessionEpoch?: string; readonly source?: 'fixture' | 'client' };
type WindowState = { focused?: boolean; visible?: boolean; minimized?: boolean; [key: string]: unknown };
type CaptureResult = { data?: string; mimeType?: string; source?: string; limitation?: string; [key: string]: unknown };

export type BridgeCapabilities = {
  profile: ClientBridgeProfile['profile']; protocolObservation: boolean; protocolForwarding: boolean;
  nativeInput: boolean; windowHealth: boolean; screenCapture: boolean; authentication: boolean;
  /** True when the attached helper is synthetic (dry-run); such actions are never advertised as real. */
  dryRun: boolean;
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
  private degraded = false;
  private closed = false;

  constructor(private readonly options: CompositeClientBridgeOptions) {
    this.profile = ClientBridgeProfileSchema.parse(options.profile);
    // The composite only performs real client actions under the explicit client profile.
    // A simulated/unsupported profile may still carry fixture observations, but never gains
    // native input, capture, forwarding or authentication capability from a boolean gate.
    if (this.profile.profile === 'unsupported') throw new Error('unsupported-profile');
    const clientProfile = this.profile.profile === 'client-offline';
    const source = this.profile.profile === 'simulated' ? 'simulated' : options.protocol?.source ?? 'fixture';
    // A driver's booleans alone are not capability: the driver has independent OS-input and
    // screen-capture gates, and a dry-run helper executes synthetically. Derive the advertised
    // capabilities from its effective state so the report cannot promise an action the driver
    // would reject (or mislabel a synthetic action as real).
    const helper = options.windows?.effectiveState();
    const helperEnabled = helper?.enabled === true;
    const helperDryRun = helper?.dryRun === true;
    const helperReal = Boolean(helperEnabled && !helperDryRun);
    const nativeInput = Boolean(clientProfile && options.windows && this.profile.allowOsInput && helperReal);
    const screenCapture = Boolean(clientProfile && options.windows && this.profile.allowScreenCapture && helperReal && helper?.captureEnabled === true);
    const windowHealth = Boolean(clientProfile && options.windows && helperReal);
    const limitations: string[] = [];
    const addLimit = (limitation: string) => { if (!limitations.includes(limitation)) limitations.push(limitation); };
    if (!options.protocol) addLimit('protocol-observer-unavailable');
    if (!clientProfile) addLimit('offline-profile-required-for-real-client-actions');
    if (!clientProfile || !this.profile.allowOsInput || !options.windows) addLimit('native-input-disabled');
    if (!clientProfile || !this.profile.allowScreenCapture || !options.windows) addLimit('screen-capture-disabled');
    if (!clientProfile || !this.profile.allowAuth || !options.authExecutor || !options.credentials) addLimit('authentication-disabled');
    if (options.windows && !helperEnabled) {
      addLimit('windows-helper-disabled');
      addLimit('window-health-disabled');
      if (clientProfile && this.profile.allowOsInput) addLimit('native-input-disabled');
      if (clientProfile && this.profile.allowScreenCapture) addLimit('screen-capture-disabled');
    } else if (options.windows && helperDryRun) {
      // The helper is in dry-run: it accepts commands, but only synthetically.
      addLimit('windows-helper-dry-run');
      addLimit('window-health-synthetic');
      if (clientProfile && this.profile.allowOsInput) addLimit('native-input-synthetic');
      if (clientProfile && this.profile.allowScreenCapture) addLimit('screen-capture-synthetic');
    } else if (options.windows && helperEnabled && clientProfile && this.profile.allowScreenCapture && helper?.captureEnabled !== true) {
      addLimit('screen-capture-disabled');
    }
    if (!options.windows) addLimit('window-health-disabled');
    // Window health is an OS action surface too: a non-client profile never gains it.
    if (!windowHealth && !helperDryRun) addLimit('window-health-disabled');
    this.capabilities = {
      profile: this.profile.profile, protocolObservation: Boolean(options.protocol),
      protocolForwarding: Boolean(clientProfile && options.protocol && this.profile.allowMinecraftUpstream),
      nativeInput, windowHealth,
      screenCapture,
      authentication: Boolean(clientProfile && this.profile.allowAuth && options.authExecutor && options.credentials),
      dryRun: Boolean(options.windows && helperDryRun),
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
  async shutdown() { if (this.closed) return; this.closed = true; this.unsubscribe?.(); try { await this.releaseOwnedInputs(); } finally { if (this.options.windows) await this.options.windows.shutdown(); } }
  private record(observation: NormalizedObservation) { if (this.sensitive) return; if (observation.kind === 'observation_gap' || observation.availability !== 'available') { this.degraded = true; if (!this.capabilities.limitations.includes('observation-gap')) this.capabilities.limitations.push('observation-gap'); } if (this.observations.length >= this.profile.observationLimit) this.observations.shift(); this.observations.push(observation); }
  private requireOpen() { if (this.closed) throw new Error('bridge-closed'); }
  private requireAction(capability: 'nativeInput' | 'screenCapture') { this.requireOpen(); if (!this.capabilities[capability]) throw new Error(`${capability}-disabled`); }
  private async assertWindowUsable() { if (!this.bound) throw new Error('window-not-bound'); const state = await this.options.windows!.getWindowState() as WindowState; if (state.focused === false || state.visible === false || state.minimized === true) { await this.options.windows!.releaseOwnedInputs(); throw new Error('window-not-usable'); } }
}
