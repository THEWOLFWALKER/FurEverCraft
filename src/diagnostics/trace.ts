import { redact } from './redaction.js';
import type { Event, EventRead } from './events.js';

export type TraceRecord = {
  seq: string;
  eventId: string;
  kind: string;
  payload: unknown;
  context?: unknown;
  durable: boolean;
};

export type TraceDocument = {
  version: 1;
  source: 'offline-fixture';
  records: TraceRecord[];
};

/** Bounded diagnostic capture. It never records raw protocol bytes or secrets. */
export class TraceRecorder {
  private readonly records: TraceRecord[] = [];

  constructor(private readonly capacity = 4096) {}

  append(event: Event): TraceRecord {
    const record: TraceRecord = {
      seq: event.seq,
      eventId: event.eventId,
      kind: event.kind,
      payload: redact(event.payload),
      context: redact(event.context),
      durable: event.durable,
    };
    this.records.push(record);
    while (this.records.length > this.capacity) this.records.shift();
    return record;
  }

  appendRead(read: EventRead): void {
    for (const event of read.events) this.append(event);
  }

  export(): TraceDocument {
    return { version: 1, source: 'offline-fixture', records: structuredClone(this.records) };
  }
}

export type ReplayResult = { records: number; firstSeq?: string; lastSeq?: string; contiguous: boolean };

/** Replays diagnostics only; it cannot dispatch tools, input, or network requests. */
export function replayTrace(document: TraceDocument, onRecord?: (record: TraceRecord) => void): ReplayResult {
  if (document.version !== 1 || document.source !== 'offline-fixture') throw new Error('unsupported-trace');
  let previous: bigint | undefined;
  let contiguous = true;
  for (const record of document.records) {
    const sequence = BigInt(record.seq);
    if (previous !== undefined && sequence !== previous + 1n) contiguous = false;
    previous = sequence;
    onRecord?.(structuredClone(record));
  }
  return { records: document.records.length, firstSeq: document.records[0]?.seq, lastSeq: document.records.at(-1)?.seq, contiguous };
}
