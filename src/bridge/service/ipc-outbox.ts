/**
 * Bounded outbound IPC queue. Child processes can produce observation/state messages faster
 * than the parent drains them, so sends must never grow without bound. Control messages are
 * tracked separately: losing one makes the reported state unknown instead of silently
 * pretending the parent saw it.
 *
 * Channel contract: the `send` callback returns false when Node accepted and queued the
 * message on a backed-up channel. That is a successful hand-off, not a rejection, so the
 * entry is removed from this queue and is never retried. A synchronous throw is the only
 * signal that the message was not handed off; that entry stays queued for a later flush.
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
export type OutboxFlushResult = { sent: number; queued: number; bytes: number; controlLost: boolean; transportError: boolean };

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
    let transportError = false;
    while (this.entries.length > 0) {
      const entry = this.entries[0]!;
      let queuedByChannel: boolean;
      try {
        // false = accepted and queued by the channel, so it is a successful hand-off.
        queuedByChannel = send(entry.message) === false;
      } catch {
        transportError = true;
        break;
      }
      this.entries.shift();
      this.bytes -= entry.bytes;
      sent += 1;
      // Stop duty flushing when the channel is backed up, but never retain/retry this
      // message: Node already owns it and a second send would duplicate it.
      if (queuedByChannel) break;
    }
    return { sent, queued: this.entries.length, bytes: this.bytes, controlLost: this.controlLost, transportError };
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
