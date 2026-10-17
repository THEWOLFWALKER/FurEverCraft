import { describe, expect, it } from 'vitest';
import {
  LoopbackFixtureTransport,
  LoopbackByteTransport,
  MinecraftBytePacketTransport,
  createLoopbackBytePair,
  OfflineProtocolBridge,
  ProtocolSession,
  PROTOCOL_VERSION,
  MINECRAFT_VERSION,
  minecraftDataSummary,
} from '../../src/bridge/protocol/session.js';

describe('offline protocol bridge fixture', () => {
  it('locks the fixture to Minecraft 1.20.4 protocol 765 and models all stages', () => {
    expect(minecraftDataSummary()).toEqual({
      version: MINECRAFT_VERSION,
      protocol: PROTOCOL_VERSION,
      phases: ['HANDSHAKE', 'STATUS', 'LOGIN', 'CONFIGURATION', 'PLAY', 'CLOSED'],
    });
  });

  it('validates the explicit lifecycle and forwards each direction once', async () => {
    const downstream = new LoopbackFixtureTransport('downstream');
    const upstream = new LoopbackFixtureTransport('upstream');
    const bridge = new OfflineProtocolBridge(downstream, upstream, true);
    await bridge.start();
    bridge.transition('LOGIN');
    const login = await bridge.forward({ name: 'login_start', direction: 'downstream', phase: 'LOGIN', params: { name: 'fixture-player' } });
    expect(upstream.packets).toHaveLength(1);
    expect(login.direction).toBe('downstream');
    bridge.transition('CONFIGURATION');
    await bridge.forward({ name: 'finish_configuration', direction: 'upstream', phase: 'CONFIGURATION', params: {} });
    expect(downstream.packets).toHaveLength(1);
    bridge.transition('PLAY');
    await bridge.forward({ name: 'chat_message', direction: 'downstream', phase: 'PLAY', params: { message: 'hello' } });
    expect(upstream.packets).toHaveLength(2);
    await bridge.close();
    expect(downstream.closed).toBe(true);
    expect(upstream.closed).toBe(true);
  });

  it('denies upstream traffic unless explicitly enabled', async () => {
    const bridge = new OfflineProtocolBridge(new LoopbackFixtureTransport('downstream'), new LoopbackFixtureTransport('upstream'));
    await expect(bridge.start()).rejects.toThrow('minecraft-upstream-disabled');
  });

  it('rejects wrong phase and unknown packet names', async () => {
    const bridge = new OfflineProtocolBridge(new LoopbackFixtureTransport('downstream'), new LoopbackFixtureTransport('upstream'), true);
    await bridge.start();
    await expect(bridge.forward({ name: 'chat', direction: 'downstream', phase: 'PLAY', params: {} })).rejects.toThrow('packet-phase-mismatch');
    await expect(bridge.forward({ name: 'not_a_packet', direction: 'downstream', phase: 'HANDSHAKE', params: {} })).rejects.toThrow('unknown-packet');
  });

  it('decodes a real minecraft-protocol packet through fragmented loopback bytes', async () => {
    const pair = createLoopbackBytePair([1, 1, 2, 3]);
    const session = new ProtocolSession('byte-session');
    const decoder = new MinecraftBytePacketTransport('left', pair.left, 'downstream', () => 'HANDSHAKE');
    const encoder = new MinecraftBytePacketTransport('right', pair.right, 'downstream', () => 'HANDSHAKE');
    const decoded: unknown[] = [];
    decoder.onPacket(packet => decoded.push(packet));
    await encoder.send({ name: 'set_protocol', direction: 'downstream', phase: 'HANDSHAKE', params: { protocolVersion: PROTOCOL_VERSION, serverHost: 'localhost', serverPort: 25565, nextState: 2 } });
    await new Promise(resolve => setImmediate(resolve));
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({ name: 'set_protocol', direction: 'downstream', phase: 'HANDSHAKE' });
    const observation = session.observe('packet:set_protocol', 'downstream', decoded[0]);
    expect(observation.source).toBe('fixture');
    expect(observation.payload).toMatchObject({ name: 'set_protocol' });
    await decoder.close();
    await encoder.close();
  });

  it('emits normalized epochs and an explicit gap on observation overflow', () => {
    const session = new ProtocolSession('session_fixture', 'body_fixture', 2);
    const first = session.observe('position', 'upstream', { x: 1 });
    expect(first).toMatchObject({ source: 'fixture', sessionEpoch: 'session_fixture', bodyEpoch: 'body_fixture', sequence: '1' });
    session.observe('position', 'upstream', { x: 2 });
    const gap = session.observe('position', 'upstream', { x: 3 });
    expect(gap).toMatchObject({ kind: 'observation_gap', availability: 'degraded', gap: { from: '1', to: '3' } });
    expect(session.drainObservations()).toHaveLength(1);
  });
});
