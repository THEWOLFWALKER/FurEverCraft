export type ControlReadiness = { ready: boolean; reasons: readonly string[] };
export type ControlDecision = { allowed: boolean; generation: number; reasons: string[] };

/** One latch plus current evidence. Calling arm is a request to evaluate, never an override. */
export class ControlAuthority {
  private armed = false;
  private generationValue = 0;
  private reason = 'not-armed';
  constructor(private readonly readiness: () => ControlReadiness) {}
  get generation(): number { return this.generationValue; }
  revoke(reason: string): void {
    this.armed = false; this.reason = reason; this.generationValue += 1;
  }
  arm(): ControlDecision {
    const readiness = this.evaluate();
    if (!readiness.ready) { this.revoke('preconditions-not-ready'); return this.decision(); }
    this.armed = true; this.reason = ''; this.generationValue += 1;
    return this.decision();
  }
  decision(expectedGeneration?: number): ControlDecision {
    const readiness = this.evaluate();
    if (!readiness.ready && this.armed) this.revoke('preconditions-lost');
    const reasons = new Set(readiness.reasons);
    if (!readiness.ready && !reasons.size) reasons.add('preconditions-not-ready');
    if (!this.armed) reasons.add(this.reason || 'not-armed');
    if (expectedGeneration !== undefined && expectedGeneration !== this.generationValue) reasons.add('control-generation-changed');
    return { allowed: this.armed && readiness.ready && reasons.size === 0, generation: this.generationValue, reasons: [...reasons].sort() };
  }
  private evaluate(): ControlReadiness {
    try {
      const value = this.readiness();
      if (!value || typeof value.ready !== 'boolean' || !Array.isArray(value.reasons) || value.reasons.some(reason => typeof reason !== 'string')) return { ready: false, reasons: ['invalid-control-evidence'] };
      return { ready: value.ready && value.reasons.length === 0, reasons: value.reasons };
    } catch { return { ready: false, reasons: ['control-evidence-unavailable'] }; }
  }
}
