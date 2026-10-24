import type { ModelMessage, ModelProvider, ModelResponse, ToolCall } from './scripted/index.js';
import { admitToolCalls, assertModelResponse, CanonicalHistory, isToolHistoryComplete, ToolExecutionLedger } from './canonical.js';
import { ProviderError } from './shared.js';

export type ProviderSessionOptions = {
  providers: Record<string, ModelProvider>;
  initialProvider?: string;
  tools?: unknown[];
  execute: (call: ToolCall, signal?: AbortSignal) => Promise<unknown>;
  /** Tools with external effects. These are serialized and replay-guarded. */
  writeTools?: Iterable<string>;
  maxTurns?: number;
  maxParallelCalls?: number;
  ledger?: ToolExecutionLedger;
};

export type ProviderSessionRunOptions = {
  signal?: AbortSignal;
  goalId?: string;
  /** Goal revision fixed when the user turn started. A changed revision fences old tool work. */
  expectedRevision?: number;
  getGoalRevision?: (goalId: string) => number | undefined;
};

export type ProviderSessionTurn = { provider: string; response: ModelResponse; replayed: string[]; executed: string[] };

/**
 * Multi-turn conversation driver over canonical history. It is the piece that makes provider
 * switching consistent: the transcript is provider-neutral, tool call/result order is kept,
 * writes are replay-guarded, and the old provider is fenced before the new one is used.
 */
export class ProviderSession {
  readonly history = new CanonicalHistory();
  readonly ledger: ToolExecutionLedger;
  private providerName: string;
  private readonly providers: Record<string, ModelProvider>;
  private readonly tools: unknown[];
  private readonly execute: ProviderSessionOptions['execute'];
  private readonly maxTurns: number;
  private readonly maxParallelCalls: number;
  /** Guards the ledger against a late read completion from an already-aborted run. */
  private runEpoch = 0;
  readonly turns: ProviderSessionTurn[] = [];

  constructor(options: ProviderSessionOptions) {
    this.providers = options.providers;
    this.providerName = options.initialProvider ?? Object.keys(options.providers)[0] ?? '';
    if (!this.providers[this.providerName]) throw new ProviderError('provider-unknown');
    this.tools = options.tools ?? [];
    this.execute = options.execute;
    this.maxTurns = Math.max(1, options.maxTurns ?? 8);
    this.maxParallelCalls = Math.max(1, options.maxParallelCalls ?? 8);
    this.ledger = options.ledger ?? new ToolExecutionLedger(new Set(options.writeTools ?? []));
  }

  get provider() { return this.providerName; }
  get modelProvider(): ModelProvider { return this.providers[this.providerName]!; }

  /** Cancel the current provider request and rebuild future turns with another provider. */
  switchProvider(name: string): void {
    if (!this.providers[name]) throw new ProviderError(`provider-unknown:${name}`);
    // A switch with an open tool turn would produce two adjacent unpaired turns. Refuse instead
    // of silently fabricating results; callers should let the turn settle or cancel it.
    if (!isToolHistoryComplete(this.history.snapshot())) throw new ProviderError('provider-switch-tool-turn-open');
    this.modelProvider.cancel();
    this.providerName = name;
  }

  async run(input: string | ModelMessage, options: ProviderSessionRunOptions = {}): Promise<{ response: ModelResponse; turns: ProviderSessionTurn[] }> {
    const { signal } = options;
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    // Replay suppression is scoped to this top-level user turn. The model-turn retry chain
    // below still dedupes identical writes, while the next legitimate user turn can perform
    // the same write again. Durable execution/proposal records cover restarts.
    const runEpoch = ++this.runEpoch;
    this.ledger.reset();
    this.history.append(typeof input === 'string' ? { role: 'user', content: input } : input);
    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
      if (options.goalId && options.expectedRevision !== undefined && options.getGoalRevision) {
        const revision = options.getGoalRevision(options.goalId);
        if (revision !== options.expectedRevision) throw new Error(`goal-revision-conflict:${revision ?? 'missing'}`);
      }
      let response: ModelResponse;
      try {
        response = await this.modelProvider.complete(this.history.snapshot(), this.tools, signal);
      } catch (error) {
        if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
        throw error;
      }
      // Guard injected providers too: a malformed/truncated body is not a completed turn.
      assertModelResponse(response, this.providerName);
      const calls = response.toolCalls?.length ? admitToolCalls(response, this.maxParallelCalls) : [];
      if (!calls.length) return { response, turns: this.turns };
      // Persist the assistant turn exactly once, before any tool result exists. Use admitted
      // calls so empty argument payloads are stored as valid JSON (`{}`).
      this.history.appendAssistant({ ...response, toolCalls: calls }, this.providerName);
      const results = new Map<string, unknown>();
      const executed: string[] = [];
      const replayed: string[] = [];
      const pending: ToolCall[] = [];
      for (const call of calls) {
        const reuse = this.ledger.reuse(call);
        if (reuse.replayed) { results.set(call.id, reuse.result); replayed.push(call.id); }
        else pending.push(call);
      }
      // Read-only calls may fan out; a write tool forces the whole batch through the ordered,
      // serial path so concurrent input cannot interleave at the body.
      const hasWrite = pending.some(call => this.ledger.isWrite(call.name));
      try {
        if (!hasWrite) {
          await Promise.all(pending.map(async call => {
            if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
            try {
              const result = await this.execute(call, signal);
              // A read that completed after this run was aborted/closed must not leak into a
              // newer run's ledger.
              if (runEpoch !== this.runEpoch) return;
              this.ledger.record(call, result);
              executed.push(call.id);
              results.set(call.id, result);
            } catch (error) {
              // An abort is not a tool outcome: stop the chain and let the catch below close
              // the turn with complete pairing.
              if (signal?.aborted) throw error;
              // A read that failed after this run was superseded must not leak into a newer run.
              if (runEpoch !== this.runEpoch) return;
              // Tool failure is a tool result, not a provider failure; let the model see it.
              const failure = { ok: false, error: error instanceof Error ? error.message : String(error) };
              this.ledger.record(call, failure);
              executed.push(call.id);
              results.set(call.id, failure);
            }
          }));
        } else {
          for (const call of pending) {
            if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
            try {
              const result = await this.execute(call, signal);
              this.ledger.record(call, result);
              executed.push(call.id);
              results.set(call.id, result);
            } catch (error) {
              if (signal?.aborted) throw error;
              const failure = { ok: false, error: error instanceof Error ? error.message : String(error) };
              this.ledger.record(call, failure);
              executed.push(call.id);
              results.set(call.id, failure);
            }
          }
        }
      } catch (error) {
        // An abort between sequential calls must not leave an assistant tool call without a
        // result: the transcript would be poisoned and a provider switch would be refused.
        // Record an explicit outcome for every call that has none yet (queued or canceled).
        const aborted = { ok: false, error: 'aborted', canceled: true, reason: error instanceof Error ? error.message : String(error) };
        for (const call of calls) if (!results.has(call.id)) results.set(call.id, aborted);
        this.history.appendToolResults(calls, results);
        throw error;
      }
      // Preserve assistant call order in the canonical tool results even when reads completed in
      // a different order. Anthropic requires this contiguous order.
      this.history.appendToolResults(calls, results);
      this.turns.push({ provider: this.providerName, response: { ...response, toolCalls: calls }, replayed, executed });
    }
    throw new ProviderError('provider-max-turns', undefined, this.providerName);
  }
}
