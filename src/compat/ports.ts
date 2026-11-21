/** Vendor/OS-neutral interfaces. Identity is checked against the bundle manifest at assembly. */
export interface AdapterComponent { readonly id: string; readonly version: string; readonly digest: string }
export type ProtocolFrame = {
  gameRelease: string; protocol: number;
  direction: 'client-to-server' | 'server-to-client'; phase: string;
  sessionId: string; connectionEpoch: string; registryEpoch: string;
  payload: Uint8Array;
};
export type CanonicalObservation = {
  domain: 'position' | 'blocks' | 'entities' | 'inventory' | 'chat' | 'lifecycle';
  kind: string; payload: Record<string, unknown>;
  source: 'client-reported' | 'server-observed' | 'synthetic';
};
export type PacketDecodeResult =
  | { status: 'decoded'; consumedBytes: number; events: CanonicalObservation[] }
  | { status: 'unsupported'; dependency: string; affectedDomains: string[] }
  | { status: 'invalid'; reason: string; affectedDomains: string[] };
export interface ProtocolPort extends AdapterComponent {
  decode(frame: Readonly<ProtocolFrame>): PacketDecodeResult;
}
export interface GameDataPort extends AdapterComponent {
  query(input: { releaseId: string; resourceId: string; topic: string; limit: number }): {
    status: 'known' | 'unknown' | 'conflict'; records: readonly unknown[]; releaseId: string;
  };
}
export interface GeometryPhysicsPort extends AdapterComponent {
  shape(input: { registryEpoch: string; stateId: number; kind: 'collision' | 'interaction' }):
    { status: 'unknown' | 'unsupported' } | { status: 'known'; boxes: ReadonlyArray<readonly [number, number, number, number, number, number]>; evidenceRefs: string[] };
}
export interface ClientControlPort extends AdapterComponent {
  binding(action: string): { status: 'unknown' } | { status: 'known'; physicalKey: string; calibrationId: string };
}
export type ModuleByKind = { protocol: ProtocolPort; data: GameDataPort; geometryPhysics: GeometryPhysicsPort; clientControl: ClientControlPort };
