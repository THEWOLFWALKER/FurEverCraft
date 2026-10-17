# FurEverCraft Phase 2.1 Convergence Delivery Report

## Status

C1, C2, and C3 convergence work is in progress. This report distinguishes implemented offline behavior from remaining integration work; it does not claim full completion from test counts. Real Minecraft servers/worlds, paid model APIs, Windows SendInput, and desktop capture were not used.

## Baseline and local commits

Starting implementation repository: `/home/orca/projects/furevercraft-phase2-handoff`.
Starting HEAD: `241f94b`, containing the earlier audit remediation commits.

Convergence commits currently present locally:

- `f0dd68a implement C1 runtime and provider consistency`
- `36981f7 implement C2 effect recovery persistence`
- `2eb776d integrate convergence verification and recovery lifecycle`

## Implemented in this convergence pass

### Shared foundation and C1

- Added `src/execution/factory.ts` as a central runtime assembly entry for bridge, Store, SessionRuntime, ToolRouter, Provider, AgentLoop, and Clock.
- Added bridge capability interfaces in `src/bridge/capabilities.ts` and moved several runtime/skill paths away from FakeClientBridge concrete typing.
- Added provider network gating to FetchTransport; production fetch is denied unless explicitly enabled.
- AgentLoop now works on a cloned history, carries canonical tool-call metadata, checks target revision when configured, and does not reorder the model's original tool-call list when executing writes.
- Added skill-specific strict argument validation.
- Added richer skill manifest metadata and injected-clock waiting support.
- Added provider serializer/network-gate tests.

### C2

- Added effect state validation and guarded transitions in SQLiteStore.
- Added pending/completed/unknown action receipt lifecycle and replay protection.
- Applied schema initialization and migration markers transactionally; added effect/checkpoint execution references and foreign-key behavior.
- Added SessionRuntime lifecycle states, owner/boot identity, recovery failure reporting, and retryable failure state.
- Recovery no longer uses inventory `< 8`; place reconciliation checks context, intent coordinates, and current target cell. Insufficient or mismatched evidence stays ambiguous.
- Added filtered EventHub cursor behavior and durable replay tests.
- Added `tests/unit/c2-recovery-events.test.ts` for receipts, recovery windows, context mismatch, no input replay, and durable/filtered events.

### C3 and Windows convergence

- Added `MinecraftBytePacketTransport` using the installed minecraft-protocol codec and a fragmented loopback byte transport fixture.
- Added test coverage from encoded packet bytes through fragmented transport to decoded protocol packet observation.
- ProtocolSession now tracks downstream and upstream phase fields while retaining a compatibility phase accessor.
- Composite provenance no longer promotes fixture source to client based only on observer presence; gap/degraded observations affect bridge limitations.
- CLI bridge supports `fixture`, `inspect`, and gated `live` modes. Live mode refuses unless explicit upstream permission exists and then reports unavailable real environment rather than pretending to connect.
- Windows driver/helper behavior was strengthened by earlier remediation commits: request ID matching, command ID dedup for text and pointer events, disabled cleanup path, binding/input checks, heartbeat and cleanup behavior.
- Added `bridge:protocol` npm script and CI invocations for demo, doctor, bridge fixture, and inspect.

## Verification actually run

Local environment: Linux, Node `v20.19.5`, npm `10.8.2`. Node 22 is configured in CI but has not been run locally.

At the current convergence checkpoint, the following passed:

```text
npm run typecheck
npm run build
npm run test:offline
npm run demo:offline
npm run doctor -- --profile simulated
node dist/cli/main.js bridge --mode fixture --config configs/simulated.json
node dist/cli/main.js bridge --mode inspect --config configs/client-offline.example.json
```

Latest full offline suite result at the time of this report:

```text
9 test files passed
42 tests passed
```

Six demo scenarios ran and were labelled simulated/fixture. The crash-recovery demo kept insufficiently evidenced work ambiguous.

## Remaining work before declaring C1/C2/C3 complete

### C1

- Finish the persistent readline console and documented command set.
- Ensure status/doctor operate on the same long-lived Runtime rather than constructing isolated reporting instances.
- Complete goal revision/decision-generation fencing for every write admission and late provider response.
- Add full OpenAI assistant `tool_calls`/tool `tool_call_id` and Anthropic assistant `tool_use`/user `tool_result` multi-turn request fixtures, including provider switching.
- Implement bounded 429/5xx retry budget with cancellation/deadline and no replay of already committed tools.
- Complete independent versioned knowledge rules and real PNG synthetic capture fixture.
- Ensure all demos exercise the RuntimeFactory → ToolRouter → Executor path rather than direct helper calls and descriptive labels.

### C2

- Integrate durable intent/dispatch permit and receipt into every external-effect skill at the actual dispatch boundary.
- Expand crash tests to cover intent persisted before dispatch, effect applied before receipt, observation before checkpoint, disk-write failure, stale checkpoint, repeated finalizer, old epoch and same-world reconnect.
- Confirm recovery query uses stable world/account/dimension candidate scope and separately validates new observer identity; never restore an old lease.
- Add goal/execution/checkpoint CAS and ensure stale finalizers cannot overwrite newer revisions.
- Verify EventHub boot cursor and durable event IDs remain distinct and filtered queries do not manufacture gaps.
- Ensure memory query is SQL-scoped, bounded and isolated by stable world/account/dimension.

### C3

- Complete public loopback bridge lifecycle with separate downstream listener and upstream connector using injected loopback endpoints; the current byte transport proves codec/framing fixtures but not a full proxy session.
- Drive phase changes from actual decoded packets/library events, not caller-set transitions.
- Add compression changes, split/coalesced frames, status-only flow, disconnect/error, backpressure and packet ownership/duplicate suppression tests.
- Normalize required packet families into domain observations with explicit availability and fixture provenance.
- Ensure Composite degradation blocks dependent actions after observation gaps and recovers only after explicit resync.
- Extract helper pre-native-call logic behind a no-op native sink so helper control flow is tested without SendInput or capture.
- On Linux, report Windows native sink execution as unavailable/unrun; do not substitute FakeHelperTransport-only evidence for helper branch evidence.

### Final verification

After the remaining work, rerun:

```bash
npm ci
npm run typecheck
npm run build
npm run test:offline
npm run demo:offline
npm run doctor -- --profile simulated
npm run bridge:protocol -- --config configs/simulated.json
node dist/cli/main.js bridge --mode inspect --config configs/client-offline.example.json
```

CI must run the same offline commands on Node 22. Record actual results, do not infer Node 22 success from the YAML definition.

## Testing premise rule

Every test must be based on a documented contract, observable behavior, or explicit fixture semantics. Do not assume fixture constants are real Minecraft facts, do not test a function against its own hard-coded return, do not assert asynchronous APIs synchronously, and do not weaken assertions or skip tests to force green. Failure review must first check the test premise and then the implementation. All DB tests use isolated temporary directories and cleanup. Provider tests use injected transports. Protocol tests use loopback endpoints without a game engine. Windows tests do not execute SendInput or desktop capture.

## Unverified boundaries

- No Minecraft server was started or contacted.
- No Minecraft world was joined.
- No paid OpenAI or Anthropic API was called.
- No Windows SendInput was executed.
- No desktop screenshot was captured.
- The local host used Node 20; Node 22 is only configured in CI until CI results are observed.
- Loopback codec tests do not establish live-server compatibility, full proxy correctness, or real-client behavior.
- Simulated two-dimensional navigation does not establish Minecraft three-dimensional movement behavior.
