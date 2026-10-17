import minecraftData from 'minecraft-data';
import minecraftProtocol from 'minecraft-protocol';

const { createSerializer, createDeserializer, states } = minecraftProtocol;
// Historical codec fixture only. Current-target metadata is defined by GameVersionProfile.
export const LEGACY_FIXTURE_VERSION = '1.20.4';
export const LEGACY_FIXTURE_PROTOCOL = 765;
export const MINECRAFT_VERSION = LEGACY_FIXTURE_VERSION;
export const PROTOCOL_VERSION = LEGACY_FIXTURE_PROTOCOL;

export type BridgePhase = 'HANDSHAKE' | 'STATUS' | 'LOGIN' | 'CONFIGURATION' | 'PLAY' | 'CLOSED';
export type ProtocolDirection = 'downstream' | 'upstream';
export type ObservationAvailability = 'available' | 'unknown' | 'degraded';

export type BridgePacket = {
  name: string;
  params?: Record<string, unknown>;
  direction: ProtocolDirection;
  phase: BridgePhase;
  sequence?: string;
};

export type NormalizedObservation = {
  kind: string;
  source: 'fixture';
  direction: ProtocolDirection;
  sessionEpoch: string;
  bodyEpoch: string;
  sequence: string;
  availability: ObservationAvailability;
  gap?: { from: string; to: string };
  payload: unknown;
};

export interface PacketTransport {
  send(packet: BridgePacket): Promise<void>;
  close(): Promise<void>;
}

export interface ByteTransport {
  write(chunk: Uint8Array): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  close(): Promise<void>;
}

function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let current = value >>> 0;
  do { let next = current & 0x7f; current >>>= 7; if (current !== 0) next |= 0x80; bytes.push(next); } while (current !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer: Buffer): { value: number; size: number } | undefined {
  let value = 0;
  for (let index = 0; index < Math.min(buffer.length, 5); index += 1) {
    value |= (buffer[index] & 0x7f) << (7 * index);
    if ((buffer[index] & 0x80) === 0) return { value: value >>> 0, size: index + 1 };
  }
  return undefined;
}

/** Encodes real minecraft-protocol packet bodies into framed bytes and decodes fragmented input. */
export class MinecraftBytePacketTransport implements PacketTransport {
  private readonly listeners = new Set<(packet: BridgePacket) => void>();
  private input = Buffer.alloc(0);
  private closed = false;
  private readonly unsubscribe: () => void;
  constructor(readonly name: string, private readonly byteTransport: ByteTransport, private readonly direction: ProtocolDirection, private readonly phase: () => BridgePhase) {
    this.unsubscribe = this.byteTransport.onData(chunk => this.consume(Buffer.from(chunk)));
  }
  onPacket(listener: (packet: BridgePacket) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async send(packet: BridgePacket): Promise<void> {
    if (this.closed) throw new Error(`transport-closed:${this.name}`);
    const serializer = createSerializer({ state: stateFor(packet.phase), isServer: packet.direction === 'upstream', version: MINECRAFT_VERSION, customPackets: {} });
    const body = serializer.createPacketBuffer({ name: packet.name, params: packet.params ?? {} });
    await this.byteTransport.write(Buffer.concat([writeVarInt(body.length), body]));
  }
  private consume(chunk: Buffer) {
    if (this.closed) return;
    this.input = Buffer.concat([this.input, chunk]);
    while (true) {
      const length = readVarInt(this.input); if (!length || this.input.length < length.size + length.value) return;
      const body = this.input.subarray(length.size, length.size + length.value); this.input = this.input.subarray(length.size + length.value);
      const parser = createDeserializer({ state: stateFor(this.phase()), isServer: this.direction === 'downstream', version: MINECRAFT_VERSION, customPackets: {}, noErrorLogging: true } as Parameters<typeof createDeserializer>[0] & { noErrorLogging?: boolean });
      parser.on('data', (decoded: { data: { name: number | string; params?: Record<string, unknown> } }) => {
        const mappings = packetNames(this.phase(), this.direction);
        const name = typeof decoded.data.name === 'number' ? [...mappings][decoded.data.name] : decoded.data.name;
        if (!name) return;
        for (const listener of this.listeners) listener({ name, params: decoded.data.params, direction: this.direction, phase: this.phase() });
      });
      parser.write(body); parser.end();
    }
  }
  async close() { this.closed = true; this.unsubscribe(); await this.byteTransport.close(); }
}

export class LoopbackByteTransport implements ByteTransport {
  closed = false;
  private readonly listeners = new Set<(chunk: Uint8Array) => void>();
  constructor(readonly name: string, private peer?: LoopbackByteTransport, private readonly fragmentSizes: number[] = []) {}
  connect(peer: LoopbackByteTransport) { this.peer = peer; }
  onData(listener: (chunk: Uint8Array) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async write(chunk: Uint8Array) {
    if (this.closed) throw new Error(`transport-closed:${this.name}`);
    if (!this.peer) return;
    let offset = 0; let index = 0;
    while (offset < chunk.length) { const size = this.fragmentSizes[index++] ?? chunk.length - offset; const part = chunk.slice(offset, offset + size); offset += size; for (const listener of this.peer.listeners) listener(part); }
  }
  async close() { this.closed = true; }
}

export function createLoopbackBytePair(fragmentSizes = [1, 2, 3]): { left: LoopbackByteTransport; right: LoopbackByteTransport } {
  const left = new LoopbackByteTransport('left', undefined, fragmentSizes);
  const right = new LoopbackByteTransport('right', left, fragmentSizes);
  left.connect(right);
  return { left, right };
}

type Observer = (observation: NormalizedObservation) => void;
type QueueEntry = { observation: NormalizedObservation; delivered: boolean };

const mcData = minecraftData(MINECRAFT_VERSION);
if (!mcData || mcData.version?.version !== PROTOCOL_VERSION) {
  throw new Error(`unsupported-minecraft-data:${MINECRAFT_VERSION}/${PROTOCOL_VERSION}`);
}

const protocolStates: Record<BridgePhase, string> = {
  HANDSHAKE: 'handshaking', STATUS: 'status', LOGIN: 'login', CONFIGURATION: 'configuration', PLAY: 'play', CLOSED: 'play'
};

function stateFor(phase: BridgePhase) { const key = phase === 'HANDSHAKE' ? 'HANDSHAKING' : phase; return states[key as keyof typeof states] ?? states.PLAY; }
function packetNames(phase: BridgePhase, direction: ProtocolDirection): Set<string> {
  const normalizedPhase = phase === ('HANDSHAKING' as BridgePhase) ? 'HANDSHAKE' : phase;
  if (normalizedPhase === 'CLOSED') return new Set();
  const state = mcData.protocol[protocolStates[normalizedPhase] as keyof typeof mcData.protocol] as { toServer: { types: Record<string, unknown> }; toClient: { types: Record<string, unknown> } };
  const definition = direction === 'downstream' ? state.toServer.types.packet : state.toClient.types.packet;
  const container = definition as ['container', Array<{ name: string; type: unknown }>];
  const fields = container[1] ?? [];
  const union = fields.find((field) => field.name === 'name')?.type as ['mapper', { mappings?: Record<string, string> }] | undefined;
  return new Set(Object.values(union?.[1]?.mappings ?? {}));
}

const stateTransitions: Record<BridgePhase, BridgePhase[]> = {
  HANDSHAKE: ['STATUS', 'LOGIN', 'CLOSED'], STATUS: ['CLOSED'], LOGIN: ['CONFIGURATION', 'PLAY', 'CLOSED'],
  CONFIGURATION: ['PLAY', 'CLOSED'], PLAY: ['CLOSED'], CLOSED: []
};

export class ProtocolSession {
  readonly source = 'fixture' as const;
  downstreamPhase: BridgePhase = 'HANDSHAKE';
  upstreamPhase: BridgePhase = 'HANDSHAKE';

  private sequence = 0n;
  private readonly observers = new Set<Observer>();
  private readonly queue: QueueEntry[] = [];
  private lastDelivered = 0n;

  constructor(
    readonly sessionEpoch = `session_${Math.random().toString(36).slice(2)}`,
    readonly bodyEpoch = `body_${Math.random().toString(36).slice(2)}`,
    private readonly observationCapacity = 128,
  ) {}

  get phase(): BridgePhase { return this.downstreamPhase; }
  set phase(value: BridgePhase) { this.downstreamPhase = value; this.upstreamPhase = value; }

  transition(next: BridgePhase, direction: ProtocolDirection = 'downstream'): void {
    const current = direction === 'downstream' ? this.downstreamPhase : this.upstreamPhase;
    if (!stateTransitions[current].includes(next)) throw new Error(`invalid-phase-transition:${current}->${next}`);
    if (direction === 'downstream') this.downstreamPhase = next; else this.upstreamPhase = next;
  }

  validatePacket(packet: BridgePacket): void {
    if (packet.phase !== this.phase) throw new Error(`packet-phase-mismatch:${packet.name}:${packet.phase}/${this.phase}`);
    if (!packetNames(packet.phase, packet.direction).has(packet.name)) throw new Error(`unknown-packet:${packet.phase}:${packet.direction}:${packet.name}`);
  }

  observe(kind: string, direction: ProtocolDirection, payload: unknown, availability: ObservationAvailability = 'available'): NormalizedObservation {
    const sequence = (++this.sequence).toString();
    const observation: NormalizedObservation = { kind, source: 'fixture', direction, sessionEpoch: this.sessionEpoch, bodyEpoch: this.bodyEpoch, sequence, availability, payload };
    if (this.queue.length >= this.observationCapacity) {
      const dropped = this.queue.shift()!.observation.sequence;
      const gap: NormalizedObservation = { ...observation, kind: 'observation_gap', availability: 'degraded', gap: { from: dropped, to: sequence }, payload: null };
      this.queue.length = 0;
      this.queue.push({ observation: gap, delivered: false });
      for (const observer of this.observers) observer(gap);
      return gap;
    }
    this.queue.push({ observation, delivered: false });
    for (const observer of this.observers) observer(observation);
    return observation;
  }

  subscribe(observer: Observer): () => void { this.observers.add(observer); return () => this.observers.delete(observer); }

  drainObservations(): NormalizedObservation[] {
    const result = this.queue.filter((entry) => !entry.delivered).map((entry) => entry.observation);
    for (const entry of this.queue) entry.delivered = true;
    if (result.length > 0) this.lastDelivered = BigInt(result[result.length - 1].sequence);
    return result;
  }

  close(): void { this.phase = 'CLOSED'; this.queue.length = 0; this.observers.clear(); }
  get latestSequence(): string { return this.sequence.toString(); }
  get deliveredSequence(): string { return this.lastDelivered.toString(); }
}

export class LoopbackFixtureTransport implements PacketTransport {
  readonly packets: BridgePacket[] = [];
  closed = false;
  constructor(readonly name: string, private readonly peer?: LoopbackFixtureTransport) {}
  async send(packet: BridgePacket): Promise<void> {
    if (this.closed) throw new Error(`transport-closed:${this.name}`);
    this.packets.push(structuredClone(packet));
    if (this.peer) this.peer.packets.push(structuredClone(packet));
  }
  async close(): Promise<void> { this.closed = true; }
}

export function createLoopbackTransports(): { downstream: LoopbackFixtureTransport; upstream: LoopbackFixtureTransport } {
  return { downstream: new LoopbackFixtureTransport('downstream'), upstream: new LoopbackFixtureTransport('upstream') };
}

export class OfflineProtocolBridge {
  readonly session: ProtocolSession;
  constructor(
    private readonly downstream: PacketTransport,
    private readonly upstream: PacketTransport,
    private readonly allowUpstream = false,
    session?: ProtocolSession,
  ) { this.session = session ?? new ProtocolSession(); }

  async start(): Promise<void> {
    if (!this.allowUpstream) throw new Error('minecraft-upstream-disabled');
    if (this.session.phase !== 'HANDSHAKE') throw new Error(`cannot-start:${this.session.phase}`);
  }

  transition(next: BridgePhase): void { this.session.transition(next); }

  async forward(packet: BridgePacket): Promise<NormalizedObservation> {
    if (this.session.phase === 'CLOSED') throw new Error('session-closed');
    if (!this.allowUpstream && packet.direction === 'downstream') throw new Error('minecraft-upstream-disabled');
    this.session.validatePacket(packet);
    const target = packet.direction === 'downstream' ? this.upstream : this.downstream;
    await target.send({ ...packet, sequence: packet.sequence ?? this.session.latestSequence });
    return this.session.observe(packet.name, packet.direction, packet.params ?? {});
  }

  async close(): Promise<void> { this.session.close(); await Promise.all([this.downstream.close(), this.upstream.close()]); }
}

export function minecraftDataSummary(): { version: string; protocol: number; kind: 'legacy-codec-fixture'; phases: BridgePhase[] } {
  return { version: MINECRAFT_VERSION, protocol: PROTOCOL_VERSION, kind: 'legacy-codec-fixture', phases: ['HANDSHAKE', 'STATUS', 'LOGIN', 'CONFIGURATION', 'PLAY', 'CLOSED'] };
}
