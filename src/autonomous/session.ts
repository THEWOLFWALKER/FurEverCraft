import type { BodyContext } from '../contracts/index.js';
import type { EventHub } from '../diagnostics/events.js';

export type SupervisorState = 'offline' | 'connecting' | 'observing' | 'ready' | 'disconnected' | 'reconnecting' | 'recovering' | 'suspended';
export type AuthTemplate = { id: string; promptPattern: RegExp; response: 'username' | 'secretRef' | 'approve'; allowed: boolean };
export type SecretRef = { ref: string; configured: boolean };
export class AuthCoordinator {
  constructor(private readonly templates: readonly AuthTemplate[] = []) {}
  match(prompt: string) { return this.templates.find(template => template.allowed && template.promptPattern.test(prompt)); }
  authorize(prompt: string, secretRef?: SecretRef) { const template = this.match(prompt); if (!template) return { status: 'waiting-configuration' as const, reason: 'no-allowlisted-template' }; if (template.response === 'secretRef' && (!secretRef?.configured || !secretRef.ref)) return { status: 'waiting-configuration' as const, reason: 'secret-ref-not-configured' }; return { status: 'ready' as const, templateId: template.id, secretRef: template.response === 'secretRef' ? secretRef?.ref : undefined }; }
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
