export type CaptureView = { purpose: string; source: 'synthetic-fixture' | 'client-observer' | 'os-capture'; frameTime: number; version: string; sensitive: boolean; mimeType: 'image/png'; data: string };
export type HistoryEntry = { role: string; content: unknown; toolCallId?: string };
export class BoundedHistory {
  private entries: HistoryEntry[] = [];
  constructor(private readonly maxEntries = 200, private readonly maxBytes = 256 * 1024) {}
  push(entry: HistoryEntry) { this.entries.push(structuredClone(entry)); this.trim(); }
  values() { return structuredClone(this.entries); }
  get size() { return this.entries.length; }
  private trim() { while (this.entries.length > this.maxEntries || JSON.stringify(this.entries).length > this.maxBytes) { const index = this.entries.findIndex(item => item.role !== 'tool'); if (index < 0) this.entries.shift(); else this.entries.splice(index, 1); } }
}
export function syntheticCapture(purpose: string, frameTime: number, version: string): CaptureView { return { purpose, source: 'synthetic-fixture', frameTime, version, sensitive: false, mimeType: 'image/png', data: 'c2ltdWxhdGVk' }; }
