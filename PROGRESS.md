# FurEverCraft v0.2 Progress — P01–P24

Current authorization: `NEXT_BATCH.md` P01–P24, with the five-round review contract in `REVIEW.md`. Design authority: `docs/design/*-v0.2.md`. Status vocabulary: `done-offline`, `done-limited`, `blocked-external`, `not-done` (in-progress work is `not-done` until its acceptance is met).

**Scope of these results:** offline Linux only. No real Minecraft server/world, Windows input, desktop capture, paid model API, or live 26.3 client interoperability was used. Node 22 is the locally verified runtime (`v22.23.4`, npm `10.9.9`); cloud CI was not observed.

## Verification snapshot (2026-10-24)

P01–P23 merged baseline: `a2d216e` (`p24-final`), with the built `dist/` present so conditional child-process tests execute.

| Command | Actual result |
|---|---|
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm run build:web` | pass (Vite 5.4.11, 32 modules) |
| `npm run test:offline` | **45 files / 383 tests passed**, 0 skipped (post-build run) |
| `npm run test:v:offline` | integration **9 files / 47 tests**, soak **2 files / 2 tests**, diagnostics **2 files / 15 tests** — all passed |
| `npm run test:web:e2e` | **1 spec file / 2 Playwright Chromium tests passed** (~19 s, headless, no screenshots/video/trace) |
| `npm run demo:offline` | **6/6 scenarios** completed (`autonomous`, `obstruction`, `human-steering`, `chat-ui`, `crash-recovery`, `bridge-fixture`) |
| `npm run doctor` | exited 0; truthful `status: "degraded"` for the default simulated/legacy-2D runtime; no live claims |

P24 work in this worktree adds `tests/integration/p24-doctor.test.ts` and the authenticated doctor endpoint (`0dd7bfc`; docs updated on this branch). After those additions the same commands report **46 files / 384 tests** offline and **10 files / 48 tests** integration; soak, diagnostics and E2E counts are unchanged. The P01–P23 counts above remain the evidence baseline for the merged branch.

## P01–P23 status

| Task | Status | Implementation evidence | Verification evidence |
|---|---|---|---|
| P01 gap mapping | done-offline | Task→entry/module/test map in this file and `REVIEW_SCOPE.md`; the original 500/208-item list is not in the repo, so no item IDs were invented | documented mapping; no fabricated issue numbers |
| P02 single Runtime assembly | done-offline | `src/execution/factory.ts` — one explicit `RuntimeDependencies` container (Clock/Store/Events/Provider/Body/Nav/Motor), fail-closed client profile, single owner | `tests/unit/p01-p04.test.ts`, `tests/integration/integration-wiring.test.ts` |
| P03 execution/effect boundary | done-offline | `src/execution/admission.ts`, `src/agent/router.ts` — revision/owner/epoch/capability checks before prepare and dispatch; durable may-have-dispatched barrier; terminal states protected | `tests/unit/p01-p04.test.ts`, `tests/integration/v01-v04.integration.test.ts`, `tests/integration/s01-s14-acceptance.test.ts` |
| P04 ownership/recovery | done-offline | `src/execution/ownership.ts` atomic cross-process lock; `src/execution/session.ts` recovery budget/retry/scope isolation | `tests/unit/p01-p04.test.ts`, `tests/unit/c2-recovery-events.test.ts` |
| P05 raw TCP relay | done-offline | `src/bridge/relay/**` — lifecycle, bounded pre-connect buffering, bidirectional byte equality, backpressure, half-close, deterministic stop | `tests/unit/raw-relay.test.ts` (18), `tests/integration/relay-child.test.ts` |
| P06 framing/compression | done-offline | `src/bridge/observer/framing.ts`, `bounded.ts` — bounded VarInt/frame length, zlib inflate limits, per-direction phase/compression state, unknown on ambiguity | `tests/unit/framing-compression.test.ts` (18), `tests/unit/bounded-observer.test.ts` |
| P07 adapter import/capability matrix | done-limited | `src/bridge/adapter/manifest.ts`, `configs/adapters/target-26.3.candidate.json` — per-domain `verified-fixture`/`experimental`/`unsupported`; no verified 26.3 schema/native/data | `tests/unit/adapter-manifest.test.ts` (9) |
| P08 domain projection | done-limited | `src/bridge/protocol/projectors/**`, `projection-pipeline.ts` — synthetic assembly for position/blocks/entities/inventory/chat/lifecycle; real 26.3 projectors `unavailable` | `tests/unit/p08-projection.test.ts` (14), `tests/unit/domain-projection.test.ts` |
| P09 process orchestration | done-offline (relay/observer child process; Windows helper not launched) | `src/bridge/service/**`, `src/bridge/supervisor.ts` — supervision, IPC bounds, restart budget, owner revoke, graceful shutdown | `tests/unit/p09-service.test.ts`, `tests/integration/bridge-service-child.test.ts`, `tests/integration/p23-process-faults.test.ts` |
| P10 3D body contract | done-limited | `src/motor/contracts.ts` — async BodyAdapter/Observation/InputSink; `Legacy2DBodyAdapter` explicit; `place_one`/`look_at`/`dig_one` remain legacy 2D | `tests/unit/m01-m05.test.ts`, `tests/unit/p10-p13.test.ts` |
| P11 navigation→Motor | done-limited (simulated body) | `src/skills/navigation.ts`, `src/motor/controller.ts` — 3D A* and route execution validated before dispatch | `tests/unit/p10-p13.test.ts`, `tests/integration/integration-wiring.test.ts` |
| P12 realtime control | done-offline | `src/motor/controller.ts`, `src/execution/arbiter.ts` — monotonic clock, budget, progress/deviation checks, lease release on pause/stop/disconnect | `tests/unit/p10-p13.test.ts` |
| P13 independent offline body | done-offline (simulated control loop only) | `src/fixtures/body-adapter.ts`, `src/fixtures/simulated-body.ts` — non-zero z, head obstruction, steps/edges, yaw, bounded jump | `tests/unit/p10-p13.test.ts`, `tests/e2e/control-flow.spec.ts` |
| P14 attach CLI | done-offline | `src/cli/main.ts` — real readline attach, pairing/bearer, status/goals/pause/resume/stop/cancel/chat/events/quit | `tests/integration/cli-attach.test.ts` (2) |
| P15 web main workflow | done-offline | `web/src/**` — five areas, truthful unknown/gap states, all writes through the shared ControlService | `tests/e2e/control-flow.spec.ts` (2), `tests/unit/p14-p16.test.ts` |
| P16 security/SSE consistency | done-offline | `src/server/index.ts` — pairing, HttpOnly/SameSite session, CSRF, loopback/Host/Origin, CLI bearer, static confinement, SSE watermark/gap | `tests/integration/p16-security.test.ts` (6), `tests/integration/server.test.ts` (6) |
| P17 provider multi-turn/switch | done-limited (injected transport only) | `src/providers/**` — canonical history, tool pairing, SSE framing, bounded retry, cancellation, network gate | `tests/unit/providers-p17.test.ts` (11) |
| P18 skills/scheduler | done-limited | `src/skills/lifecycle.ts`, `src/skills/registry.ts`, `src/autonomous/tasks.ts` — lifecycle, interruption, prerequisites, partial/ambiguous semantics | `tests/unit/skills-p18.test.ts` (10) |
| P19 knowledge wiring | done-limited (fixture sources; no 26.3 corpus) | `src/autonomous/knowledge.ts` — versioned manifest/release, fixed-release query, coverage/conflicts, bounded results | `tests/unit/knowledge-p19.test.ts` (9) |
| P20 spatial/episodic memory | done-limited | `src/autonomous/memory.ts`, `src/persistence/store.ts` — scoped places/episodes/experiences, freshness, bounded pages | `tests/unit/memory-p20.test.ts` (7) |
| P21 doctor/trace/replay | done-offline | `src/diagnostics/doctor.ts`, `src/diagnostics/trace.ts`, `src/control/service.ts` `diagnostics()`; `trace:export`/`trace:replay` CLI; authenticated `GET /api/v1/doctor` added in P24 | `tests/diagnostics/doctor.test.ts` (8), `tests/diagnostics/trace.test.ts` (7), `tests/integration/p24-doctor.test.ts` |
| P22 Playwright E2E | done-offline (real server/browser; simulated body) | `tests/e2e/**`, `playwright.config.ts` — pairing, goal, execution, effects, cancel, pause/resume, SSE reconnect; browser+CLI share one Runtime | 2 Chromium tests passed; no screenshot/video/trace |
| P23 fault combinations/soak | done-offline | `tests/unit/p23-fault-combinations.test.ts`, `tests/unit/p23-provider-motor.test.ts`, `tests/integration/p23-process-faults.test.ts`, `tests/soak/p23-fault-soak.test.ts` — child crashes, slow observer, IPC backpressure, write failures, provider/Motor faults; 60 virtual minutes + short wall-clock smoke | 4 integration tests, 1 soak test, combined-fault units |
| **P24 final consistency + five reviews** | **not-done (in progress)** | P24 adds trace npm scripts, authenticated `/api/v1/doctor` plus integration test, and current docs; review rounds not started | `package.json`, `src/server/index.ts`, `tests/integration/p24-doctor.test.ts`; review table below |

## P24 status at start of this work

- Worktree was reset from the accidentally supplied P01–P04 lineage (`c27dcfa`) to the actual `p24-final` HEAD `a2d216e`, which contains merged P01–P23.
- At the start, **zero of the five review rounds from `REVIEW.md` had been completed**, so P24 remains `not-done`.
- The P24 documentation/consistency items completed here are: missing `trace:export`/`trace:replay` npm scripts, authenticated `GET /api/v1/doctor`, its integration test, and truthful updates to `CLAUDE.md`, `PROGRESS.md`, `WORKSTREAM.md`, `DELIVERY_REPORT.md`.
- Still owed by P24: the five full review rounds (one at a time, findings fixed before the next), any fixes they produce, the post-round final consistency pass, and the final standard-check rerun.

## Review rounds

| Round | Status | Notes |
|---|---|---|
| Round 1 — completeness/real wiring | not-done | not started |
| Round 2 — concurrency/crash/lifecycle | not-done | not started |
| Round 3 — protocol/data/permissions | not-done | not started |
| Round 4 — user flows/test credibility | not-done | not started |
| Round 5 — final independent reread/regression | not-done | starts only after rounds 1–4 are closed |

## Known limits and external blocks

- **26.3 data unavailable:** installed `minecraft-data@3.87.0` has no decodable 26.3 version/protocol data. Candidate profile metadata exists, but decoders/domain adapters stay fail-closed; no field guessing.
- **Real 26.3 projection unavailable:** only synthetic contract projectors are assembled; capability manifest marks blocks/entities/inventory unsupported and compression/lifecycle experimental/synthetic.
- **No live environment:** relay/observer only on loopback without a game engine; no real server/world/client compatibility claim.
- **Windows unverified:** helper/driver use injected transport; no real SendInput or screen capture.
- **No paid model API:** OpenAI/Anthropic paths use injected transports/fixtures; network gates default off.
- **Motor is simulated only:** no real 26.3 physics/terrain evidence; `stepUp`/`controlledDrop` remain disabled; P22 E2E body is simulated.
- **Default simulated profile remains legacy 2D:** the explicit `bodyAdapter` injection is required for 3D; `{x,y}` is never promoted to real 3D.
- **P23 soak is virtual time:** 60 virtual minutes proves budget/resource bounds, not long-term live stability; the short wall-clock smoke is separate.
- **CI not observed:** Node 22 local checks pass; cloud CI has not been run/observed.

See `DELIVERY_REPORT.md` for the exact 26.3 gap list and what P24/five rounds still owe.
