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
  stableNavigation: false; source: 'fixture' | 'simulated' | 'client'; limitations: string[];
};
/**
 * FEC-21: authentication is only driven by an explicit, classified AuthChallenge.  A plain
 * chat message can never be promoted to a credential prompt by a keyword/label alone.
 */
export const AUTH_CHALLENGE_SOURCES = [
  'server-login-request',
  'server-register-request',
  'operator',
  'server-chat',
  'player-chat',
  'unknown',
] as const;
export type AuthChallengeSource = typeof AUTH_CHALLENGE_SOURCES[number];
export type AuthChallenge = {
  kind: 'login' | 'register';
  sessionEpoch: string;
  connectionEpoch: string;
  source: AuthChallengeSource;
  serverChannel: string;
  targetServerId: string;
  receivedAt: number;
  evidenceRef: string;
  challengeId?: string;
};
export type AuthDecision = 'AUTH_REQUIRED' | 'AUTH_REJECTED' | 'AUTH_AMBIGUOUS' | 'AUTH_NOT_REQUIRED';
export type CredentialHandle = { username: string; secret: string };
export type AuthExecutor = (request: { action: 'login' | 'register'; credential: CredentialHandle }) => Promise<void>;
export type AuthPolicy = {
  /** Expected destination server. Defaults to profile.serverProfileId. */
  targetServerId?: string;
  /** Maximum accepted age of the challenge. Default 5 minutes. */
  maxAgeMs?: number;
  /** Allowed clock skew for receivedAt in the future. Default 1 second. */
  clockSkewMs?: number;
  /** Sources that may drive authentication. Defaults to explicit server/operator prompts. */
  trustedSources?: readonly AuthChallengeSource[];
};
export type CompositeClientBridgeOptions = {
  protocol?: ProtocolObserver;
  windows?: WindowsHelperDriver;
  profile: ClientBridgeProfile;
  authExecutor?: AuthExecutor;
  credentials?: () => CredentialHandle | undefined;
  authPolicy?: AuthPolicy;
  now?: () => number;
};
const DEFAULT_TRUSTED_AUTH_SOURCES: readonly AuthChallengeSource[] = ['server-login-request', 'server-register-request', 'operator'];
const AUTH_SOURCES_BY_KIND: Record<AuthChallenge['kind'], readonly AuthChallengeSource[]> = {
  login: ['server-login-request', 'operator'],
  register: ['server-register-request', 'operator'],
};

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
  private readonly now: () => number;
  private readonly authPolicy: Required<AuthPolicy>;

  constructor(private readonly options: CompositeClientBridgeOptions) {
    this.profile = ClientBridgeProfileSchema.parse(options.profile);
    this.now = options.now ?? (() => Date.now());
    this.authPolicy = {
      targetServerId: options.authPolicy?.targetServerId ?? this.profile.serverProfileId,
      maxAgeMs: options.authPolicy?.maxAgeMs ?? 300_000,
      clockSkewMs: options.authPolicy?.clockSkewMs ?? 1_000,
      trustedSources: options.authPolicy?.trustedSources ?? DEFAULT_TRUSTED_AUTH_SOURCES,
    };
    const source = this.profile.profile === 'simulated' ? 'simulated' : options.protocol?.source ?? 'fixture';
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
  async bindWindow(pid: number, hwnd: string) { this.requireOpen(); if (!this.options.windows || !this.capabilities.windowHealth) throw new Error('window-health-unavailable'); const result = await this.options.windows.bindWindow(pid, hwnd, this.identity.connectionEpoch); this.bound = true; return result; }
  async setHeldInputs(inputs: Record<string, boolean>, generation: number, leaseUntil: number) { this.requireAction('nativeInput'); await this.assertWindowUsable(); return this.options.windows!.setHeldInputs(inputs, generation, leaseUntil); }
  async moveRelative(dx: number, dy: number, commandId: string, leaseUntil: number) { this.requireAction('nativeInput'); await this.assertWindowUsable(); return this.options.windows!.moveRelative(dx, dy, commandId, leaseUntil); }
  async click(button: string, commandId: string, leaseUntil: number) { this.requireAction('nativeInput'); await this.assertWindowUsable(); return this.options.windows!.click(button, commandId, leaseUntil); }
  async typeText(text: string, commandId: string, leaseUntil: number, sensitive = false) { this.requireAction('nativeInput'); await this.assertWindowUsable(); this.sensitive = sensitive; try { return await this.options.windows!.typeText(text, commandId, leaseUntil); } finally { this.sensitive = false; } }
  async captureWindow(): Promise<CaptureResult> { this.requireAction('screenCapture'); await this.assertWindowUsable(); if (this.sensitive) throw new Error('capture-suppressed-sensitive-period'); const result = await this.options.windows!.captureWindow() as CaptureResult; return { ...result, source: result.source ?? 'os-capture' }; }
  /**
   * FEC-21: only a fully classified AuthChallenge can reach the credential executor.
   * Ordinary chat (including server chat and player chat) is never accepted here, and any
   * proof/epoch/target/freshness/evidence failure returns AUTH_AMBIGUOUS *without* calling
   * the executor.
   */
  async authenticate(challenge: AuthChallenge): Promise<AuthDecision> {
    if (!this.capabilities.authentication) return 'AUTH_AMBIGUOUS';
    if (!this.validAuthChallenge(challenge)) return 'AUTH_AMBIGUOUS';
    const credentials = this.options.credentials!();
    if (!credentials?.username || !credentials.secret) return 'AUTH_AMBIGUOUS';
    this.sensitive = true;
    try {
      await this.options.authExecutor!({ action: challenge.kind, credential: credentials });
      return 'AUTH_REQUIRED';
    } finally {
      this.sensitive = false;
    }
  }

  /**
   * Validates proof source, epochs, destination and freshness. Evidence must be an
   * explicit, bounded reference; a missing/unknown reference stays ambiguous.
   */
  private validAuthChallenge(challenge: unknown): challenge is AuthChallenge {
    if (!challenge || typeof challenge !== 'object') return false;
    const candidate = challenge as Partial<AuthChallenge>;
    if (candidate.kind !== 'login' && candidate.kind !== 'register') return false;
    if (typeof candidate.sessionEpoch !== 'string' || candidate.sessionEpoch !== this.identity.connectionEpoch) return false;
    if (typeof candidate.connectionEpoch !== 'string' || candidate.connectionEpoch !== this.identity.connectionEpoch) return false;
    if (typeof candidate.source !== 'string' || !(AUTH_CHALLENGE_SOURCES as readonly string[]).includes(candidate.source)) return false;
    const source = candidate.source as AuthChallengeSource;
    if (!this.authPolicy.trustedSources.includes(source)) return false;
    // A source that is trusted for one kind is not automatically trusted for the other,
    // and pure chat/unknown sources can never drive login or registration.
    if (!AUTH_SOURCES_BY_KIND[candidate.kind].includes(source)) return false;
    if (typeof candidate.targetServerId !== 'string' || candidate.targetServerId !== this.authPolicy.targetServerId) return false;
    if (typeof candidate.serverChannel !== 'string' || !candidate.serverChannel || candidate.serverChannel.length > 128 || /[\u0000-\u001f\u007f]/.test(candidate.serverChannel)) return false;
    if (typeof candidate.evidenceRef !== 'string' || !candidate.evidenceRef || candidate.evidenceRef.length > 512 || /[\u0000-\u001f\u007f]/.test(candidate.evidenceRef)) return false;
    if (candidate.challengeId !== undefined && (typeof candidate.challengeId !== 'string' || candidate.challengeId.length > 256 || /[\u0000-\u001f\u007f]/.test(candidate.challengeId))) return false;
    if (typeof candidate.receivedAt !== 'number' || !Number.isFinite(candidate.receivedAt)) return false;
    const now = this.now();
    if (candidate.receivedAt > now + this.authPolicy.clockSkewMs) return false;
    if (now - candidate.receivedAt > this.authPolicy.maxAgeMs) return false;
    return true;
  }
  async heartbeat() { this.requireOpen(); if (!this.options.windows) throw new Error('window-health-unavailable'); return this.options.windows.heartbeat(); }
  async releaseOwnedInputs() { if (!this.options.windows) return undefined; return this.options.windows.releaseOwnedInputs(); }
  async shutdown() { if (this.closed) return; this.closed = true; this.unsubscribe?.(); try { await this.releaseOwnedInputs(); } finally { if (this.options.windows) await this.options.windows.shutdown(); } }
  private record(observation: NormalizedObservation) { if (this.sensitive) return; if (observation.kind === 'observation_gap' || observation.availability !== 'available') { this.degraded = true; if (!this.capabilities.limitations.includes('observation-gap')) this.capabilities.limitations.push('observation-gap'); } if (this.observations.length >= this.profile.observationLimit) this.observations.shift(); this.observations.push(observation); }
  private requireOpen() { if (this.closed) throw new Error('bridge-closed'); }
  private requireAction(capability: 'nativeInput' | 'screenCapture') { this.requireOpen(); if (!this.capabilities[capability]) throw new Error(`${capability}-disabled`); }
  private async assertWindowUsable() { if (!this.bound) throw new Error('window-not-bound'); const state = await this.options.windows!.getWindowState() as WindowState; if (state.focused === false || state.visible === false || state.minimized === true) { await this.options.windows!.releaseOwnedInputs(); throw new Error('window-not-usable'); } }
}
