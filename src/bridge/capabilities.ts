import type { BodyContext, WorldSnapshot } from '../contracts/index.js';

export type PlaceReceipt = { accepted: boolean; ambiguous?: boolean; commandId: string; seq: number };

/** Small body capability surface shared by simulated and client bridges. */
export interface ClientBridgeCapabilities {
  readonly context: BodyContext;
  readonly size: number;
  position: { x: number; y: number };
  inventory: number;
  snapshot(gap?: boolean): WorldSnapshot;
  cell(x: number, y: number): 'free' | 'blocked' | 'unknown';
  walk(x: number, y: number): void;
  place(x: number, y: number): PlaceReceipt;
  setUi(ui: 'gameplay' | 'chat' | 'inventory'): void;
  dispatchChat?(text: string): { accepted: boolean; ambiguous?: boolean; commandId: string; seq: number };
  /** Optional oriented look. Absent means the body cannot orient; skills must fail closed. */
  lookAt?(x: number, y: number): { accepted: boolean; yawDegrees: number };
  /** Optional dig. Absent means mining is unavailable in this profile. */
  dig?(x: number, y: number): { accepted: boolean; ambiguous?: boolean; commandId: string };
  /** Optional remembered-place lookup for return_to_place. */
  findPlace?(placeId: string): { x: number; y: number } | undefined;
}
