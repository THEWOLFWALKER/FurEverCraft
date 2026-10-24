# Workstream Record

Single maintenance ledger for the FurEverCraft P01–P24 batch. It records what was actually implemented and verified, not what is planned.

- Repository: `/home/orca/projects/furevercraft-phase2-handoff`
- Remote: https://github.com/THEWOLFWALKER/FurEverCraft
- Current branch and HEAD: `main` at `f1c5f90` (`fix(P24 rounds 3-5): enforce scope, recovery, gates and truthful reporting`)
- Review history: P24 review start `ccb9f8e`; Round 1–2 checkpoint `17cdf06`; Round 3 checkpoint `ee9eea7`; Rounds 4–5 plus post-fix validation on `f1c5f90`
- Scope sources: `NEXT_BATCH.md` (P01–P24), `REVIEW.md` (five rounds), `docs/design/*-v0.2.md`
- Status vocabulary: `done-offline`, `done-limited`, `blocked-external`, `not-done` (in-progress work stays `not-done` until accepted)

## Baseline and environment

Final validation was run serially on `f1c5f90` after all Round 3–5 fixes. The built `dist/` is present, so child-process integration tests execute instead of being conditionally skipped. This documentation pass changes docs only; it does not alter the tested source, tests or configs.

| Item | Value |
|---|---|
| Final branch / HEAD | `main` / `f1c5f90` |
| P01–P23 merged baseline | `a2d216e`; P24 review started from `ccb9f8e` |
| Round checkpoints | Round 1–2: `17cdf06`; Round 3: `ee9eea7`; Rounds 4–5 and final fixes: `f1c5f90` |
| Node (local, verified) | `v22.23.4` |
| npm | `10.9.9` |
| Platform | Linux x86_64 (offline; no real Minecraft/Windows/paid API/CI) |
| `npx tsc --noEmit` | pass (exit 0) |
| `npm run build` | pass (exit 0) |
| `npm run test:offline` | 58 files / 578 tests passed, 0 skipped |
| `npm run build:web` | pass (exit 0) |
| `npm run test:v:offline` | integration 11 files / 71 tests; soak 2 files / 2 tests; diagnostics 2 files / 25 tests — 98 tests total, all pass |
| `npm run test:web:e2e` | 9/9 Chromium tests passed, headless, no screenshots/video/trace |
| `npm run demo:offline` | 6/6 scenarios passed |
| `npm run doctor` | exit 0; truthful `status: "degraded"` for the default simulated/legacy-2D runtime |
| `npm run doctor -- --profile simulated-3d` | exit 0; runtime profile `simulated-3d`, body 3D; no live claim |

## P01–P24 status

| Task | Status | Evidence |
|---|---|---|
| P01 gap mapping | done-offline | `PROGRESS.md`, `REVIEW_SCOPE.md`; original 500/208 list absent, no invented IDs |
| P02 Runtime assembly | done-offline | `src/execution/factory.ts` (explicit dependencies; public `simulated-3d`); `tests/unit/p01-p04.test.ts`, `tests/integration/integration-wiring.test.ts` |
| P03 execution/effect boundary | done-offline | `src/execution/admission.ts`, `src/agent/router.ts`; p01-p04 / v01-v04 / s01-s14 tests |
| P04 ownership/recovery | done-offline | `src/execution/ownership.ts`, `src/execution/session.ts`; p01-p04, c2-recovery-events |
| P05 raw TCP relay | done-offline | `src/bridge/relay/**`; raw-relay (19), relay-child, Round 5 observer tests |
| P06 framing/compression | done-offline | `src/bridge/observer/framing.ts`, `bounded.ts`; framing-compression (18), bounded-observer, p24-round3-observer |
| P07 adapter capability matrix | done-limited | `src/bridge/adapter/manifest.ts`, `configs/adapters/target-26.3.candidate.json`; adapter-manifest (10), p24-round3-adapter. Limit: no verified 26.3 schema/native/data |
| P08 domain projection | done-limited | `src/bridge/protocol/projectors/**`; p08-projection (14), domain-projection, `tests/integration/synthetic-observation-chain.test.ts`. Limit: synthetic assembly is test-only, labelled synthetic-only, and real 26.3 projectors remain `unavailable` |
| P09 process orchestration | done-offline | `src/bridge/service/**`, `supervisor.ts`; p09-service, bridge-service-child, p23-process-faults. Limit: Windows helper is static/injected only and was not launched on a real host |
| P10 3D body contract | done-limited | `src/motor/contracts.ts`; m01-m05, p10-p13. Limit: `place_one`/`look_at`/`dig_one` remain explicit legacy 2D |
| P11 navigation→Motor | done-limited | `src/skills/navigation.ts`, `src/motor/controller.ts`; p10-p13, integration-wiring. Limit: simulated body, public `simulated-3d` assembly |
| P12 realtime control | done-offline | `src/motor/controller.ts`, `src/execution/runtime.ts` (`InputArbiter`/`Executor`); p10-p13 |
| P13 independent simulated body | done-offline | `src/fixtures/body-adapter.ts` (`createSimulatedBodyAdapter`), `simulated-body.ts`; p10-p13, integration-wiring. Limit: simulated control loop only |
| P14 attach CLI | done-offline | `src/cli/main.ts`; cli-attach (2), E2E attach cases |
| P15 web main workflow | done-offline | `web/src/**`; p14-p16, E2E (9) |
| P16 security/SSE | done-offline | `src/server/index.ts`; p16-security (10), server (6), E2E auth-mode/SSE cases |
| P17 provider | done-limited | `src/providers/**`; providers-p17 (11), p24-round3-provider. Limit: injected transport only |
| P18 skills/scheduler | done-limited | `src/skills/lifecycle.ts`, `registry.ts`, `src/autonomous/tasks.ts`; skills-p18 (10). Limit: bounded lifecycle/scheduler evidence, not live long-run proof |
| P19 knowledge | done-limited | `src/autonomous/knowledge.ts`; knowledge-p19 (11). Limit: fixture sources, no 26.3 corpus |
| P20 memory | done-limited | `src/autonomous/memory.ts`, `src/persistence/store.ts`; memory-p20 (7), integration-wiring. Limit: fixture/simulated scope evidence |
| P21 doctor/trace/replay | done-offline | `src/diagnostics/doctor.ts`, `trace.ts`, `ControlService.diagnostics`; diagnostics (25); authenticated `/api/v1/doctor` |
| P22 Playwright E2E | done-offline | `tests/e2e/**`, `playwright.config.ts`; 9/9 Chromium tests. Limit: simulated/fixture body, no screenshots/video/trace |
| P23 fault combinations/soak | done-offline | `tests/unit/p23-*`, `tests/integration/p23-process-faults.test.ts`, `tests/soak/p23-fault-soak.test.ts`; 60 virtual minutes plus wall-clock smoke |
| P24 final consistency/five reviews | done-offline | All five rounds completed; Rounds 4–5 ran concurrently per user instruction; final post-fix validation on `f1c5f90`. Offline scope only |

## P24 work items

| Item | Status | Evidence |
|---|---|---|
| `trace:export` / `trace:replay` npm scripts | done-offline | `package.json`; CLI subcommands in `src/cli/main.ts`; scripts exercised with the real CLI |
| Authenticated `GET /api/v1/doctor` | done-offline | `src/server/index.ts` uses the same authorization path; returns redacted `control.diagnostics()` |
| Doctor endpoint integration test | done-offline | `tests/integration/p24-doctor.test.ts` — 401 without auth, 403 foreign Origin, paired session and CLI bearer both get the truthful P21 report, no secrets |
| Current docs | done-offline | `CLAUDE.md`, `PROGRESS.md`, `WORKSTREAM.md`, `DELIVERY_REPORT.md`, `README.md`, `REVIEW_SCOPE.md` |
| Round 3 — protocol/data/permissions | done-offline | `ee9eea7`; observer/relay, projection/manifest, control/data scope, provider/knowledge, CLI/security and config fixes; regressions `tests/unit/p24-round3-*.test.ts`, `tests/integration/synthetic-observation-chain.test.ts` |
| Round 4 — user flows/test credibility | done-offline | Completed concurrently with Round 5 at the user's explicit request; web auth-mode/SSE/pause/provider UX, real `serve --db`, config/provider gate, bridge fixture and CI build-order fixes; `tests/unit/p24-round4-cli.test.ts`, E2E |
| Round 5 — final independent reread/regression | done-offline | Completed concurrently with Round 4; per-session observer recovery, IPC/arm truthfulness, projection scope/anti-replay, input-skill gating and capability reporting fixes; `tests/unit/p24-round5-*.test.ts` |
| Final post-review consistency/checks | done-offline | Full serial validation on `f1c5f90`; see the environment table above |

## Review rounds

Rounds are recorded as executed. Round 3 finished at `ee9eea7`; Rounds 4 and 5 were then run **concurrently on the same tree at the user's explicit instruction to speed up delivery**, rather than the default one-at-a-time order. Both rounds completed and their fixes were folded into `f1c5f90`, followed by one full post-fix validation run on that commit.

| Round | Status | Notes |
|---|---|---|
| Round 1 — completeness/real wiring | done-offline | Completed 2026-10-24; 9 findings fixed, 1 external projection boundary documented; evidence in `DELIVERY_REPORT.md` |
| Round 2 — concurrency/crash/lifecycle | done-offline | Completed 2026-10-24; 10 findings fixed; checkpoint `17cdf06`; evidence in `DELIVERY_REPORT.md` |
| Round 3 — protocol/data/permissions | done-offline | Completed at `ee9eea7`; observer truthfulness, projection/manifest trust, scope isolation, provider/knowledge validation, config/CLI/security hardening |
| Round 4 — user flows/test credibility | done-offline | Run concurrently with Round 5; web/E2E auth and feedback truthfulness, real compiled serve flow, strict config/provider gate, bridge fixtures, CI ordering |
| Round 5 — final independent reread/regression | done-offline | Run concurrently with Round 4; per-session observer recovery, IPC/arm semantics, projection resync fencing, input-skill and capability truthfulness; final checks on `f1c5f90` |

## Prior work included in the baseline

- P01–P04 runtime assembly, admission/effect barrier, atomic ownership lock and recovery budget.
- P05–P09 raw relay, framing/compression, adapter manifest, test-only synthetic projection assembly, process supervision.
- P10–P13 3D body contract, Motor wiring, realtime control, independent simulated body.
- P14–P16 attach CLI, five-area web workflow, pairing/CSRF/Origin/SSE consistency.
- P17–P20 providers, skill lifecycle, knowledge releases, scoped spatial/episodic memory.
- P21 truthful doctor and bounded replayable trace.
- P22 real headless Playwright E2E.
- P23 combined faults, 60 virtual-minute soak and wall-clock process smoke.
- Earlier 500-issue audit remediation retained as history; not re-attributed as P24 work.

## Maintenance rules

- Each P block is developed on its own reviewable commit(s) and must keep `typecheck`, `build`, `build:web`, `test:offline`, `test:v:offline`, `test:web:e2e`, `demo:offline` and `doctor` green for the applicable scope.
- Update `PROGRESS.md`/`WORKSTREAM.md` in the same commit that changes a status.
- Never mark a task `done-offline` without a test or command evidence path. P24 and the five rounds are complete only for the offline scope recorded here; they are not live-client/server evidence.
- Never weaken tests, skip required cases, or turn failures into success.
- External boundaries stay unchanged: no real Minecraft server/world, paid model API, Windows SendInput or desktop capture.
- No sixth full-repository review is opened automatically. User-returned collaboration findings still need fixing and targeted regression.
- Do not push, deploy, publish or open a PR as part of this delivery/documentation pass.
