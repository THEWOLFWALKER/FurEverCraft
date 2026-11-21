/**
 * Shared provider transport primitives.
 *
 * Both OpenAI Chat Completions and Anthropic Messages use the same bounded request
 * runner: one queue, one retry budget, one deadline and one backoff policy. Provider
 * specific modules only translate canonical history and decode responses.
 */

export type StreamChunk = string | Uint8Array;
export interface HttpTransport {
  post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown>;
  postStream?(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<AsyncIterable<StreamChunk>>;
}
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly provider?: string, readonly retryable = false) { super(message); this.name = 'ProviderError'; }
}

export const MAX_SSE_RECORD_BYTES = 1024 * 1024;
export const MAX_SSE_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_TOOL_ARGUMENT_BYTES = 256 * 1024;
export const REQUEST_DEADLINE_MS = 60_000;
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
export const DEFAULT_MAX_QUEUED_REQUESTS = 8;
export const DEFAULT_MAX_SHARED_RETRIES = 8;

export const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
export const jsonText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);
export function parseToolArguments(value: string, provider?: string): unknown {
  if (utf8Bytes(value) > MAX_TOOL_ARGUMENT_BYTES) throw new ProviderError('provider-tool-arguments-limit', undefined, provider);
  try { return JSON.parse(value || '{}'); } catch { throw new ProviderError('provider-incomplete-tool-json', undefined, provider); }
}

export const SSE_DONE = Symbol('sse-done');
export function parseRetryAfter(value: string, now = Date.now()): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && value.trim() !== '') return Math.max(0, seconds * 1000);
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** Parse SSE with one UTF-8 decoder, bounded records, and bounded response bytes. */
export async function* parseSSE(chunks: AsyncIterable<StreamChunk>, options: { includeDone?: boolean } = {}): AsyncGenerator<unknown | typeof SSE_DONE> {
  let buffer = ''; const decoder = new TextDecoder(); let total = 0;
  const emit = async function* (record: string): AsyncGenerator<unknown | typeof SSE_DONE> {
    if (utf8Bytes(record) > MAX_SSE_RECORD_BYTES) throw new ProviderError('provider-sse-record-limit');
    const data = record.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    if (data === '[DONE]') { if (options.includeDone) yield SSE_DONE; return; }
    try { yield JSON.parse(data); } catch { throw new ProviderError('provider-invalid-sse-json'); }
  };
  for await (const chunk of chunks) {
    total += typeof chunk === 'string' ? utf8Bytes(chunk) : chunk.byteLength;
    if (total > MAX_SSE_RESPONSE_BYTES) throw new ProviderError('provider-sse-response-limit');
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let split: number; while ((split = buffer.indexOf('\n\n')) >= 0) { const record = buffer.slice(0, split); buffer = buffer.slice(split + 2); yield* emit(record); }
    if (utf8Bytes(buffer) > MAX_SSE_RECORD_BYTES) throw new ProviderError('provider-sse-record-limit');
  }
  buffer += decoder.decode(); buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (buffer.trim()) throw new ProviderError('provider-stream-truncated');
}

export async function* decodeBytes(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader(); const decoder = new TextDecoder();
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      const next = await reader.read();
      if (next.done) break;
      const text = decoder.decode(next.value, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode(); if (tail) yield tail;
  } finally { reader.releaseLock(); }
}

const abortError = () => new DOMException('The operation was aborted', 'AbortError');
const isRetryable = (error: unknown) => error instanceof ProviderError && error.retryable;

export type SharedRuntimeOptions = {
  maxConcurrent?: number;
  maxQueued?: number;
  /** Retry tokens shared by every provider that receives this runtime. */
  maxRetries?: number;
  deadlineMs?: number;
};

/**
 * A bounded request domain. `maxQueued` rejects work instead of growing without limit;
 * `maxRetries` is consumed globally so switching between OpenAI and Anthropic cannot
 * multiply the retry allowance.
 */
export class SharedProviderRuntime {
  private active = 0;
  private readonly waiting: Array<{ resolve: (release: () => void) => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void }> = [];
  private retriesUsed = 0;
  private readonly controllers = new Set<AbortController>();
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  readonly maxRetries: number;
  readonly deadlineMs: number;
  constructor(options: SharedRuntimeOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_REQUESTS);
    this.maxQueued = Math.max(0, options.maxQueued ?? DEFAULT_MAX_QUEUED_REQUESTS);
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_SHARED_RETRIES);
    this.deadlineMs = Math.max(1, options.deadlineMs ?? REQUEST_DEADLINE_MS);
  }
  get inFlight() { return this.active; }
  get queued() { return this.waiting.length; }
  get sharedRetriesUsed() { return this.retriesUsed; }
  /** Synchronous fast path so a request starts before the caller's next statement/cancel. */
  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.maxConcurrent) return undefined;
    this.active++;
    return this.releaser();
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    const immediate = this.tryAcquire();
    if (immediate) return immediate;
    if (this.waiting.length >= this.maxQueued) throw new ProviderError('provider-queue-full', 429, undefined, false);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal } as { resolve: (release: () => void) => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void };
      entry.onAbort = () => { const index = this.waiting.indexOf(entry); if (index >= 0) this.waiting.splice(index, 1); reject(abortError()); };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.waiting.push(entry);
    });
  }
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.signal?.removeEventListener('abort', next.onAbort!);
        // Hand the slot directly to the next waiter; `active` stays unchanged.
        next.resolve(this.releaser());
      } else {
        this.active--;
      }
    };
  }
  /** Consume one shared retry token. Returns false when the shared budget is exhausted. */
  consumeRetry(): boolean {
    if (this.retriesUsed >= this.maxRetries) return false;
    this.retriesUsed++;
    return true;
  }
  register(controller: AbortController) { this.controllers.add(controller); }
  unregister(controller: AbortController) { this.controllers.delete(controller); }
  /** Abort every in-flight request owned by this shared domain. */
  cancelAll() { for (const controller of this.controllers) controller.abort(); }
}

export type RetryOptions = {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Share the queue + retry budget with another provider. */
  shared?: SharedProviderRuntime;
  timeoutMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetriesPerRequest?: number;
};

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
});

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

export class ProviderRequestRunner {
  readonly shared: SharedProviderRuntime;
  private cancelEpoch = 0;
  private readonly options: Required<Pick<RetryOptions, 'timeoutMs' | 'baseDelayMs' | 'maxDelayMs' | 'maxRetriesPerRequest'>> & Pick<RetryOptions, 'sleep' | 'now'>;
  constructor(retry: RetryOptions = {}) {
    this.shared = retry.shared ?? new SharedProviderRuntime();
    this.options = {
      timeoutMs: Math.max(1, retry.timeoutMs ?? this.shared.deadlineMs),
      baseDelayMs: Math.max(0, retry.baseDelayMs ?? 500),
      maxDelayMs: Math.max(1, retry.maxDelayMs ?? 8000),
      maxRetriesPerRequest: Math.max(0, retry.maxRetriesPerRequest ?? 2),
      sleep: retry.sleep,
      now: retry.now,
    };
  }
  cancel() { this.cancelEpoch++; this.shared.cancelAll(); }

  async run<T>(fn: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal, provider?: string): Promise<T> {
    // Start synchronously when a slot is free; if it is queued, the caller's signal can still
    // abort before the slot is granted.
    const epoch = this.cancelEpoch;
    const release = this.shared.tryAcquire() ?? await this.shared.acquire(externalSignal);
    // A cancel that happened while this request was queued must not let it start afterwards.
    if (epoch !== this.cancelEpoch) { release(); throw abortError(); }
    const own = new AbortController();
    const relay = () => own.abort();
    externalSignal?.addEventListener('abort', relay, { once: true });
    this.shared.register(own);
    const now = this.options.now ?? Date.now;
    const started = now();
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; own.abort(); }, this.options.timeoutMs);
    let attempt = 0;
    try {
      while (true) {
        if (externalSignal?.aborted) throw abortError();
        if (timedOut) throw new ProviderError('provider-request-deadline', undefined, provider, false);
        try {
          const result = await raceAbort(fn(own.signal), own.signal);
          if (externalSignal?.aborted) throw abortError();
          return result;
        } catch (error) {
          if (externalSignal?.aborted) throw abortError();
          if (timedOut) throw new ProviderError('provider-request-deadline', undefined, provider, false);
          // A cancel() aborts without a deadline; surface it as an abort, never a retryable error.
          if (own.signal.aborted) throw abortError();
          if (!isRetryable(error) || attempt >= this.options.maxRetriesPerRequest) throw error;
          if (!this.shared.consumeRetry()) throw error;
          const retryAfter = (error as { retryAfterMs?: number }).retryAfterMs;
          const delay = Math.min(this.options.maxDelayMs, retryAfter ?? this.options.baseDelayMs * 2 ** attempt);
          const remaining = this.options.timeoutMs - (now() - started);
          if (remaining <= 0) throw new ProviderError('provider-request-deadline', undefined, provider, false);
          await (this.options.sleep ?? defaultSleep)(Math.min(delay, remaining), own.signal);
          attempt++;
        }
      }
    } finally {
      clearTimeout(deadline);
      externalSignal?.removeEventListener('abort', relay);
      this.shared.unregister(own);
      release();
    }
  }
}
