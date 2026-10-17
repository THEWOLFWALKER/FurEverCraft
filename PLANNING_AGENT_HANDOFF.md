# Phase 2 Remediation Handoff for Planning Agent

## Purpose

This handoff summarizes the implementation and review work completed after the 200-item static audit of `THEWOLFWALKER/FurEverCraft`. It is intended for a planning agent that will continue work without rereading the entire repository first.

Repository: `/home/orca/projects/furevercraft-phase2-handoff`
Remote: `https://github.com/THEWOLFWALKER/FurEverCraft`
Current local branch: `main`

## Baseline and commits

The original audit target was `main@712008be77ad4f1278f9beb5deb5e47200522428`.

The current local convergence history includes:

- `f0dd68a` — C1 runtime/provider consistency and RuntimeFactory
- `36981f7` — C2 effect recovery persistence
- `762280e` — C3 loopback protocol and bridge gates
- `2eb776d` — convergence verification, recovery lifecycle, CI and report alignment

Earlier remediation commits remain in the same ancestry:

- `fdda759` — audited runtime/provider/bridge safety fixes
- `24756f1` — async test premise corrections
- `ea69461` — remediation evidence update
- `241f94b` — planning-agent handoff document

The current code branch is local `main` at `2eb776d`. Remote publication status must be checked separately; a local commit is not evidence of a pushed, merged, deployed, or live-verified state.

## Verification performed after remediation

Environment:

- Linux
- Node `v20.19.5`
- npm `10.8.2`
- Target CI runtime: Node 22

Commands run successfully:

```text
npm run typecheck
npm run build
npm run test:offline
npm run demo:offline
npm run doctor -- --profile simulated
```

Current test result:

```text
8 test files passed
30 tests passed
```

Demo result:

- `autonomous`
- `obstruction`
- `human-steering`
- `chat-ui`
- `crash-recovery`
- `bridge-fixture`

The demo output is explicitly marked `simulated: true`; crash recovery keeps an unresolved effect `ambiguous` when evidence is insufficient.

## Confirmed fixes implemented

### Executor and skills

Files:

- `src/execution/runtime.ts`
- `src/agent/router.ts`
- `src/skills/skills.ts`
- `src/skills/registry.ts`
- `src/execution/session.ts`

Changes:

- Tool write paths now construct/use `Executor` instead of directly calling navigation/place/UI mutations.
- Executor accepts and awaits async skill handlers.
- Skill outcomes are inspected; failed/canceled outcomes do not become confirmed success.
- Execution ownership token prevents an old watchdog/finalizer from releasing or overwriting a newer owner.
- Cancel checks persisted execution state and avoids overwriting terminal executions.
- Proposal hashing now recursively canonicalizes nested objects and arrays.
- InputArbiter tracks resource-specific invalidation instead of invalidating unrelated leases on every acquire.
- Start-skill schemas are skill-specific and strict:
  - `navigate_to` and `place_one` require finite integer `x/y`;
  - `send_chat` requires non-empty `text`;
  - `wait_for_condition` requires finite non-negative integer `ms`;
  - `observe_ui` rejects unrelated fields.
- Router returns `ok: false` for failed, canceled, or ambiguous write execution results.
- Recovery no longer uses the fixed `inventory < 8` heuristic. Place reconciliation checks effect intent, target coordinates, target cell state, and context match; insufficient evidence remains ambiguous.

### Provider protocol handling

Files:

- `src/providers/openai/index.ts`
- `src/providers/anthropic/index.ts`
- `src/providers/scripted/index.ts`
- `tests/unit/providers.test.ts`

Changes:

- SSE parsing uses one UTF-8 decoder across the complete byte stream.
- Byte-split UTF-8 and fragmented SSE records are covered by injected offline fixtures.
- OpenAI tools are mapped to Chat Completions `type=function` / `function` schema.
- Anthropic tools are mapped to `name` / `description` / `input_schema`.
- OpenAI tool fragments are assembled by tool-call index.
- Anthropic tool fragments are assembled by content-block index.
- Provider stream error events become `ProviderError` instead of being treated as successful partial output.
- Abort propagation and stream cancellation remain injected and offline-testable.
- Provider tests use fake transports; no external API is called.

### AgentLoop message association

Files:

- `src/agent/router.ts`
- `src/providers/scripted/index.ts`

Changes:

- Provider-neutral message type now carries optional `toolCalls` and `toolCallId`.
- AgentLoop preserves assistant tool-call metadata.
- Tool results include their originating `toolCallId`.
- AgentLoop checks AbortSignal after tool execution before adding the next message turn.

Remaining caveat: provider-specific full assistant/tool message serialization and target-revision fencing still need deeper integration tests and may require another implementation pass.

### Windows helper/driver

Files:

- `src/bridge/windows/driver.ts`
- `native/windows/FurEverCraft.Helper.ps1`
- `src/bridge/composite.ts`
- `tests/unit/windows-driver.test.ts`

Changes:

- Driver response validation stores a local request ID, avoiding the global sequence race under concurrent requests.
- `typeText` now participates in command-ID deduplication.
- Mouse/text commands are marked completed only after transport success.
- Helper transport close rejects pending requests.
- Disabled cleanup operations are handled explicitly; capture/input commands remain gated.
- Driver validates command IDs and finite numeric inputs.
- Async tests now use `await`/`rejects` where the API is asynchronous, avoiding false premises.
- Tests use `FakeHelperTransport`; no PowerShell, SendInput, User32, or screenshot operation executes.

Remaining caveat: helper-side independent watchdog, full native click semantics, and real Windows identity/capture behavior remain unverified in this Linux environment.

### Testing premise rule

Files:

- `TESTING_RULE.md`
- `CLAUDE.md`

Rule now requires every test to be grounded in a contract, observable behavior, or explicitly declared fixture semantics. Tests must not:

- treat fixture constants as real-client facts;
- test a function against its own hard-coded return value;
- assume an async operation is synchronous;
- weaken assertions or silently skip failures;
- claim fixture evidence as real Minecraft/Windows/API proof.

## Static audit classification guidance

The 200-item audit mixes different categories. The planning agent should not treat all 200 entries as confirmed runtime bugs.

### Confirmed or high-confidence defects addressed in this pass

- Executor/ToolRouter write-path bypass.
- Incorrect fixed-inventory recovery confirmation.
- Async Executor callback not awaited.
- Terminal cancellation overwrite risk.
- Global lease-generation invalidation of unrelated resources.
- Nested proposal hash instability.
- Windows concurrent request-ID validation race.
- Missing Node-side `typeText` deduplication.
- Provider UTF-8/SSE chunk handling.
- Provider tool schema shape mapping.
- Missing tool-call ID preservation in AgentLoop messages.
- Incorrect synchronous test assumptions in execution and Windows tests.

### Confirmed or high-confidence defects still requiring work

- CLI `bridge` currently has limited production/fixture lifecycle wiring and must not report configuration echo as real forwarding.
- CLI still lacks the complete interactive readline command set required by `DECISIONS.md`.
- The protocol implementation remains primarily a structured packet fixture; it is not evidence of a real TCP Minecraft proxy.
- `OfflineProtocolBridge` phase/ownership semantics need separate upstream/downstream state and stronger packet ownership handling.
- `CompositeClientBridge` source provenance and capability degradation on observation gaps need explicit implementation/tests.
- `ToolRouter` still depends on `FakeClientBridge` rather than a bridge-neutral read/write interface.
- `send_chat` still needs a real dispatch receipt / confirmed-versus-ambiguous contract; UI mode switching alone is not delivery confirmation.
- Executor verification/effect-ledger coupling is still incomplete for all side-effect skills.
- Recovery must be made context-safe and transactional across all pending effect states.
- WorldState field TTL, initial sequence gaps, immutable notifications, and sticky unknown semantics need deeper tests and implementation.
- SQLite state transitions, revision CAS, context-scoped reads, effect monotonicity, and receipt immutability need stronger guards.
- EventHub durable/volatile cursor semantics and filtered-gap calculation need dedicated tests.
- Provider network gate (`allowModelNetwork`) and bounded retry budget are not fully wired into provider construction.
- AgentLoop goal-revision fencing, immutable message history, original call ordering, and full provider-specific assistant/tool serialization need work.
- CI should run demo, doctor, and bridge fixture commands in addition to typecheck/build/unit tests.
- Fixed `/tmp` database usage in legacy runtime tests should be replaced with isolated temporary directories and cleanup.

### False premise / not a defect by itself

- Fixture source being `fixture` is correct for fixture transport. The defect is only when Composite or a report upgrades it to `client`/real evidence.
- Lack of a real Minecraft server/client test is an explicit offline boundary, not a failure to run prohibited tests.
- Lack of real Windows SendInput/screenshot execution is an environment limitation and must remain unverified, not faked green.
- Simulated two-dimensional navigation is not expected to prove real three-dimensional Minecraft physics.
- The audit's numeric ranges cannot be independently mapped to source because no numbered 001–200 source list exists in the repository; use the audit text plus code/contract evidence rather than inventing a mapping.

## Remaining work before declaring the convergence complete

1. Add a per-audit-item classification table: fixed, confirmed-unfixed, design-gap, false-premise, unverified, or test-gap.
2. Finish bridge-neutral runtime injection so ToolRouter can use Composite/real-profile capability interfaces without direct FakeClientBridge coupling.
3. Complete effect ledger/action receipt lifecycle for chat and place, including ambiguous dispatch and recovery.
4. Implement full CLI runtime assembly and readline command semantics; make bridge command execute a real fixture lifecycle and validate config with Zod.
5. Add provider-specific assistant/tool message serializers and goal-revision fencing.
6. Harden WorldState, SQLite CAS/state transitions, EventHub cursor/gap semantics, and context scoping.
7. Expand tests by behavior, not by arbitrary count; every test must document its premise and provenance.
8. Extend Node 22 CI with demo/doctor/bridge fixture checks.
9. Run a second static review and update `DELIVERY_REPORT.md` only with verified claims.

## Hard boundaries

Do not connect a real Minecraft server, start a real game server, call paid model APIs, execute Windows SendInput, or claim fixture results are real-client proof. Keep all offline tests on injected transports and temporary isolated state.
