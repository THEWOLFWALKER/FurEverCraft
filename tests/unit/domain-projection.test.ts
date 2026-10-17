import { describe, expect, it } from 'vitest';
import { projectPacket } from '../../src/bridge/protocol/domain.js';

const scope = { serverProfileId: 'simulated', dimension: 'overworld', worldGenerationId: 'world-1' };

describe('B04 packet domain projection', () => {
  it('projects a position packet with observed availability and explicit scope', () => {
    const projection = projectPacket({ name: 'position', direction: 'upstream', phase: 'PLAY', params: { x: 4, y: 2 } }, scope, 'session-1', '7');
    expect(projection).toMatchObject({ kind: 'position', availability: 'observed', source: 'fixture', scope, sequence: '7', payload: { x: 4, y: 2 } });
  });
  it('projects chat with the sender preserved', () => {
    const projection = projectPacket({ name: 'chat_message', direction: 'downstream', phase: 'PLAY', params: { message: 'hello', sender: 'steve' } }, scope, 'session-1', '8');
    expect(projection).toMatchObject({ kind: 'chat', payload: { message: 'hello', sender: 'steve' } });
  });
  it('never silently drops an unsupported packet', () => {
    const projection = projectPacket({ name: 'some_new_packet', direction: 'upstream', phase: 'PLAY', params: {} }, scope, 'session-1', '9');
    expect(projection).toMatchObject({ kind: 'unknown', availability: 'unknown', payload: { reason: 'unsupported-packet-family' } });
  });
  it('marks a malformed known packet as unknown rather than fabricating a value', () => {
    const projection = projectPacket({ name: 'position', direction: 'upstream', phase: 'PLAY', params: { x: 'nope' } }, scope, 'session-1', '10');
    expect(projection).toMatchObject({ kind: 'unknown', availability: 'unknown', payload: { reason: 'position-missing-coordinates' } });
  });
});
