/**
 * Bounded outbound IPC queue. Child processes can produce observation/state messages faster
 * than the parent drains them, so sends must never grow without bound. Control messages are
 * tracked separately: losing one makes the reported state unknown instead of silently
 * pretending the parent saw it.
 */
export type IpcOutboxOptions = {
  maxMessages: number;
  maxBytes: number;
  isControl?: (message: IpcMessageLike) => boolean;
  estimateBytes?: (message: IpcMessageLike) => number;
};
export type IpcMessageLike = { type?: string; [key: string]: unknown };
type Entry = { message: IpcMessageLike; bytes: number; control: boolean };
export type OutboxPushResult = { accepted: boolean; dropped: number; controlLost: boolean; bytes: number };
export type OutboxFlushResult = { sent: number; queued: number; bytes: number; controlLost: boolean };

const CONTROL_TYPES = new Set(['state', 'relay-exit', 'relay-restart', 'fatal', 'shutdown', 'ipc-overflow', 'control-revoked']);

export class BoundedIpcOutbox {
  private readonly entries: Entry[] = [];
  private bytes = 0;
  private droppedCount = 0;
  private controlLost = false;
  private readonly options: Required<Omit<IpcOutboxOptions, 'isControl' | 'estimateBytes'>> & Pick<IpcOutboxOptions, 'isControl' | 'estimateBytes'>;
  constructor(options: Partial<IpcOutboxOptions> = {}) {
    this.options = {
      maxMessages: options.maxMessages ?? 256,
      maxBytes: options.maxBytes ?? 1024 * 1024,
      isControl: options.isControl,
      estimateBytes: options.estimateBytes,
    };
  }

  push(message: IpcMessageLike, control = this.isControl(message)): OutboxPushResult {
    const bytes = this.options.estimateBytes?.(message) ?? Buffer.byteLength(JSON.stringify(message), 'utf8');
    let dropped = 0;
    while (this.entries.length > 0 && (this.entries.length >= this.options.maxMessages || this.bytes + bytes > this.options.maxBytes)) {
      const droppedEntry = this.entries.shift()!;
      this.bytes -= droppedEntry.bytes;
      dropped += 1;
      this.droppedCount += 1;
      if (droppedEntry.control) this.controlLost = true;
    }
    if (bytes > this.options.maxBytes) {
      this.droppedCount += 1;
      if (control) this.controlLost = true;
      return { accepted: false, dropped, controlLost: this.controlLost, bytes: this.bytes };
    }
    this.entries.push({ message, bytes, control });
    this.bytes += bytes;
    return { accepted: true, dropped, controlLost: this.controlLost, bytes: this.bytes };
  }

  flush(send: (message: IpcMessageLike) => boolean): OutboxFlushResult {
    let sent = 0;
    while (this.entries.length > 0) {
      const entry = this.entries[0]!;
      if (!send(entry.message)) break;
      this.entries.shift();
      this.bytes -= entry.bytes;
      sent += 1;
    }
    return { sent, queued: this.entries.length, bytes: this.bytes, controlLost: this.controlLost };
  }

  queued(): { messages: number; bytes: number; dropped: number; controlLost: boolean } {
    return { messages: this.entries.length, bytes: this.bytes, dropped: this.droppedCount, controlLost: this.controlLost };
  }

  clear(): void {
    this.entries.length = 0;
    this.bytes = 0;
  }

  private isControl(message: IpcMessageLike): boolean {
    return this.options.isControl?.(message) ?? CONTROL_TYPES.has(String(message.type));
  }
}
