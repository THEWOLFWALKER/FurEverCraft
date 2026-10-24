# FurEverCraft v0.2 Delivery Report — P01–P24, five review rounds complete

## Status

`main` at `c7815a2` contains the offline-verifiable P01–P24 implementation on Linux. All five review rounds required by `REVIEW.md` are complete: Round 1–2 at checkpoint `17cdf06`, Round 3 at `ee9eea7`, and Rounds 4–5 (run concurrently at the user's explicit request to speed up delivery) with their fixes on `f1c5f90`. A post-review independent audit (workflow) then produced additional truthful-behavior fixes in `c7815a2` (explore_area/start_skill fail-closed on legacy, real body release channel, observed preconditions, cancel/quit receipt truthfulness, provider non-success mapping, observer recovery/arm/shutdown truthfulness, capability advertisement narrowing, dead facade removal). The final full validation was re-run on `c7815a2`. P24 is `done-offline` for that scope.

Nothing here is a claim of live Minecraft 26.3, Windows, or paid-API compatibility. Real Minecraft servers/worlds, real Windows input/capture, game assets, and paid model APIs were not used. Local results use Node `v22.23.4` / npm `10.9.9` on Linux x86_64; cloud CI was not run or observed.

## What is actually runnable

- **CLI**: `demo`, `serve`, `attach`, `status`, `doctor`, `bridge` (fixture/inspect/service; live remains gated), `goal:revise`, `events`, `trace:export`, `trace:replay`.
- **HTTP control plane**: Fastify `/api/v1` reads/writes, local pairing (one-time 128-bit code, HttpOnly/SameSite session, CSRF), loopback/Host/Origin checks, CLI bearer, SSE snapshot/cursor/gap recovery, and the public non-secret `GET /api/v1/auth-mode`. Auth modes are `pairing` (default), `bearer-only` (`--no-pairing` with a CLI bearer; browser access disabled) and `loopback-open` (`--no-pairing` without a bearer). P24 adds authenticated `GET /api/v1/doctor`.
- **Web console**: React/Vite five-area control UI (overview, conversation, tasks, world, settings/diagnostics) served from the same ControlService as the CLI. In token/bearer-only mode it truthfully shows that browser access is disabled and directs the operator to the CLI bearer.
- **Runtime/bridge**: one RuntimeAssembly per storage path with cross-process owner lock; raw loopback TCP relay with read-only observer; framing/compression budgets and per-TCP-session observer epochs. The default `simulated` profile remains explicit legacy 2D; the public `simulated-3d` profile (`serve --profile simulated-3d`, `doctor --profile simulated-3d`) assembles the simulated BodyAdapter/Motor chain through the same ControlService and single Runtime. Neither is a real client. `serve --config` uses the strict loader, and `serve --provider openai|anthropic` is honored only with `allowModelNetwork: true` and an API key.
- **Diagnostics**: truthful doctor over the attached runtime/store; bounded trace export and side-effect-free replay.

## Final verification snapshot (HEAD `c7815a2`)

`main` at `c7815a2` (`fix(P24 final): truthful skills, control, bridge and docs after audit`), post-build so conditional child-process tests execute. The validation followed all Round 3–5 fixes and the post-review audit fixes. This documentation pass changes docs only. Node `v22.23.4` / npm `10.9.9`, Linux x86_64.

```text
npx tsc --noEmit              exit 0
npm run build                 exit 0
npm run test:offline          58 files / 601 tests passed, 0 skipped
npm run build:web             exit 0
npm run test:v:offline        integration 11 files / 71 tests passed
                              soak         2 files /  2 tests passed
                              diagnostics  2 files / 25 tests passed
                              total 98 tests passed
npm run test:web:e2e          9/9 Chromium tests passed (headless; no screenshots/video/trace)
npm run demo:offline          6/6 scenarios passed
npm run doctor                exit 0; truthful "degraded" default report (runtimeProfile simulated, body legacy-2d)
npm run doctor -- --profile simulated-3d
                              exit 0; runtime profile simulated-3d, body mode 3d, threeDimensional true, no live claim
```

Additional P24 checks: `npm run trace:export -- --db <tmp> --out <tmp>` exits 0 and writes a bounded trace from a fresh DB; `npm run trace:replay -- --file <tmp>` exits 0 with `contiguous: true`, `input: disabled`, `network: disabled`, `paidApis: disabled`, `sideEffects: not-resent`. The doctor integration test proves unauthenticated access is denied and an authenticated CLI bearer receives the same truthful P21 report. A real `serve --profile simulated-3d --no-pairing` process served a status document whose `body` was 3D, and `/api/v1/capabilities` listed the 3D skills; it was stopped and its temporary DB removed. The E2E suite also exercises a real compiled `serve --db` process, token/bearer-only mode, simulated-3d, pause and provider-unavailable feedback, and SSE reconnect without event loss.

No real Minecraft, paid model API, Windows input/capture, or CI run was used or observed.

## P01–P24 status summary

Full evidence paths and test counts are in `PROGRESS.md`; implementation/test locations are summarized here.

| Area | Tasks | Status |
|---|---|---|
| Foundation | P01–P04 | done-offline — single Runtime assembly, execution/effect barrier, atomic ownership, recovery budget |
| Bridge | P05–P09 | P05/P06/P09 done-offline; P07/P08 done-limited (26.3 data absent; synthetic projectors are test-only, labelled synthetic-only, and are not connected to relay/observer or WorldState) |
| Motion | P10–P13 | P10/P11 done-limited (3D contract + simulated Motor; some legacy 2D tools); public `simulated-3d` profile; P12/P13 done-offline (realtime control, simulated body) |
| Control/Agent | P14–P18 | P14–P16 done-offline (CLI, web, security/SSE); P17/P18 done-limited (injected provider transport, bounded skill lifecycle) |
| Knowledge/Diagnostics | P19–P21 | P19/P20 done-limited (fixture knowledge, bounded scoped memory with optional z); P21 done-offline (doctor/trace/replay) |
| Verification | P22/P23 | done-offline — real headless Playwright E2E with fixture body (9 tests); combined faults + 60 virtual-minute soak + wall-clock smoke |
| Finalization | P24 | done-offline — docs, trace scripts, doctor endpoint and all five review rounds complete; Rounds 4–5 ran concurrently per user instruction, their fixes are on `f1c5f90`, and post-review audit fixes with the current validation are on `c7815a2` |

## Exact 26.3 data gaps

The installed dependency tree does not provide verified Minecraft 26.3 codec/domain data. Concretely:

1. `minecraft-data@3.87.0` is installed, but `codecDataAvailable()` is false: there is no decodable `pc/26.3` version/protocol schema. No decoder was guessed or hand-written.
2. `configs/adapters/target-26.3.candidate.json` is a **candidate/unsupported** manifest. Its schema, data and native provenance entries are explicitly `verified: false`; candidate commit references are recorded but do not constitute installed 26.3 data.
3. Real 26.3 projectors are `unavailable` (`realProjectionAvailability()`); only synthetic contract projectors are assembled to verify the pipeline. There is no real 26.3 position/blocks/entities/inventory/chat/lifecycle decode.
4. Capability matrix is per-domain, not one `supported` flag: framing `verified-fixture`; compression `experimental` (synthetic, no live 26.3 control anchor); position `verified-fixture` (legacy 2D); chat `verified-fixture`; blocks/entities/inventory `unsupported` (missing schema/unknown item components); lifecycle `experimental`/synthetic.
5. Missing data includes item-component/void-codec semantics, chunk/light schemas, entityDelta/PositionPath real vectors, and verified 26.3 phase/compression transition anchors.
6. The Windows native helper is an unverified candidate (no real Windows host, no SendInput/capture), so native input provenance remains unverified even if the file/hash is recorded.
7. No vendor/codegen of the fixed candidate sources was performed; therefore no experimental real adapter was registered.

## External blocks (not code-completion substitutes)

- **No real Minecraft:** no real server, world, client login, or live interoperability. Relay/observer evidence is loopback-only, without a game engine.
- **No Windows input/capture:** the helper/driver is tested through injected transport and static/unit checks only; no real SendInput, SDL3 calibration, or desktop capture.
- **No paid model API:** OpenAI/Anthropic paths use injected transports/fixtures; all network/model gates default off. No real model request was made.
- **Motor is simulated only:** the 3D path has simulated-body evidence (walk/turn/stop/short jump); `stepUp`/`controlledDrop` remain disabled and there is no real 26.3 physics/terrain evidence.
- **E2E body is a fixture/simulated body:** P22 starts a real Fastify server, real Chromium and real CLI. Most flows use the legacy fake bridge; the simulated-3d flow uses the simulated 3D body and asserts the runtime profile/body. None is a Minecraft client. This is browser/control-flow evidence only.
- **No screenshots:** E2E explicitly disables screenshots, video and traces; no visual evidence is claimed.
- **CI unobserved:** Node 22 and Playwright pass locally, and the workflow defines a Playwright browser job, but cloud CI results are not known.

## Five-round completion and final verification

All five rounds in `REVIEW.md` were completed internally. Round 1–2 ended at checkpoint `17cdf06`; Round 3 ended at `ee9eea7`. At the user's explicit instruction, Round 4 and Round 5 were then run **concurrently on the same tree to accelerate delivery** instead of the default sequential order. Every finding accepted in those rounds was fixed (or recorded as the unchanged external 26.3 boundary) with fixes on `f1c5f90`; a post-review independent audit (workflow) then produced additional truthful-behavior fixes in `c7815a2`, and the final full validation was re-run on `c7815a2`; see the final verification snapshot above.

`REVIEW_SCOPE.md` remains the orientation document: architecture chains, P01–P24 status, review focus areas, known limitations, and the items that are deliberately unimplemented or externally blocked. The real 26.3 relay→decoder→projector→WorldState chain remains blocked on missing 26.3 schema/native/data; the current observer emits frame metadata only.

## Honest limits that must not be misreported

- A loopback fixture, synthetic projector, injected provider transport, or simulated body is **not** real-client/live evidence.
- `done-limited` is not equivalent to complete support: the stated limits (26.3 data, provider transport, skill scope) still apply.
- Local Node 22 passing does not mean CI ran; passing offline tests do not prove live Minecraft compatibility.
- No feature was silently removed from the batch; unavailable capabilities are explicit fail-closed surfaces with reasons.

## Testing discipline

Assertions target contracts or observable behavior; fixture provenance stays labelled. Async behavior is awaited, test databases use isolated temporary paths, and process/port/browser resources are cleaned up. Negative cases (auth denial, Origin rejection, cursor gaps, crash windows, ambiguous outcomes) are asserted. No assertion was weakened to force a green result. The P24 doctor test initially asserted that the pairing response itself never contains its CSRF token; that premise was wrong (the pairing response is designed to return it), so the assertion was corrected to scope secret checks to the doctor responses rather than weakening the implementation.

## Review Round 1

### State and coverage

- Start: `ccb9f8e` (`p24-final`, the worktree was first created at `c27dcfa` and fast-forwarded to this actual HEAD).
- Round 1 code/tests: `cf092ad`.
- End state: Round 1 checkpoint (historical; the final state is `c7815a2`).
- Environment: Linux x86_64, Node `v22.23.4`, npm `10.9.9`, offline only.

Whole-repo scan covered `src/**`, real CLI/server/web entrypoints, `tests/**`, `configs/**`, `package.json`, Playwright/CI/native-helper configuration, and the current docs. Diffs and symbol references were used for orientation, then the following chains were re-traced from source:

1. CLI/web → Fastify/readline → `ControlService.command` → one `RuntimeAssembly` (`createRuntime`); verified one owner, one store, one ControlService for serve/attach and browser.
2. Agent tool → `ToolRouter.invoke` → `Executor`/`InputArbiter` → skill/lifecycle → `MotionController`/`Motor3D` (or explicit legacy planar skill) → `BodyAdapter.submit`/bridge sink → simulated body observation.
3. socket → raw relay → observer worker/framing/bounded queue → observer events; checked what reaches projection/WorldState/tools (result below).
4. Side effect: `addEffect(prepared)` → dispatch report → `may-have-dispatched` barrier → skill result → effect settlement; restart path in `SessionRuntime.start`; control-command receipt lifecycle including write failures.

### Findings and decisions

| ID | Severity | Trigger / location | Actual impact | Decision and fix |
|---|---|---|---|---|
| R1-1 | High | Attach a 3D `BodyAdapter` to a bridge without legacy `walk`/`digBlock`/`findPlace`; call `navigate_to`/`gather_blocks`/`return_to_place`. `src/execution/admission.ts:36` (old lines 34–47) | Router advertised the 3D skills but admission rejected them with capability errors, so the production 3D chain only worked when a fake 2D bridge had the legacy methods. | **fixed** — adapter-aware capability gate; regression in `tests/integration/integration-wiring.test.ts` (`serves 3D navigation/gather/return...`). |
| R1-2 | High | Public entry `npm run serve` / web console. Old `src/cli/main.ts` always called `createRuntime` with no 3D adapter; Motor existed only in tests. | The only public runtime was explicit legacy 2D; the 3D Motor chain was not reachable from CLI/web. | **fixed** — public `simulated-3d` profile in `src/execution/factory.ts:29`, `:215`; CLI/doctor accept it; `createSimulatedBodyAdapter` at `src/fixtures/body-adapter.ts:263`. Verified by starting real `serve --profile simulated-3d` and reading `/api/v1/status` (3D body) and `/api/v1/capabilities`. Still simulated, not a client. |
| R1-3 | High | `start_skill collect_nearby` through `ToolRouter`; `src/agent/router.ts:233` old side-effect list | Inventory-changing work ran without a durable `prepared`/`may-have-dispatched` effect, so a crash or retry could lose the only evidence of the side effect. | **fixed** — collect added to the effect set with intent `collect`; regression (`persists a durable dispatch barrier for collect_nearby`) checks effect status/barrier. |
| R1-4 | High | 3D gather returns accepted but `collected: 0`/no items, while the target cell is free; `src/skills/navigation.ts:234`, `src/skills/skills.ts:189`, `src/agent/router.ts:384` | Previously reported `confirmed` with `gathered: 1` (missing count defaulted to 1) and returned `ok: true` for partial/ambiguous suspended executions. Free cell was treated as pickup; failures looked successful. | **fixed** — require positive consistent collection evidence, preserve partial, and return `ok: false` unless status is `succeeded` + outcome `confirmed`; regression (`does not confirm a 3D dig without collection evidence`). |
| R1-5 | Medium | Attached 3D body; `get_inventory`, `capture_view`, `ControlService.status`. `src/agent/router.ts:152`, `:184`; `src/control/service.ts:111`–`145` | Tool/UI could read the legacy fake bridge's inventory, UI, cells and snapshot fields as if they were the 3D body; a failing legacy snapshot could make the 3D status unknown. This was a silent 2D fallback. | **fixed** — 3D inventory from the adapter (or explicit `inventory-unavailable`), capture revision from the 3D observation, and 3D status no longer reads the bridge snapshot or exposes legacy cells/UI; regressions in integration-wiring. |
| R1-6 | Medium | 3D `return_to_place` using a remembered place with z; `src/autonomous/memory.ts:144`, `:252` | Places only stored x/y, so 3D return always targeted the current y and world z came only from planar mapping. | **fixed** — optional finite z preserved through memory and the resolver; regression returns the body to z=4. |
| R1-7 | Medium | `SQLiteStore.addActionReceipt`/`updateActionReceipt` throws; `src/control/service.ts:233`, `:250` | A failed pending-receipt write returned `accepted/in-flight` for work that never started; a failed completion write returned `terminal` even though no durable receipt existed. | **fixed** — `unknown` with `receipt-unavailable` / `receipt-write-failed`; two control-service regressions assert no goal write and pending receipt respectively. |
| R1-8 | Medium | Non-default `nav`/`motor` passed to `createRuntime`; `src/execution/factory.ts`, `src/motor/controller.ts:65`, `:323` | Both injection seams were decorative: custom nav was not consulted, and `MotionController` always constructed `Motor3D` directly. | **fixed** — nav passed into skill context for the planar path, and `MotorFactory` wired through `MotionController.executeStep`; regressions assert the injected nav and Motor factory are used. |
| R1-9 | Low | Default legacy `simulated` profile; tool `find_skills`/`availableSkills`; public `navigate_to` schema requires x/y/z. `src/agent/router.ts:104` | `navigate_to` was advertised on the legacy profile but always failed with `body-adapter-unavailable`/argument errors; the catalog overstated capabilities. | **fixed** — legacy profile no longer advertises navigate_to, `find_skills` filters by the same available set, and admission rejects it; regression (`does not advertise navigate_to on the legacy profile...`). |
| R1-10 | High (external boundary) | `src/bridge/observer/bounded.ts:254` emits frame metadata only; `src/bridge/protocol/projection-pipeline.ts` is used only by tests; `WorldState` has no runtime producer. | No production socket→projection→WorldState/tools chain exists. The relay/observer can forward and report framing state, but there is no decoded 26.3 packet payload to project. | **blocked-external** — missing verified 26.3 schema/native/data and decodable packet payloads; the pipeline is explicitly test-only and the docs were corrected (`REVIEW_SCOPE.md`). No fake projection was wired. Remaining P08 work; see the 26.3 gaps above. |

No finding was dismissed as false-premise. The only external block remains the real 26.3 decode/projection boundary; live client/server/Windows/API evidence is still outside the authorized environment.

### Targeted verification

- `npm run typecheck` — pass after each fix set.
- `npx vitest run --config vitest.config.ts tests/integration/integration-wiring.test.ts tests/unit/control-service.test.ts` — pass (34 tests at that point; the file now has 23 integration tests).
- `npx vitest run --config vitest.config.ts tests/integration/integration-wiring.test.ts tests/unit/p10-p13.test.ts` — 58 tests pass.
- `npm run test:offline` — **46 files / 394 tests pass** (Round 1 checkpoint, historical).
- `npm run test:v:offline` — integration **10 files / 56 tests**, soak **2 files / 2 tests**, diagnostics **2 files / 15 tests** pass (Round 1 checkpoint, historical).
- `npm run build` — pass; `node dist/cli/main.js doctor --profile simulated-3d` reports a simulated 3D body and no live claim.
- Public-entry smoke: real `serve --profile simulated-3d --no-pairing` process; `/api/v1/status` returned `body.mode: "3d"`, `threeDimensional: true`, `z: 0.5`, and `/api/v1/capabilities` listed the 3D skills. Process and temporary DB were cleaned up.
- Full standard checks (`build:web`, `test:web:e2e`, `demo:offline`, default `doctor`) were rerun after the fixes; results are in the verification snapshot above.

### Remaining affected tasks

- At Round 1 time P24 was still in progress; it is now `done-offline` after Rounds 2–5, the post-review audit fixes and the final `c7815a2` validation.
- P08 remains **done-limited / externally blocked** for real 26.3 projection; the observer emits no typed packet payload, and synthetic projectors are not a production substitute.
- P02/P03/P11/P13/P20 moved from the previously limited/injected-only state to an explicit public `simulated-3d` assembly; they remain simulated evidence, not real-client validation.
- The `simulated-3d` fixture body and the legacy fake bridge can still carry separate state for legacy-only tools (place/look/chat); this is documented as a fixture limitation, not production capability.

## Review Round 2

### State and coverage

- Start: `033f29a` (`p24-final`, Round 1 merged), Worktree `agent-a19cecd12f9b7c9d1`, clean.
- Round 2 code/tests: `b6d7f42`.
- End state: Round 2 checkpoint `17cdf06` (historical; the final state is `c7815a2`).
- Environment: Linux x86_64, Node `v22.23.4`, npm `10.9.9`, offline only. No real Minecraft, Windows input/capture or model API was used.

Whole-repo review, with the following chains re-traced and fault-injected:

1. **Control command → durable receipt → execution → skill/body.** Claim/replay races, pause/resume/stop/quit, abort propagation, lifecycle generations, lease release, held-input release, terminal-state protection.
2. **Crash/restart recovery.** Ownership lock acquisition/reclaim, pending receipts, prepared/may-have-dispatched/ambiguous effects, incomplete snapshots, execution settlement, recovery budget and scope isolation.
3. **Bridge service → relay/observer/helper.** IPC backpressure/overflow, worker failure, helper exit, relay restart budget, admission/control revocation and its effect on the Runtime.
4. **Supervisor → child lifecycle.** IPC shutdown, SIGTERM graceful stop, bounded exit grace, force-kill escalation and shutdown deadlines.
5. **Cancellation paths.** `wait_for_condition` timers, 3D route pause/disconnect/target-revision CAS, watchdog double-settlement and stale owner/release fencing.
6. **Persistence boundaries.** Prepared-write failure vs may-have-dispatched, barrier writes, receipt vs observation confirmation, `unknown` preservation and no implicit rollback.
7. **World/account/dimension fencing.** Recovery scope matching, memory scope, lease context key and body-adapter context validation.

### Findings and decisions

| ID | Severity | Trigger / location | Actual impact | Decision and fix |
|---|---|---|---|---|
| R2-1 | High | Operator sends `stop`, then `pause`, then a replayed `resume`. `src/control/service.ts:285` | `pause` cleared `stopping`, so `resume` passed the "stopped wins" guard and cleared `paused`; the already-closed scheduler could then admit model/tool work again and body writes were no longer gated by the stopped state. | **fixed** — `pause` no longer clears `stopping`; stop/quit remain terminal. Regression in `tests/unit/p24-round2.test.ts` asserts stopping/paused stay set and resume/message stay rejected. |
| R2-2 | High | Relay/observer/helper failure or IPC control loss with a `BridgeService` attached. `src/execution/factory.ts`, `src/execution/admission.ts`, `src/bridge/service/orchestrator.ts` | The service set `admissionOpen=false`/`controlRevoked=true`, but the Runtime never consulted that state: new writes were admitted and in-flight skills kept driving the body after control was lost. | **fixed** — bridge-service events now reach the Runtime (`BridgeService.on`); `ExecutionAdmission` rejects with `control-revoked`, `Executor` inputs close, `executor.cancelAll` aborts active work and `SkillLifecycle.humanControl` advances the generation. Regression: unarmed service blocks a place, armed service allows it, helper crash cancels a long wait and blocks the next write. |
| R2-3 | Medium | Process dies with an execution in `queued`/`running`/`stopping`/`verifying`; the database is reopened. `src/execution/session.ts` | Executions stayed "running" forever after recovery; proposal-id dedupe returned the stale row, the UI/doctor reported live work, and only an explicit cancel could settle it. | **fixed** — recovery suspends non-terminal executions as `suspended`/`ambiguous` with `recovered-after-restart`, never `succeeded`. The current executor's active set is excluded via `isExecutionActive`, so a live run is not clobbered. Regressions cover both cases. |
| R2-4 | Medium | Process dies after writing a `pending` command receipt but before committing its result. `src/persistence/store.ts`, `src/execution/factory.ts` | A replay after restart returned `accepted` for work no process was doing, and the receipt stayed pending forever. | **fixed** — a new owner settles all leftover pending receipts as `unknown` before commands can be replayed; failures fail runtime construction rather than replaying accepted. Regression seeds a pending receipt, reopens the runtime and asserts `unknown` with no re-execution. |
| R2-5 | Medium | Same server/world/dimension, different account. `src/contracts/index.ts`, `src/execution/session.ts`, `src/execution/admission.ts`, `src/agent/router.ts`, `src/control/service.ts` | `BodyContext` had no account identity, so recovery could treat another account's pending effect as its own; memory scope and command receipts also omitted the account. | **fixed** — optional `accountId` is part of the context schema, same-context/world-scope comparisons, admission, body-adapter validation, memory scope and command receipt scope. Regression proves a foreign-account effect is neither reconciled nor suspended and that memory scope carries the account. |
| R2-6 | Medium | Dimension/server change while a lease is held. `src/execution/runtime.ts`, `src/execution/factory.ts` | The arbiter's context epoch omitted dimension, server profile and account, so a dimension switch did not invalidate the lease at the arbiter boundary (only the per-dispatch admission check caught it). | **fixed** — `leaseContextEpoch` includes server, account, world, dimension and both epochs; regression exercises a dimension change and the fencing key. |
| R2-7 | Medium | `start_skill wait_for_condition` with a long deadline, then pause/stop/cancel. `src/skills/skills.ts`, `src/agent/router.ts` | The wait was a bare scheduled timer: abort only flipped predicates, so the execution stayed non-terminal until the deadline, the timer kept the process alive after quit, and the closed store could be written later. | **fixed** — skill context carries an abort signal (executor + lifecycle combined); the wait resolves `canceled` on abort, cancels its timer, and the router removes fired/canceled timer entries. Regressions cover skill-level abort and a long wait canceled by pause. |
| R2-8 | Medium | Graceful shutdown exceeds the deadline; relay child receives shutdown. `src/bridge/service/orchestrator.ts`, `src/bridge/supervisor.ts`, `src/bridge/relay/entry.ts` | The service reported `stopped` without escalating, so a hung child could be orphaned; the supervisor sent an IPC shutdown and immediately killed the relay child, so in-flight relay flush/close did not run; the relay entry had no SIGTERM graceful path. | **fixed** — deadline now invokes optional `forceStop` escalation; the supervisor waits a bounded exit grace before killing; the relay entry handles SIGINT/SIGTERM by running its graceful stop. Regressions cover responsive-exit (no kill), ignored-shutdown (kill after grace) and deadline escalation. |
| R2-9 | Low | Long uptime with many skill runs/executions. `src/skills/lifecycle.ts`, `src/execution/runtime.ts` | Finished skill-run snapshots and per-execution progress maps grew without bound. | **fixed** — bounded retention (256 terminal runs, 512 progress entries, active entries never evicted); regression drives 300 runs/520 executions and checks the bounds. |
| R2-10 | Low | Crash between creating the lock path and writing its record. `src/execution/ownership.ts` | With an exclusive create + write, a crash in that window could leave an empty lock that the safety rule (never delete an unknown lock) makes unreclaimable, blocking all future owners. | **fixed** — the complete record is written/fsynced to a private temp file and published with an atomic hard link; `EEXIST` still refuses, unknown/foreign locks are still never deleted, and no partial lock path is observable. Regression checks complete contents and no temp residue. |

No finding was dismissed as false-premise. One behavior was deliberately retained: a pre-existing **external** empty/unknown lock file is still refused rather than deleted, because it cannot be positively identified as a dead same-host owner's record; an operator must remove it. PID reuse on the same host is likewise not detectable from a PID alone, so a recycled PID can conservatively block an owner until the stale file is removed.

### Targeted verification

- `npx vitest run --config vitest.config.ts tests/unit/p24-round2.test.ts tests/unit/p01-p04.test.ts tests/unit/supervisor.test.ts` — 44 tests pass (Round 2 regressions + ownership/supervisor).
- `npm run typecheck` — pass.
- `npm run build` — pass (dist rebuilt so child-process tests execute).
- `npm run build:web` — pass (Vite 5.4.11).
- `npm run test:offline` — **47 files / 409 tests pass** (Round 2 checkpoint, historical).
- `npm run test:v:offline` — integration **10 files / 56 tests**, soak **2 files / 2 tests**, diagnostics **2 files / 15 tests** pass (Round 2 checkpoint, historical).
- `npm run test:web:e2e` — 2 Chromium tests pass (Round 2 checkpoint, historical; final suite has 9).
- `npm run demo:offline` — 6/6 scenarios pass; crash-recovery still leaves the ambiguous effect pending rather than promoting it.
- `npm run doctor` — exit 0, truthful `degraded`; `npm run doctor -- --profile simulated-3d` — exit 0, simulated 3D body, no live claim.

### Remaining affected tasks

- At Round 2 time P24 was still in progress; it is now `done-offline` after Rounds 3–5, the post-review audit fixes and the final `c7815a2` validation.
- P08/P10/P11/P17/P18/P19/P20 remain `done-limited`/externally blocked exactly as recorded above; Round 2 changed lifecycle/fencing behavior but did not create 26.3 decode or live evidence.
- No new external block was introduced. The bridge-service control gate is test-verified; a production attachment still needs its operator/observation arming step, which is the existing P09 contract.

## Review Round 3

### State and coverage

- Start: `17cdf06` (Round 1–2 checkpoint).
- Round 3 code/tests ended at `ee9eea7`.
- End state for the whole batch: `c7815a2` after Rounds 4–5, the post-review audit fixes and the final validation.
- Environment: Linux x86_64, Node `v22.23.4`, npm `10.9.9`, offline only.

Whole-repo review across `src/**`, entrypoints, tests, configs, scripts and current docs. The end-to-end chains re-traced for this round were:

1. socket → relay → observer worker → framing/compression → bounded queue → observation events, including overflow, stop/restart and IPC control.
2. synthetic observation envelope → projection pipeline → WorldState → tool-visible consumer, including scope, epoch, sequence and gap handling; real 26.3 decode remains unavailable.
3. adapter candidate manifest → artifact provenance → capability matrix → runtime/profile gate.
4. control command → scoped execution/receipt → recovery/dedupe → stable-scope reads → SSE.
5. provider request/stream → canonical history → tool-call pairing → retry/abort → knowledge query scope.
6. CLI/web entry → auth/pairing/redaction → strict config → bridge/service startup and truthful capabilities.

### Findings and decisions

| Severity | Theme | Finding and actual impact | Decision |
|---|---|---|---|
| High | Observer truthfulness and recovery | Observer state was not per-TCP-session, compression could be reported as `disabled` when it was actually unknown, and stopped directions could still emit. An operator/consumer could treat guessed framing as real. Per-session contexts/epochs, `unknown` compression, start/stop recovery, stopped-direction suppression and per-direction park anchoring were enforced. | fixed |
| High | Relay/service control and IPC | Attach/ack queues and lifetimes were not fully bounded; `send() === false` was treated as rejection although it means queued; arm could be accepted during an overflow episode; relay/service children inherited more environment than needed; the handshake limit could bound more than the handshake frame; service capabilities and non-ready CLI state were not truthful. Queues, deadlines, arm refusal, env allowlists, handshake scoping and readiness/capability reporting were corrected. | fixed |
| High | Projection and WorldState fencing | Stale/old-epoch snapshots, non-advancing sequences, gaps and foreign accounts could influence consumer state; unknown nested variable-length data could be silently stripped; resync anchors were not scope/epoch-bound. Scope binding, anti-replay resync validation, recursion-safe rejection, account scope and bounded dedupe were added. | fixed |
| High | Adapter manifest trust | Capability/provenance declarations could be accepted without matching installed artifacts. Content/hash/role/version verification, data-identity checks, path containment (absolute/traversal/symlink) and fail-closed options were enforced; an all-unsupported matrix is never reported as available. | fixed |
| High | Control/data scope isolation | Goals, executions, effects, events, places, memories and SSE snapshots could leak across stable scopes; receipt scope omitted world/dimension; recovery/proposal dedupe could cross accounts; memory timestamps used a monotonic uptime clock. Stable-scope filtering, durable execution context, scoped recovery/dedupe, world/dimension receipt scope, wall-clock timestamps and pagination/bounded reads were added. | fixed |
| Medium | CLI, pairing and secret handling | Pairing codes were shorter than the stated strength, empty codes were accepted, failed attempts were not per-source locked out, utility commands could create a fake runtime instead of taking ownership/read-only, attach doctor was not authenticated, child env was broad, and redaction missed pairing/session identifiers. 128-bit codes, empty-code rejection, lockout, ownership/read-only utility paths, authenticated attach doctor, minimal child env, redaction and explicit non-TTY pairing requirements were implemented. | fixed |
| High | Provider and knowledge validation | Malformed/truncated provider responses could look like terminal success; streamed tool-call ids/arguments were not fully validated; the write ledger persisted across runs; abort could leave incomplete tool groups; provider switching and canonical history needed bounded, paired trimming; knowledge lacked runtime scope/validity/conflict handling. Response/truncation rejection, per-run ledger reset, complete abort results, switchable providers with canonical history, scope injection and bounded group eviction were added. | fixed |
| Medium | Motor/skills/Windows gates | `INPUT_SKILLS` and advertised skills were not consistently derived from manifests, so `explore_area` could escape the input gate or legacy 2D could advertise world-3D skills; Windows capabilities were not derived from driver/capture/dry-run state; capture gating was not independent across composite/driver/helper. Manifest-derived skills, fail-closed unknown skills, legacy advertisement filtering, derived Windows capabilities, dry-run default and independent capture gates were implemented. | fixed |
| High (external boundary) | Real 26.3 projection | The relay/observer still emit frame metadata only; no verified 26.3 schema/native/data exists to decode payloads and feed the real projection/WorldState chain. The synthetic observer→pipeline→consumer assembly test was explicitly labelled synthetic-only rather than implying production evidence. | blocked-external — missing 26.3 schema/native/data; no fake decode was wired |

The recorded Round 3 outcomes are fixed and blocked-external; no false-premise outcome was recorded. All fixed items above were verified by targeted regressions; the real 26.3 boundary is the only external block.

### Targeted regressions

- `tests/unit/p24-round3-adapter.test.ts` — artifact/provenance/hash/path verification and fail-closed profile gate.
- `tests/unit/p24-round3-cli-security.test.ts` — ownership/read-only utility commands, minimal child env, pairing/session redaction, non-TTY pairing code and 128-bit codes.
- `tests/unit/p24-round3-config.test.ts` — strict config keys, bridge target/gate semantics, arm reporting, service readiness and Node/CI ordering.
- `tests/unit/p24-round3-data.test.ts` — wall-clock memory, stable-scope reads/SSE, receipt world/dimension, execution/goal isolation, runtime-profile reporting and bounded diagnostics.
- `tests/unit/p24-round3-observer.test.ts` — compression truthfulness, sticky global gaps, bounded host accounting and relay backpressure.
- `tests/unit/p24-round3-projection.test.ts` — per-direction uncertainty, resync/epoch fencing, nested unknown rejection, WorldState sequence/gap/account fencing.
- `tests/unit/p24-round3-provider.test.ts` — response shape/truncation, streamed tool-call ids, per-run ledger, abort pairing, provider switch, bounded history and sliding retry.
- `tests/integration/synthetic-observation-chain.test.ts` — synthetic-only assembly, stale epoch/gap fencing and forged-provenance refusal.

The authoritative full-suite counts are the final `c7815a2` snapshot above.

## Review Round 4

### State and coverage

- Start: after the Round 3 checkpoint `ee9eea7`.
- Executed **concurrently with Round 5 at the user's explicit instruction to speed up delivery**; both rounds operated on the same working tree.
- End state: fixes on `f1c5f90`; post-review audit fixes and final validation on `c7815a2`.
- Environment: Linux x86_64, Node `v22.23.4`, npm `10.9.9`, offline only.

Coverage focused on real user flows and test credibility across the serving CLI, browser console, headless E2E, strict configs, bridge fixtures and CI workflow: pairing and bearer modes, SSE recovery, pause/stop feedback, provider-unavailable turns, simulated-3d rendering, isolated `serve --db` processes, gateway truthfulness and process cleanup after failed startup.

### Findings and decisions

| Severity | Theme | Finding and actual impact | Decision |
|---|---|---|---|
| High | Serve config/provider gate | `allowModelNetwork: true` without a provider could start a scripted provider while implying network capability, and provider selection without the gate could never be honored. The gate is now non-inert: open gate without a provider fails (`model-provider-required`), provider without the gate fails (`model-network-gate-disabled`), missing key fails, and startup reports effective provider metadata. | fixed |
| Medium | Browser auth-mode truthfulness | In bearer-only mode the browser could show a pairing workflow that could never succeed. A public non-secret `/api/v1/auth-mode` exposes `pairing` / `bearer-only` / `loopback-open`; token mode now shows “browser access disabled; use the CLI bearer” and keeps unauthenticated reads/writes refused. | fixed |
| Medium | SSE, pause and provider feedback | Reconnect behavior could be asserted without proving cursor retention/no loss; pause could allow new work to appear accepted; provider-unavailable turns could look like a green terminal receipt. E2E now asserts a retained non-zero cursor with no event loss, visible pause rejection and a provider warning. | fixed |
| Medium | User-flow/test credibility | The serving flow was previously exercised mostly through harness code. A real compiled `serve --db` process is now tested with isolated DB/port and clean shutdown; simulated-3d E2E asserts runtime profile and 3D body; the synthetic projection chain is marked synthetic-only. | fixed |
| Medium | Bridge fixture/config ergonomics | The default bridge command depended on a config that cannot run fixture mode, and the fixture/protocol scripts were not clearly separated. A dedicated `configs/bridge-fixture.example.json` and `bridge:fixture` script were added; `bridge:protocol` remains the version/protocol inspection path; fixture mode always uses the loopback echo target and never the configured real target. | fixed |
| Medium | CI ordering and browser coverage | Dist-dependent integration tests could skip when `dist/` was absent, and the workflow did not define a browser E2E job. The workflow builds before those tests and defines a Playwright Chromium job. This is a workflow definition only; CI was not run/observed. | fixed |

The recorded Round 4 outcomes are fixed; no false-premise outcome was recorded. Live 26.3, Windows and paid-model behavior remain blocked-external as before; no Round 4 change claims them.

### Targeted regressions

- `tests/unit/p24-round4-cli.test.ts` — merged `--db` handling, non-inert model gate, failed-startup release of lock/listeners, and default bridge fixture.
- `tests/e2e/control-flow.spec.ts` — token/bearer-only mode and public auth-mode, real compiled `serve --db` flow, simulated-3d profile/body, pause rejection, provider warning and SSE reconnect cursor retention.

The authoritative full-suite counts are the final `c7815a2` snapshot above.

## Review Round 5

### State and coverage

- Start: after the Round 3 checkpoint `ee9eea7`, sharing the tree with Round 4.
- Executed **concurrently with Round 4 at the user's explicit instruction to speed up delivery**.
- End state: fixes on `f1c5f90`; post-review audit fixes and final validation on `c7815a2`.
- Environment: Linux x86_64, Node `v22.23.4`, npm `10.9.9`, offline only.

Independent re-read of the whole system after the earlier fixes, emphasizing cross-round regressions, observer lifecycle/epochs, IPC semantics, projection resync fencing, skill/input gating, capability/profile reporting, resource bounds and final build artifacts.

### Findings and decisions

| Severity | Theme | Finding and actual impact | Decision |
|---|---|---|---|
| High | Observer per-session isolation and recovery | Two concurrent TCP sessions, or a later sequential session, could inherit observer epochs/frames; attach backpressure could leave a recovered observer without a fresh host/epoch; ack tracking could measure absolute post time rather than progress; a direction stopped by backpressure could still produce observations. Per-session context/epoch isolation, fresh host/epoch recovery, progress-based ack deadlines and stopped-direction suppression were enforced. | fixed |
| High | IPC queued-vs-rejected semantics | `send() === false` means queued, not rejected. Treating it as failure produced false gaps/overflow and could reject a request that was actually sent once. Publisher, supervisor and service paths now treat false as queued exactly once; arm is refused during an active overflow/unknown episode and re-revoked after a later drop. | fixed |
| High | Projection scope and resync anti-replay | A pipeline could bind to the first projection without rejecting a later different account/world/dimension/server profile; non-decimal or non-advancing resync anchors could move the fence. Scope binding now rejects differing scopes, and resync anchors must be decimal and advancing. | fixed |
| High | Input-skill gating | `INPUT_SKILLS` could miss a manifest-declared input skill (`explore_area`) or admit an unknown skill; legacy 2D could advertise world-3D skills. Skills are derived from manifests, unknown skills fail closed, `explore_area` is gated, and legacy 2D advertisement is filtered. | fixed |
| Medium | Capability/profile truthfulness | `runtimeProfile` was conflated with `serverProfileId`; Windows capabilities were not derived from driver enabled/capture/dry-run state; capture gating was not independent at composite/driver/helper. Reporting is now separated, capabilities are derived, dry-run is the default, and capture gates are independent. | fixed |
| Medium | Service command/start truthfulness | Service capabilities could report hardcoded profile/network/target; observer commands with no observer could look supported; start failure could be reported as success. Capabilities now report the real configured values, unsupported commands are explicit, and the CLI fails when the service never reaches a usable state. | fixed |
| Medium | Handshake and global-park bounds | The handshake limit could apply beyond the handshake frame, and a global park could resume an un-anchored direction after only one direction reset. The limit is scoped to the handshake frame, and both directions stay parked until each is anchored. | fixed |
| High (external boundary) | Real 26.3/live evidence | No real 26.3 decode/projection or live client/server/Windows/model evidence exists in this batch. The scope/anti-replay fixes harden the synthetic path only; they do not create real packet payloads. | blocked-external — missing 26.3 schema/native/data and prohibited live environment |

The recorded Round 5 outcomes are fixed and blocked-external; no false-premise outcome was recorded. All fixed items were covered by targeted regressions, and the final full validation was executed after the post-review audit fixes on `c7815a2`.

### Targeted regressions

- `tests/unit/p24-round5-observer.test.ts` — concurrent/sequential session isolation, recovered observer epoch, ack progress, queued-vs-rejected IPC, arm refusal, stopped directions, global park anchoring and service capability truthfulness.
- `tests/unit/p24-round5-input-gate.test.ts` — manifest-derived input skills, fail-closed unknown skills, `explore_area` gating and legacy-2D advertisement filtering.
- `tests/unit/p24-round3-projection.test.ts` — scope binding and resync anti-replay checks added during the Round 5 pass.
- Final run on `c7815a2`: typecheck, build, build:web, 58 files / 601 offline tests, 98 versioned/soak/diagnostics tests, 9/9 E2E, 6/6 demo, and both doctor profiles. See the final snapshot above.
