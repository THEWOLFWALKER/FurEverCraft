import { describe, expect, it } from 'vitest';
import { displayCount, sessionPresentation, toneForStatus } from '../../web/src/presentation.js';

describe('control surface truthful presentation', () => {
  it('distinguishes a loaded empty result from no data', () => {
    expect(displayCount(false, 0)).toBeUndefined();
    expect(displayCount(true, 0)).toBe(0);
  });
  it('does not present initial, unauthenticated or failed reads as a healthy runtime', () => {
    expect(sessionPresentation({ available: false, pairingRequired: false, readFailed: false }).headline).toBe('Awaiting status');
    expect(sessionPresentation({ available: true, pairingRequired: true, readFailed: false, state: 'running' }).headline).toBe('Pairing required');
    expect(sessionPresentation({ available: true, pairingRequired: false, readFailed: true, state: 'running' })).toEqual({ headline: 'Status unavailable', tone: 'idle' });
  });
  it('separates progress, disabled, uncertain and failed state colors', () => {
    expect(toneForStatus('running')).toBe('warn');
    expect(toneForStatus('confirmed')).toBe('ok');
    expect(toneForStatus('disabled')).toBe('idle');
    expect(toneForStatus('unknown')).toBe('idle');
    expect(toneForStatus('ambiguous')).toBe('warn');
    expect(toneForStatus('failed')).toBe('bad');
  });
});
