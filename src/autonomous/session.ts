import type { BodyContext } from '../contracts/index.js';
import type { EventHub } from '../diagnostics/events.js';
import { nextId } from '../contracts/index.js';

export type SupervisorState = 'offline' | 'connecting' | 'observing' | 'ready' | 'disconnected' | 'reconnecting' | 'recovering' | 'suspended';
export type AuthTemplate = { id: string; promptPattern: RegExp; response: 'username' | 'secretRef' | 'approve'; allowed: boolean };
export type SecretRef = { ref: string; configured: boolean };
export type AuthDecision =
  | { status: 'waiting-observation'; reason: string; attempts: number }
  | { status: 'waiting-configuration'; reason: string; attempts: number }
  | { status: 'blocked'; reason: string; attempts: number }
  | { status: 'ready'; templateId: string; secretRef?: string; observationId: string; observedAt: number; attempts: number };
export type AuthCommand = { templateId: string; response: AuthTemplate['response']; secretRef?: string; observationId: string };
export type AuthPolicy = { maxAttempts?: number; requireObservedPrompt?: boolean; now?: () => number };

/**
 * Bounded authentication flow. A command is only produced for an explicit, allow-listed
 * observation, at most once per observation, and within a finite attempt budget. The prompt
 * text and secret value are never returned; only the configured secret reference is surfaced.
 */
export class AuthCoordinator {
  private attempts = 0;
  private blockedReason?: string;
  private last?: { decision: AuthDecision; template?: AuthTemplate; commandEmitted: boolean };
  private readonly maxAttempts: number;
  private readonly requireObservedPrompt: boolean;
  private readonly now: () => number;
  constructor(private readonly templates: readonly AuthTemplate[] = [], policy: AuthPolicy = {}) {
    this.maxAttempts = Math.max(1, policy.maxAttempts ?? 3);
    this.requireObservedPrompt = policy.requireObservedPrompt ?? true;
    this.now = policy.now ?? (() => Date.now());
  }
  get attemptCount() { return this.attempts; }
  get blocked() { return this.blockedReason !== undefined; }
  match(prompt: string) { return this.templates.find(template => template.allowed && template.promptPattern.test(prompt)); }
  observe(prompt: string, secretRef?: SecretRef): AuthDecision {
    if (this.blockedReason) return { status: 'blocked', reason: this.blockedReason, attempts: this.attempts };
    if (this.requireObservedPrompt && (typeof prompt !== 'string' || prompt.trim().length === 0)) return { status: 'waiting-observation', reason: 'no-observed-prompt', attempts: this.attempts };
    const template = this.match(prompt);
    const observationId = nextId('authobs');
    if (!template) {
      this.attempts++;
      const decision: AuthDecision = { status: 'waiting-configuration', reason: 'no-allowlisted-template', attempts: this.attempts };
      return this.exhaustOr(decision);
    }
    if (template.response === 'secretRef' && (!secretRef?.configured || !secretRef.ref)) {
      this.attempts++;
      const decision: AuthDecision = { status: 'waiting-configuration', reason: 'secret-ref-not-configured', attempts: this.attempts };
      return this.exhaustOr(decision);
    }
    this.attempts++;
    const decision: AuthDecision = { status: 'ready', templateId: template.id, ...(template.response === 'secretRef' ? { secretRef: secretRef!.ref } : {}), observationId, observedAt: this.now(), attempts: this.attempts };
    this.last = { decision, template, commandEmitted: false };
    return decision;
  }
  /** Historical name kept for callers; authorization is the same bounded observation flow. */
  authorize(prompt: string, secretRef?: SecretRef): AuthDecision { return this.observe(prompt, secretRef); }
  /**
   * Returns at most one command for the latest ready observation. Without a fresh observed
   * prompt there is no command, and a consumed observation cannot be replayed.
   */
  nextCommand(): AuthCommand | undefined {
    if (!this.last || this.last.commandEmitted || this.last.decision.status !== 'ready') return undefined;
    this.last.commandEmitted = true;
    return {
      templateId: this.last.decision.templateId,
      response: this.last.template!.response,
      ...(this.last.decision.secretRef ? { secretRef: this.last.decision.secretRef } : {}),
      observationId: this.last.decision.observationId,
    };
  }
  close(reason = 'auth-closed') { this.blockedReason = reason; this.last = undefined; }
  private exhaustOr(decision: AuthDecision): AuthDecision {
    if (this.attempts >= this.maxAttempts) {
      this.blockedReason = 'attempt-budget-exhausted';
      return { status: 'blocked', reason: this.blockedReason, attempts: this.attempts };
    }
    return decision;
  }
}
export interface ClientLifecycleAdapter { connect(): Promise<void>; disconnect(): Promise<void>; observe(): Promise<{ context: BodyContext }>; }
export class SessionSupervisor {
  state: SupervisorState = 'offline'; private recoveryOwner?: string; private attempts = 0;
  constructor(private readonly events: EventHub, private readonly adapter?: ClientLifecycleAdapter, private readonly maxAttempts = 8) {}
  async start() { if (this.state === 'ready' || this.state === 'connecting') return; this.state = 'connecting'; this.events.publish('session.connecting', {}); try { await this.adapter?.connect(); const observation = await this.adapter?.observe(); this.state = observation ? 'ready' : 'observing'; this.attempts = 0; this.events.publish('session.ready', { fixture: !this.adapter }); } catch (error) { this.state = 'disconnected'; this.events.publish('session.failed', { reason: error instanceof Error ? error.message : String(error) }, true); throw error; } }
  async recover() { if (this.recoveryOwner) return false; if (this.attempts >= this.maxAttempts) { this.state = 'suspended'; return false; } this.recoveryOwner = `recovery-${Date.now()}`; this.attempts++; this.state = 'recovering'; try { await this.start(); return true; } finally { this.recoveryOwner = undefined; } }
  async stop() { this.state = 'offline'; await this.adapter?.disconnect(); this.events.publish('session.stopped', {}); }
  get retryCount() { return this.attempts; }
}
