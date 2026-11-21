export type Tone = 'ok' | 'warn' | 'bad' | 'idle';
export function toneForStatus(status?: string): Tone {
  if (['succeeded', 'terminal', 'confirmed', 'current', 'enabled'].includes(status ?? '')) return 'ok';
  if (['running', 'active', 'suspended', 'ambiguous', 'partial', 'accepted', 'pausing', 'stopping', 'stale', 'prepared', 'may-have-dispatched', 'verifying', 'recoverable-failure', 'canceling'].includes(status ?? '')) return 'warn';
  if (status === 'failed') return 'bad';
  return 'idle';
}
export const displayCount = (loaded: boolean, count: number): number | undefined => loaded ? count : undefined;
export function sessionPresentation(input: {
  available: boolean; pairingRequired: boolean; readFailed: boolean;
  closed?: boolean; stopping?: boolean; paused?: boolean; sessionState?: string; state?: string;
}): { headline: string; tone: Tone } {
  if (input.pairingRequired) return { headline: 'Pairing required', tone: 'idle' };
  if (input.readFailed) return { headline: 'Status unavailable', tone: 'idle' };
  if (!input.available) return { headline: 'Awaiting status', tone: 'idle' };
  if (input.closed) return { headline: 'Closed', tone: 'idle' };
  if (input.stopping) return { headline: 'Stopping', tone: 'warn' };
  if (input.paused) return { headline: 'Paused', tone: 'warn' };
  if (input.sessionState === 'recoverable-failure') return { headline: 'Recovery required', tone: 'warn' };
  if (input.state === 'running') return { headline: 'Running', tone: 'warn' };
  return { headline: 'Idle', tone: 'idle' };
}
