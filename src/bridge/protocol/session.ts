import minecraftData from 'minecraft-data';

export const MINECRAFT_VERSION = '1.20.4';
export const PROTOCOL_VERSION = 765;

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

type Observer = (observation: NormalizedObservation) => void;
type QueueEntry = { observation: NormalizedObservation; delivered: boolean };

const mcData = minecraftData(MINECRAFT_VERSION);
if (!mcData || mcData.version?.version !== PROTOCOL_VERSION) {
  throw new Error(`unsupported-minecraft-data:${MINECRAFT_VERSION}/${PROTOCOL_VERSION}`);
}

const protocolStates: Record<BridgePhase, string> = {
  HANDSHAKE: 'handshaking', STATUS: 'status', LOGIN: 'login', CONFIGURATION: 'configuration', PLAY: 'play', CLOSED: 'play'
};

function packetNames(phase: BridgePhase, direction: ProtocolDirection): Set<string> {
  if (phase === 'CLOSED') return new Set();
  const state = mcData.protocol[protocolStates[phase] as keyof typeof mcData.protocol] as { toServer: { types: Record<string, unknown> }; toClient: { types: Record<string, unknown> } };
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
  phase: BridgePhase = 'HANDSHAKE';
  private sequence = 0n;
  private readonly observers = new Set<Observer>();
  private readonly queue: QueueEntry[] = [];
  private lastDelivered = 0n;

  constructor(
    readonly sessionEpoch = `session_${Math.random().toString(36).slice(2)}`,
    readonly bodyEpoch = `body_${Math.random().toString(36).slice(2)}`,
    private readonly observationCapacity = 128,
  ) {}

  transition(next: BridgePhase): void {
    if (!stateTransitions[this.phase].includes(next)) throw new Error(`invalid-phase-transition:${this.phase}->${next}`);
    this.phase = next;
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

export function minecraftDataSummary(): { version: string; protocol: number; phases: BridgePhase[] } {
  return { version: MINECRAFT_VERSION, protocol: PROTOCOL_VERSION, phases: ['HANDSHAKE', 'STATUS', 'LOGIN', 'CONFIGURATION', 'PLAY', 'CLOSED'] };
}
