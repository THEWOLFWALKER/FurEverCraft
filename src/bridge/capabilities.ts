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
}
