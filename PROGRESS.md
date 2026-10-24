# FurEverCraft v0.2 Progress — P01–P24

Current authorization: `NEXT_BATCH.md` P01–P24, with the five-round review contract in `REVIEW.md`. Design authority: `docs/design/*-v0.2.md`. Status vocabulary: `done-offline`, `done-limited`, `blocked-external`, `not-done` (in-progress work is `not-done` until its acceptance is met).

**Scope of these results:** offline Linux only. No real Minecraft server/world, Windows input, desktop capture, paid model API, or live 26.3 client interoperability was used. Node 22 is the locally verified runtime (`v22.23.4`, npm `10.9.9`, Linux x86_64); cloud CI was not run or observed.

## Final verification snapshot (HEAD `f1c5f90`)

Final branch/HEAD: `main` at `f1c5f90` (`fix(P24 rounds 3-5): enforce scope, recovery, gates and truthful reporting`). The built `dist/` is present so conditional child-process tests execute. The run was serial and followed all Round 3–5 fixes. This documentation pass changes docs only.

| Command | Actual result |
|---|---|
| `npx tsc --noEmit` | pass (exit 0) |
| `npm run build` | pass (exit 0) |
| `npm run test:offline` | **58 files / 578 tests passed**, 0 skipped |
| `npm run build:web` | pass (exit 0) |
| `npm run test:v:offline` | integration **11 files / 71 tests**, soak **2 files / 2 tests**, diagnostics **2 files / 25 tests** — **98 tests**, all passed |
| `npm run test:web:e2e` | **9/9 Playwright Chromium tests passed**, headless, no screenshots/video/trace |
| `npm run demo:offline` | **6/6 scenarios** completed (`autonomous`, `obstruction`, `human-steering`, `chat-ui`, `crash-recovery`, `bridge-fixture`) |
| `npm run doctor` | exit 0; truthful `status: "degraded"` for the default simulated/legacy-2D runtime; no live claims |
| `npm run doctor -- --profile simulated-3d` | exit 0; runtime profile `simulated-3d`, body 3D; never a client claim |

P24 now includes `tests/integration/p24-doctor.test.ts`, the authenticated doctor endpoint, Round 1–5 fixes and the final consistency pass. Round history: Round 1–2 checkpoint `17cdf06`; Round 3 `ee9eea7`; Rounds 4–5 plus fixes on `f1c5f90`. Rounds 4 and 5 were run concurrently at the user's explicit request to speed up delivery; a full post-fix validation then ran on `f1c5f90`.

## Current profile status

| Profile | Status | Notes |
|---|---|---|
| `simulated` | done-limited | Default profile; explicit legacy 2D. Used by demo/E2E and some legacy tools; not a 3D or real client |
| `simulated-3d` | done-limited | Public 3D assembly with the simulated BodyAdapter/Motor chain; `runtimeProfile` reported separately; no real 26.3 physics/client |
| `client-offline` | done-limited | Config/assembly path exists and fails closed without a real client body/upstream; real client use is blocked-external |

## P01–P24 status

| Task | Status | Implementation evidence | Verification evidence |
|---|---|---|---|
| P01 gap mapping | done-offline | Task→entry/module/test map in this file and `REVIEW_SCOPE.md`; the original 500/208-item list is not in the repo, so no item IDs were invented | documented mapping; no fabricated issue numbers |
| P02 single Runtime assembly | done-offline | `src/execution/factory.ts` — one explicit `RuntimeDependencies` container (Clock/Store/Events/Provider/Body/Nav/Motor); `simulated-3d` public profile; client profile fails closed; single owner | `tests/unit/p01-p04.test.ts`, `tests/integration/integration-wiring.test.ts` |
| P03 execution/effect boundary | done-offline | `src/execution/admission.ts`, `src/agent/router.ts` — revision/owner/epoch/capability checks before prepare and dispatch; durable may-have-dispatched barrier; terminal states protected; partial is not success | `tests/unit/p01-p04.test.ts`, `tests/integration/v01-v04.integration.test.ts`, `tests/integration/s01-s14-acceptance.test.ts`, `tests/integration/integration-wiring.test.ts` |
| P04 ownership/recovery | done-offline | `src/execution/ownership.ts` atomic cross-process lock; `src/execution/session.ts` recovery budget/retry/scope isolation | `tests/unit/p01-p04.test.ts`, `tests/unit/c2-recovery-events.test.ts` |
| P05 raw TCP relay | done-offline | `src/bridge/relay/**` — lifecycle, bounded pre-connect buffering, bidirectional byte equality, backpressure, half-close, deterministic stop | `tests/unit/raw-relay.test.ts` (19), `tests/integration/relay-child.test.ts`, Round 5 observer tests |
| P06 framing/compression | done-offline | `src/bridge/observer/framing.ts`, `bounded.ts` — bounded VarInt/frame length, zlib inflate limits, per-direction phase/compression state, unknown on ambiguity | `tests/unit/framing-compression.test.ts` (18), `tests/unit/bounded-observer.test.ts`, `tests/unit/p24-round3-observer.test.ts` |
| P07 adapter import/capability matrix | done-limited | `src/bridge/adapter/manifest.ts`, `configs/adapters/target-26.3.candidate.json` — per-domain `verified-fixture`/`experimental`/`unsupported`; artifact hash/role/version and path containment checked; **limit: no verified 26.3 schema/native/data** | `tests/unit/adapter-manifest.test.ts` (10), `tests/unit/p24-round3-adapter.test.ts` |
| P08 domain projection | done-limited | `src/bridge/protocol/projectors/**`, `projection-pipeline.ts` — synthetic assembly for position/blocks/entities/inventory/chat/lifecycle; scope/epoch/gap fencing; **limit: real 26.3 projectors `unavailable`; synthetic chain is test-only and explicitly labelled synthetic-only** | `tests/unit/p08-projection.test.ts` (14), `tests/unit/domain-projection.test.ts`, `tests/integration/synthetic-observation-chain.test.ts` |
| P09 process orchestration | done-offline | `src/bridge/service/**`, `src/bridge/supervisor.ts` — supervision, IPC bounds, restart budget, owner revoke, graceful shutdown; **limit: Windows helper is static/injected only and was not launched on a real host** | `tests/unit/p09-service.test.ts`, `tests/integration/bridge-service-child.test.ts`, `tests/integration/p23-process-faults.test.ts` |
| P10 3D body contract | done-limited | `src/motor/contracts.ts` — async BodyAdapter/Observation/InputSink; `Legacy2DBodyAdapter` explicit; **limit: `place_one`/`look_at`/`dig_one` remain legacy 2D** | `tests/unit/m01-m05.test.ts`, `tests/unit/p10-p13.test.ts` |
| P11 navigation→Motor | done-limited | `src/skills/navigation.ts`, `src/motor/controller.ts` — 3D A* and route execution validated before dispatch; public `simulated-3d` profile; injected Motor factory; **limit: simulated body** | `tests/unit/p10-p13.test.ts`, `tests/integration/integration-wiring.test.ts` |
| P12 realtime control | done-offline | `src/motor/controller.ts`, `src/execution/runtime.ts` (`InputArbiter`/`Executor`) — monotonic clock, budget, progress/deviation checks, lease release on pause/stop/disconnect | `tests/unit/p10-p13.test.ts` |
| P13 independent offline body | done-offline | `src/fixtures/body-adapter.ts`, `src/fixtures/simulated-body.ts` — non-zero z, head obstruction, steps/edges, yaw, bounded jump; **limit: simulated control loop only** | `tests/unit/p10-p13.test.ts`, `tests/e2e/control-flow.spec.ts` |
| P14 attach CLI | done-offline | `src/cli/main.ts` — real readline attach, pairing/bearer, status/goals/pause/resume/stop/cancel/chat/events/quit; authenticated attach doctor | `tests/integration/cli-attach.test.ts` (2), E2E attach cases |
| P15 web main workflow | done-offline | `web/src/**` — five areas, truthful unknown/gap states, all writes through the shared ControlService; token mode shows browser access disabled | `tests/e2e/control-flow.spec.ts` (9), `tests/unit/p14-p16.test.ts` |
| P16 security/SSE consistency | done-offline | `src/server/index.ts` — pairing, HttpOnly/SameSite session, CSRF, loopback/Host/Origin, CLI bearer, static confinement, SSE watermark/gap; public non-secret `/api/v1/auth-mode` | `tests/integration/p16-security.test.ts` (10), `tests/integration/server.test.ts` (6), E2E auth-mode/SSE cases |
| P17 provider multi-turn/switch | done-limited | `src/providers/**` — canonical history, tool pairing, SSE framing, bounded retry, cancellation, network gate; response/truncation and streamed tool-call validation; **limit: injected transport only** | `tests/unit/providers-p17.test.ts` (11), `tests/unit/p24-round3-provider.test.ts` |
| P18 skills/scheduler | done-limited | `src/skills/lifecycle.ts`, `src/skills/registry.ts`, `src/autonomous/tasks.ts` — lifecycle, interruption, prerequisites, partial/ambiguous semantics; **limit: bounded scheduler/lifecycle evidence, not live long-run proof** | `tests/unit/skills-p18.test.ts` (10) |
| P19 knowledge wiring | done-limited | `src/autonomous/knowledge.ts` — versioned manifest/release, fixed-release query, coverage/conflicts, validity windows, scope-aware conflicts, bounded results; **limit: fixture sources, no 26.3 corpus** | `tests/unit/knowledge-p19.test.ts` (11) |
| P20 spatial/episodic memory | done-limited | `src/autonomous/memory.ts`, `src/persistence/store.ts` — scoped places/episodes/experiences, optional z for 3D return targets, wall-clock freshness, bounded/paginated reads; **limit: fixture/simulated scope evidence** | `tests/unit/memory-p20.test.ts` (7), `tests/integration/integration-wiring.test.ts` |
| P21 doctor/trace/replay | done-offline | `src/diagnostics/doctor.ts`, `src/diagnostics/trace.ts`, `src/control/service.ts` `diagnostics()`; `trace:export`/`trace:replay` CLI; authenticated `GET /api/v1/doctor` | `tests/diagnostics/doctor.test.ts` (11), `tests/diagnostics/trace.test.ts` (14), `tests/integration/p24-doctor.test.ts`, diagnostics suite (25) |
| P22 Playwright E2E | done-offline | `tests/e2e/**`, `playwright.config.ts` — pairing, goal, execution, effects, cancel, pause/resume, SSE reconnect, token mode, simulated-3d, provider warning; browser+CLI share one Runtime; **limit: simulated/fixture body** | 9/9 Chromium tests passed; no screenshot/video/trace |
| P23 fault combinations/soak | done-offline | `tests/unit/p23-fault-combinations.test.ts`, `tests/unit/p23-provider-motor.test.ts`, `tests/integration/p23-process-faults.test.ts`, `tests/soak/p23-fault-soak.test.ts` — child crashes, slow observer, IPC backpressure, write failures, provider/Motor faults; 60 virtual minutes + short wall-clock smoke | 4 integration tests, 1 soak test, combined-fault units |
| **P24 final consistency + five reviews** | **done-offline** | Trace npm scripts, authenticated `/api/v1/doctor` plus integration test, current docs, Rounds 1–5 fixes. Rounds 4–5 ran concurrently per user instruction; final fixes landed in `f1c5f90`. **Offline scope only** | `package.json`, `src/server/index.ts`, `tests/integration/p24-doctor.test.ts`, `tests/unit/p24-round2.test.ts`, `p24-round3-*`, `p24-round4-cli`, `p24-round5-*`; full validation above |

## P24 completion record

- The worktree was initially created from the P01–P04 lineage (`c27dcfa`), then fast-forwarded to the `p24-final` review start `ccb9f8e`; the Round 1–2 checkpoint is `17cdf06`.
- The P24 documentation/consistency items completed before Round 1 were the missing `trace:export`/`trace:replay` npm scripts, authenticated `GET /api/v1/doctor`, its integration test, and truthful updates to `CLAUDE.md`, `PROGRESS.md`, `WORKSTREAM.md` and `DELIVERY_REPORT.md`.
- Round 1 fixed the public 3D wiring, capability routing, effect/receipt gaps and 3D/2D state leaks. Round 2 fixed stop/pause terminality, bridge-service control enforcement, crash-restart execution/receipt settlement, account/dimension fencing, abort-aware waits, graceful child shutdown and bounded retention.
- Round 3 completed at `ee9eea7` and fixed observer/relay truthfulness and recovery, projection/manifest trust, scope isolation, provider/knowledge validation, config strictness and CLI/security issues.
- Rounds 4 and 5 were executed **concurrently on the same tree at the user's explicit instruction to speed up delivery**. Round 4 covered user flows and test credibility (auth-mode/SSE/pause/provider UX, real `serve --db`, config/provider gate, bridge fixtures, CI ordering); Round 5 independently re-read the system after the earlier fixes and covered per-session observer recovery, IPC/arm semantics, projection resync fencing, input-skill gating and capability reporting.
- All Round 3–5 findings were fixed; the final serial validation on `f1c5f90` is the snapshot above. P24 is `done-offline` for this offline scope and is not evidence of live 26.3, Windows or paid-model compatibility.

## Review rounds

| Round | Status | Notes |
|---|---|---|
| Round 1 — completeness/real wiring | done-offline | Completed 2026-10-24; whole-repo scan and four chain traces; 9 findings fixed, 1 external projection boundary documented; see `DELIVERY_REPORT.md` |
| Round 2 — concurrency/crash/lifecycle | done-offline | Completed 2026-10-24; whole-repo chain trace with injected ordering/failures; 10 findings fixed; checkpoint `17cdf06`; see `DELIVERY_REPORT.md` |
| Round 3 — protocol/data/permissions | done-offline | Completed at `ee9eea7`; observer/relay, projection/manifest, control/data scope, provider/knowledge and config/CLI/security fixes |
| Round 4 — user flows/test credibility | done-offline | Run concurrently with Round 5 per user instruction; auth-mode/SSE/pause/provider UX, real `serve --db`, strict config/provider gate, bridge fixtures, CI ordering |
| Round 5 — final independent reread/regression | done-offline | Run concurrently with Round 4 per user instruction; per-session observer recovery, IPC/arm semantics, projection scope/anti-replay, input-skill and capability truthfulness; final checks on `f1c5f90` |

## Known limits and external blocks

- **26.3 data unavailable (P07/P08):** installed `minecraft-data@3.87.0` has no decodable 26.3 version/protocol data. Candidate profile metadata exists, but decoders/domain adapters stay fail-closed; no field guessing.
- **Real 26.3 projection unavailable (P08):** only synthetic contract projectors are assembled in tests. The relay/observer emit frame metadata only; no decoded packet payload exists to feed the projection pipeline or WorldState, so that production chain is blocked on 26.3 schema/native/data rather than claimed. The synthetic assembly test is labelled synthetic-only.
- **No live environment:** relay/observer only run on loopback without a game engine; no real server/world/client compatibility claim.
- **Windows unverified (P09):** helper/driver use injected transport and static/unit checks; no real SendInput or screen capture. Native helper provenance remains unverified.
- **No paid model API (P17):** OpenAI/Anthropic paths use injected transports/fixtures; network gates default off. `serve --provider` is validated only with the gate open and a key present; no real model request was made.
- **Motor is simulated only (P10/P11/P13):** no real 26.3 physics/terrain evidence; `stepUp`/`controlledDrop` remain disabled; P22 E2E body is a fixture.
- **Legacy and 3D profiles are separate:** default `simulated` remains explicit legacy 2D; `simulated-3d` assembles the same runtime with a simulated 3D body/Motor. `{x,y}` is never promoted to real 3D, and 3D status no longer exposes legacy bridge cells/inventory/UI. `runtimeProfile` is reported separately from `serverProfileId`.
- **P18 skill scope:** lifecycle and scheduler behavior is bounded offline evidence; no live long-run scheduling claim.
- **P19 knowledge scope:** fixture sources only; no 26.3 corpus, and conflicts/validity are evaluated within that fixture scope.
- **P20 memory scope:** scoped spatial/episodic memory is offline fixture/simulated evidence; no real-world place validation.
- **P23 soak is virtual time:** 60 virtual minutes proves budget/resource bounds, not long-term live stability; the short wall-clock smoke is separate.
- **E2E evidence is browser/control-flow only:** 9 headless Chromium tests use a fixture/simulated body, never a Minecraft client; screenshots/video/trace are disabled.
- **Bridge-service control is explicit:** an attached `BridgeService` starts with admission closed (existing P09 contract); an operator/observation step must arm control before body writes. `--arm` is refused during an overflow/unknown episode.
- **Account identity is not guessed:** `accountId` participates in recovery, memory, receipts and fencing when the body context provides it; current simulated/fixture profiles omit it, so cross-account claims stay unknown rather than being inferred.
- **Auth/config behavior is explicit:** default `serve` uses pairing; `--no-pairing` plus a CLI bearer is bearer-only with browser access disabled; `--no-pairing` without a bearer is loopback-open development mode. Non-TTY `serve` requires an explicit pairing code. `serve --config` rejects unused keys.
- **CI not observed:** Node 22 local checks pass and the workflow defines a Playwright browser job, but cloud CI has not been run/observed.

See `DELIVERY_REPORT.md` for the exact 26.3 gap list, round findings and final verification snapshot.
