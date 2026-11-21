import { nextId, type BodyContext } from '../contracts/index.js';
import type { SQLiteStore } from '../persistence/store.js';
import { redact } from './redaction.js';

export type Event = { seq: string; eventId: string; kind: string; payload: unknown; durable: boolean; context?: unknown };
export type EventRead = { events: Event[]; gap: boolean; next: string; scannedCursor: string; availableFrom: string };

export class EventHub {
  private readonly events: Event[] = [];
  readonly bootEpoch: string;
  private seq: bigint;
  private readonly subscribers = new Set<(event: Event) => void>();
  constructor(private readonly capacity = 1024, private readonly store?: SQLiteStore, private readonly defaultContext?: BodyContext) {
    this.bootEpoch = nextId('boot');
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
    for (const subscriber of this.subscribers) { try { subscriber(event); } catch { /* isolate consumers */ } }
    return event;
  }
  subscribe(listener: (event: Event) => void) { this.subscribers.add(listener); return () => this.subscribers.delete(listener); }
  /** Highest sequence assigned so far, including non-durable events. Used to build SSE snapshots. */
  head(): string { return this.seq.toString(); }
  read(after = '0', limit = 100, filter?: string): EventRead {
    if (!/^\d+$/.test(after)) throw new Error('invalid-event-cursor');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('invalid-event-limit');
    const cursor = BigInt(after);
    const durable = this.store?.getCriticalEvents(after, Number(this.seq - cursor > BigInt(this.capacity) ? this.capacity : this.seq - cursor)) as Event[] ?? [];
    const retained = this.events.filter(e => BigInt(e.seq) > cursor);
    const bySeq = new Map<string, Event>();
    for (const event of [...durable, ...retained]) bySeq.set(event.seq, event);
    const all = [...bySeq.values()].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
    const scanned = all.filter(e => BigInt(e.seq) > cursor);
    const matching = filter ? scanned.filter(e => e.kind === filter) : scanned;
    const events = matching.slice(0, limit);
    const scannedCursor = events.length === limit ? events.at(-1)!.seq : scanned.at(-1)?.seq ?? after;
    const matchingRetained = filter ? this.events.filter(event => event.kind === filter) : this.events;
    const retainedFirst = matchingRetained.length ? BigInt(matchingRetained[0]!.seq) : this.seq + 1n;
    const durableMatching = filter ? this.store?.getCriticalEvents(after, this.capacity, filter) as Event[] ?? [] : durable;
    const durableFirst = durableMatching.length ? BigInt(durableMatching[0]!.seq) : this.seq + 1n;
    const available = this.store ? (durableFirst < retainedFirst ? durableFirst : retainedFirst) : retainedFirst;
    const gap = filter ? false : cursor + 1n < available;
    return { events, gap, next: events.at(-1)?.seq ?? after, scannedCursor, availableFrom: available.toString() };
  }
}
