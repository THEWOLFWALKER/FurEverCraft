import { randomUUID } from 'node:crypto';
import type { ModelMessage, ModelProvider, ModelResponse, ToolCall } from './scripted/index.js';
import { admitToolCalls, CanonicalHistory, isToolHistoryComplete, ToolExecutionLedger } from './canonical.js';
import { ProviderError } from './shared.js';
import { classifyToolCall, createToolClassifier, isMutationClass, type ToolClass } from './tools.js';

export type ProviderSessionOptions = {
  providers: Record<string, ModelProvider>;
  initialProvider?: string;
  tools?: unknown[];
  execute: (call: ToolCall, signal?: AbortSignal) => Promise<unknown>;
  /** Explicit additional tools with external effects. Classification is dynamic for start_skill. */
  writeTools?: Iterable<string>;
  /** Override the shared classifier (tests/fixtures). */
  classifyTool?: (call: ToolCall) => ToolClass;
  /** Logical session identity; part of every tool call's logical id. Defaults to a random id. */
  sessionId?: string;
  maxTurns?: number;
  maxParallelCalls?: number;
  ledger?: ToolExecutionLedger;
};

export type ProviderSessionRunOptions = {
  signal?: AbortSignal;
  /**
   * Application-level decision identity. Reusing it is an explicit "retry the same logic
   * action" request; omitting it starts a new decision, so identical text/arguments execute
   * again instead of being suppressed as a fingerprint duplicate (FEC-39).
   */
  decisionId?: string;
  goalId?: string;
  /** Goal revision fixed when the user turn started. A changed revision fences old tool work. */
  expectedRevision?: number;
  getGoalRevision?: (goalId: string) => number | undefined;
};

/** Raw provider tool-call ids are provenance; canonical history uses the internal id. */
export type ToolCallProvenance = { internalId: string; providerId: string; name: string; logicalId: string };
export type ProviderSessionTurn = {
  provider: string;
  response: ModelResponse;
  replayed: string[];
  executed: string[];
  provenance: ToolCallProvenance[];
};

const abortError = () => new DOMException('The operation was aborted', 'AbortError');
const isAbort = (error: unknown) => error instanceof Error && (error.name === 'AbortError' || (error as { code?: string }).code === 'ABORT_ERR');
const notExecuted = () => ({ ok: false, code: 'not-executed', error: 'not-executed' });
const ambiguous = () => ({ ok: false, code: 'ambiguous', error: 'ambiguous' });

type PlannedCall = {
  /** Canonical call with a session-unique internal id used for history pairing. */
  call: ToolCall;
  /** Raw id exactly as delivered by the provider, kept as provenance. */
  providerId: string;
  logicalId: string;
};

/**
 * Multi-turn conversation driver over canonical history. It is the piece that makes provider
 * switching consistent: the transcript is provider-neutral, tool call/result order is kept,
 * writes are replay-guarded by logical call identity, and the old provider is fenced before
 * the new one is used.
 */
export class ProviderSession {
  readonly history = new CanonicalHistory();
  readonly ledger: ToolExecutionLedger;
  readonly sessionId: string;
  private providerName: string;
  private readonly providers: Record<string, ModelProvider>;
  private readonly tools: unknown[];
  private readonly execute: ProviderSessionOptions['execute'];
  private readonly classifyTool: (call: ToolCall) => ToolClass;
  private readonly maxTurns: number;
  private readonly maxParallelCalls: number;
  private decisionCounter = 0;
  private readonly usedToolCallIds = new Set<string>();
  readonly turns: ProviderSessionTurn[] = [];

  constructor(options: ProviderSessionOptions) {
    this.providers = options.providers;
    this.providerName = options.initialProvider ?? Object.keys(options.providers)[0] ?? '';
    if (!this.providers[this.providerName]) throw new ProviderError('provider-unknown');
    this.tools = options.tools ?? [];
    this.execute = options.execute;
    this.maxTurns = Math.max(1, options.maxTurns ?? 8);
    this.maxParallelCalls = Math.max(1, options.maxParallelCalls ?? 8);
    this.sessionId = options.sessionId ?? `provider-session-${randomUUID()}`;
    this.ledger = options.ledger ?? new ToolExecutionLedger();
    this.classifyTool = options.classifyTool ?? createToolClassifier(options.writeTools ? { writeTools: options.writeTools } : {});
  }

  get provider() { return this.providerName; }
  get modelProvider(): ModelProvider { return this.providers[this.providerName]!; }

  /** Cancel the current provider request and rebuild future turns with another provider. */
  switchProvider(name: string): void {
    if (!this.providers[name]) throw new ProviderError(`provider-unknown:${name}`);
    // A switch with an open tool turn would produce two adjacent unpaired turns. Aborted
    // turns are paired before their AbortError escapes, so a cancel-then-switch succeeds.
    if (!isToolHistoryComplete(this.history.snapshot())) throw new ProviderError('provider-switch-tool-turn-open');
    this.modelProvider.cancel();
    this.providerName = name;
  }

  async run(input: string | ModelMessage, options: ProviderSessionRunOptions = {}): Promise<{ response: ModelResponse; turns: ProviderSessionTurn[] }> {
    const { signal } = options;
    if (signal?.aborted) throw abortError();
    const startLength = this.history.length;
    this.history.append(typeof input === 'string' ? { role: 'user', content: input } : input);
    this.history.trim();
    const decisionId = options.decisionId ?? `${this.sessionId}:decision:${++this.decisionCounter}`;
    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (signal?.aborted) throw abortError();
      if (options.goalId && options.expectedRevision !== undefined && options.getGoalRevision) {
        const revision = options.getGoalRevision(options.goalId);
        if (revision !== options.expectedRevision) throw new Error(`goal-revision-conflict:${revision ?? 'missing'}`);
      }
      let response: ModelResponse;
      try {
        response = await this.modelProvider.complete(this.history.snapshot(), this.tools, signal);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        throw error;
      }
      const rawCalls = response.toolCalls?.length ? admitToolCalls(response, this.maxParallelCalls) : [];
      if (!rawCalls.length) {
        // FEC-41: a text-only assistant response is part of the conversation too.
        this.history.appendAssistant(response, this.providerName);
        this.history.trim();
        return { response, turns: this.turns };
      }

      const responseAttemptId = `${decisionId}:attempt:${turn + 1}`;
      const planned = this.planCalls(rawCalls, decisionId, responseAttemptId);
      // FEC-40: detect a changed name/arguments under the same logical id before the
      // assistant turn (or any tool result) is written into canonical history.
      for (const plan of planned) {
        const check = this.ledger.check(plan.logicalId, plan.call);
        if (check.status === 'conflict') {
          this.history.truncate(startLength);
          throw new ProviderError(`provider-tool-call-conflict:${plan.providerId}`);
        }
      }
      for (const plan of planned) this.usedToolCallIds.add(plan.call.id);
      this.history.appendAssistant({ ...response, toolCalls: planned.map(plan => plan.call) }, this.providerName);

      const results = new Map<string, unknown>();
      const executed: string[] = [];
      const replayed: string[] = [];
      const pending: PlannedCall[] = [];
      for (const plan of planned) {
        // Re-check after conflict preflight; the ledger cannot change in between, but this
        // keeps the replay decision and the history mutation in one deterministic pass.
        const check = this.ledger.check(plan.logicalId, plan.call);
        if (check.status === 'replay') { results.set(plan.call.id, check.result); replayed.push(plan.call.id); }
        else pending.push(plan);
      }

      const hasMutation = pending.some(plan => isMutationClass(this.classifyTool(plan.call)));
      let sawAbort = false;
      if (!hasMutation) {
        // Pure-read fan-out is bounded by admitToolCalls (maxParallelCalls, default 8) and
        // allSettled guarantees every outcome is represented even if one read throws.
        const settled = await Promise.allSettled(pending.map(plan => this.runCall(plan, signal, executed)));
        settled.forEach((outcome, index) => {
          const plan = pending[index]!;
          if (outcome.status === 'fulfilled') {
            results.set(plan.call.id, outcome.value.result);
            if (outcome.value.aborted) sawAbort = true;
          } else if (isAbort(outcome.reason) || signal?.aborted) {
            // A started read whose completion is unknown because the turn was canceled.
            results.set(plan.call.id, ambiguous());
            sawAbort = true;
          } else {
            results.set(plan.call.id, { ok: false, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
          }
        });
      } else {
        // Any write or control-write forces the whole batch through the ordered serial path;
        // otherwise a later read/write could interleave with an effectful call.
        for (let index = 0; index < pending.length; index++) {
          const plan = pending[index]!;
          if (signal?.aborted) {
            // Never started: the turn was canceled before this call.
            for (const rest of pending.slice(index)) results.set(rest.call.id, notExecuted());
            sawAbort = true;
            break;
          }
          const outcome = await this.runCall(plan, signal, executed);
          results.set(plan.call.id, outcome.result);
          if (outcome.aborted) {
            // The current call started and may have dispatched; all later calls never started.
            for (const rest of pending.slice(index + 1)) results.set(rest.call.id, notExecuted());
            sawAbort = true;
            break;
          }
        }
      }
      for (const plan of planned) {
        if (!results.has(plan.call.id)) results.set(plan.call.id, sawAbort ? notExecuted() : ambiguous());
      }

      // Atomic pairing: even when the turn was canceled, every assistant tool_call gets a
      // truthful result (not-executed/ambiguous) before the AbortError is rethrown.
      this.history.appendToolResults(planned.map(plan => plan.call), results);
      this.history.trim();
      this.turns.push({
        provider: this.providerName,
        response,
        replayed,
        executed,
        provenance: planned.map(plan => ({ internalId: plan.call.id, providerId: plan.providerId, name: plan.call.name, logicalId: plan.logicalId })),
      });
      if (sawAbort || signal?.aborted) throw abortError();
    }
    return { response: { stopReason: 'max-turns', text: '' }, turns: this.turns };
  }

  /**
   * Assign internal ids. Provider ids are allowed to repeat across responses, so a collision
   * is namespaced instead of being silently reused; the raw id stays in provenance.
   */
  private planCalls(rawCalls: ToolCall[], decisionId: string, responseAttemptId: string): PlannedCall[] {
    return rawCalls.map((call, index) => {
      const logicalId = ToolExecutionLedger.logicalId({ sessionId: this.sessionId, decisionId, responseAttemptId, toolCallId: call.id });
      const internalId = this.usedToolCallIds.has(call.id)
        ? `${call.id}#${this.sessionId}#${responseAttemptId}#${index}`
        : call.id;
      return { call: { ...call, id: internalId }, providerId: call.id, logicalId };
    });
  }

  private async runCall(plan: PlannedCall, signal: AbortSignal | undefined, executed: string[]): Promise<{ result: unknown; aborted: boolean }> {
    if (signal?.aborted) return { result: notExecuted(), aborted: true };
    try {
      const result = await this.execute(plan.call, signal);
      this.ledger.record(plan.logicalId, plan.call, result);
      executed.push(plan.call.id);
      return { result, aborted: false };
    } catch (error) {
      if (isAbort(error) || signal?.aborted) {
        // It started, but the cancellation means its effect may or may not have landed.
        // Record ambiguity so the same logical retry cannot pretend it was never sent.
        const result = ambiguous();
        this.ledger.record(plan.logicalId, plan.call, result);
        executed.push(plan.call.id);
        return { result, aborted: true };
      }
      // Tool failure is a tool result, not a provider failure; let the model see it.
      const failure = { ok: false, error: error instanceof Error ? error.message : String(error) };
      this.ledger.record(plan.logicalId, plan.call, failure);
      executed.push(plan.call.id);
      return { result: failure, aborted: false };
    }
  }
}
