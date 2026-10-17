import { nextId, type BodyContext } from '../contracts/index.js';
import type { SQLiteStore } from '../persistence/store.js';
import { redact } from './redaction.js';

export type Event = { seq: string; eventId: string; kind: string; payload: unknown; durable: boolean; context?: unknown };
export type EventRead = { events: Event[]; gap: boolean; next: string; availableFrom: string };

export class EventHub {
  private readonly events: Event[] = [];
  private seq: bigint;
  constructor(private readonly capacity = 1024, private readonly store?: SQLiteStore, private readonly defaultContext?: BodyContext) {
    this.seq = BigInt(store?.getLatestCriticalSequence() ?? '0');
  }
  publish(kind: string, payload: unknown, durable = false, context: unknown = this.defaultContext) {
    const event: Event = { seq: (++this.seq).toString(), eventId: nextId('event'), kind, payload: redact(payload), durable, context: redact(context) };
    if (durable && this.store) {
      this.store.addCriticalEvent(event);
      event.durable = true;
    }
    this.events.push(event);
    while (this.events.length > this.capacity) this.events.shift();
    return event;
  }
  read(after = '0', limit = 100, filter?: string): EventRead {
    const cursor = BigInt(after);
    const durable = this.store?.getCriticalEvents(after, Math.max(limit, this.capacity), filter) as Event[] ?? [];
    const retained = this.events.filter(e => BigInt(e.seq) > cursor && (!filter || e.kind === filter));
    const bySeq = new Map<string, Event>();
    for (const event of [...durable, ...retained]) bySeq.set(event.seq, event);
    const all = [...bySeq.values()].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
    const events = all.slice(0, limit);
    const retainedFirst = this.events.length ? BigInt(this.events[0].seq) : this.seq + 1n;
    const durableFirst = durable.length ? BigInt(durable[0].seq) : retainedFirst;
    const available = this.store ? (durableFirst < retainedFirst ? durableFirst : retainedFirst) : retainedFirst;
    return { events, gap: cursor + 1n < available, next: events.at(-1)?.seq ?? after, availableFrom: available.toString() };
  }
}
