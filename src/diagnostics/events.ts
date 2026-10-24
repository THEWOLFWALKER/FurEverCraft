import { nextId, type BodyContext } from '../contracts/index.js';
import { sameStableScope, stableScopeOf, type SQLiteStore } from '../persistence/store.js';
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
  /**
   * Read events from a cursor. When a scope is supplied (or the hub was built with a default
   * body context) only events from that stable world/account/dimension are returned, from both
   * the in-memory ring and the durable table. Cursors stay global so a snapshot watermark is
   * still monotonic across scopes.
   */
  read(after = '0', limit = 100, filter?: string, scopeValue?: unknown): EventRead {
    if (!/^\d+$/.test(after)) throw new Error('invalid-event-cursor');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('invalid-event-limit');
    const scope = stableScopeOf(scopeValue === undefined ? this.defaultContext : scopeValue);
    const inScope = (event: Event) => !scope || sameStableScope(event.context, scope);
    const cursor = BigInt(after);
    const durable = scope
      ? (this.store?.getCriticalEvents(after, this.capacity, undefined, scope) as Event[] ?? [])
      : (this.store?.getCriticalEvents(after, Number(this.seq - cursor > BigInt(this.capacity) ? this.capacity : this.seq - cursor)) as Event[] ?? []);
    const retained = this.events.filter(e => BigInt(e.seq) > cursor && inScope(e));
    const bySeq = new Map<string, Event>();
    for (const event of [...durable, ...retained]) bySeq.set(event.seq, event);
    const all = [...bySeq.values()].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
    const scanned = all.filter(e => BigInt(e.seq) > cursor);
    const matching = filter ? scanned.filter(e => e.kind === filter) : scanned;
    const events = matching.slice(0, limit);
    const scannedCursor = events.length === limit ? events.at(-1)!.seq : scanned.at(-1)?.seq ?? after;
    const matchingRetained = filter
      ? this.events.filter(event => event.kind === filter && inScope(event))
      : this.events.filter(inScope);
    const retainedFirst = matchingRetained.length ? BigInt(matchingRetained[0]!.seq) : this.seq + 1n;
    const durableMatching = this.store
      ? scope
        ? this.store.getCriticalEvents(after, this.capacity, filter, scope) as Event[]
        : this.store.getCriticalEvents(after, this.capacity, filter) as Event[]
      : [];
    const durableFirst = durableMatching.length ? BigInt(durableMatching[0]!.seq) : this.seq + 1n;
    const available = this.store ? (durableFirst < retainedFirst ? durableFirst : retainedFirst) : retainedFirst;
    const gap = filter ? false : cursor + 1n < available;
    return { events, gap, next: events.at(-1)?.seq ?? after, scannedCursor, availableFrom: available.toString() };
  }
}
