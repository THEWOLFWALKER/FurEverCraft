# Workstream Record

Single maintenance ledger for the FurEverCraft P01–P24 batch. It records what was actually implemented and verified, not what is planned.

- Repository: `/home/orca/projects/furevercraft-phase2-handoff`
- Remote: https://github.com/THEWOLFWALKER/FurEverCraft
- P24 working branch/worktree: `worktree-agent-ab6f1d11a5e61d85a` (isolated worktree; not pushed)
- Merged P01–P23 baseline: `a2d216e` (`p24-final`)
- Scope sources: `NEXT_BATCH.md` (P01–P24), `REVIEW.md` (five rounds), `docs/design/*-v0.2.md`
- Status vocabulary: `done-offline`, `done-limited`, `blocked-external`, `not-done` (in-progress is `not-done` until accepted)

## Baseline and environment

| Item | Value |
|---|---|
| Baseline commit | `a2d216e` (`p24-final`, contains merged P01–P23); Round 1 runs from `ccb9f8e` |
| P24 commit on this branch | `0dd7bfc` (trace scripts + doctor endpoint/test); Round 1 fixes and docs are committed after it |
| Worktree start | Created from `c27dcfa` (P01–P04 lineage), fast-forwarded to `ccb9f8e` (`p24-final`) before changes |
| Node (local, verified) | `v22.23.4` |
| npm | `10.9.9` |
| Platform | Linux x86_64 (offline; no real Minecraft/Windows/paid API) |
| Typecheck | pass |
| Build / build:web | pass / pass (Vite 5.4.11) |
| test:offline (post-build) | 46 files / 394 tests passed, 0 skipped |
| test:v:offline | integration 10 files / 56 tests; soak 2 files / 2 tests; diagnostics 2 files / 15 tests — all pass |
| test:web:e2e | 1 spec file / 2 Chromium tests passed (~19 s) |
| demo:offline | 6/6 scenarios pass |
| doctor | exits 0; `status: "degraded"` for default simulated/legacy-2D runtime, truthfully reported |
| doctor (simulated-3d) | exits 0; reports a simulated 3D body, no live claim |

The child-process integration tests are conditionally skipped only when `dist/` is absent; the standard sequence builds first, so the counts above are post-build and include them.

## P01–P24 status

| Task | Status | Evidence |
|---|---|---|
| P01 gap mapping | done-offline | `PROGRESS.md`, `REVIEW_SCOPE.md`; original 500/208 list absent, no invented IDs |
| P02 Runtime assembly | done-offline | `src/execution/factory.ts` (explicit dependencies; public `simulated-3d`); `tests/unit/p01-p04.test.ts`, `tests/integration/integration-wiring.test.ts` |
| P03 execution/effect boundary | done-offline | `src/execution/admission.ts`, `src/agent/router.ts`; p01-p04 / v01-v04 / s01-s14 tests |
| P04 ownership/recovery | done-offline | `src/execution/ownership.ts`, `src/execution/session.ts`; p01-p04, c2-recovery-events |
| P05 raw TCP relay | done-offline | `src/bridge/relay/**`; raw-relay (18), relay-child |
| P06 framing/compression | done-offline | `src/bridge/observer/framing.ts`, `bounded.ts`; framing-compression (18), bounded-observer |
| P07 adapter capability matrix | done-limited | `src/bridge/adapter/manifest.ts`, `configs/adapters/target-26.3.candidate.json`; adapter-manifest (9); no verified 26.3 data |
| P08 domain projection | done-limited | `src/bridge/protocol/projectors/**`; p08-projection (14), domain-projection; real 26.3 projectors unavailable, synthetic assembly is test-only and not connected to relay/observer/WorldState |
| P09 process orchestration | done-offline (Windows helper not launched) | `src/bridge/service/**`, `supervisor.ts`; p09-service, bridge-service-child, p23-process-faults |
| P10 3D body contract | done-limited | `src/motor/contracts.ts`; m01-m05, p10-p13; legacy 2D tools remain explicit |
| P11 navigation→Motor | done-limited | `src/skills/navigation.ts`, `src/motor/controller.ts`; p10-p13, integration-wiring; simulated body, public `simulated-3d` assembly |
| P12 realtime control | done-offline | `src/motor/controller.ts`, `src/execution/runtime.ts` (`InputArbiter`/`Executor`); p10-p13 |
| P13 independent simulated body | done-offline (simulated loop only) | `src/fixtures/body-adapter.ts` (`createSimulatedBodyAdapter`), `simulated-body.ts`; p10-p13, integration-wiring |
| P14 attach CLI | done-offline | `src/cli/main.ts`; cli-attach (2) |
| P15 web main workflow | done-offline | `web/src/**`; p14-p16, E2E (2) |
| P16 security/SSE | done-offline | `src/server/index.ts`; p16-security (6), server (6) |
| P17 provider | done-limited (injected transport) | `src/providers/**`; providers-p17 (11) |
| P18 skills/scheduler | done-limited | `src/skills/lifecycle.ts`, `registry.ts`, `src/autonomous/tasks.ts`; skills-p18 (10) |
| P19 knowledge | done-limited (fixture sources) | `src/autonomous/knowledge.ts`; knowledge-p19 (9) |
| P20 memory | done-limited | `src/autonomous/memory.ts`, `src/persistence/store.ts`; memory-p20 (7), integration-wiring (3D z target) |
| P21 doctor/trace/replay | done-offline | `src/diagnostics/doctor.ts`, `trace.ts`, `ControlService.diagnostics`; diagnostics 15; P24 adds `/api/v1/doctor` + test |
| P22 Playwright E2E | done-offline (simulated body) | `tests/e2e/**`, `playwright.config.ts`; 2 Chromium tests |
| P23 fault combinations/soak | done-offline | `tests/unit/p23-*`, `tests/integration/p23-process-faults.test.ts` (4), `tests/soak/p23-fault-soak.test.ts` (1) |
| P24 final consistency/five reviews | not-done (in progress) | P24 scripts/endpoint/test/docs done; Round 1 completed and fixed; Rounds 2–5 not started |

## P24 work items

| Item | Status | Evidence |
|---|---|---|
| `trace:export` / `trace:replay` npm scripts | done-offline | `package.json`; CLI subcommands in `src/cli/main.ts`; scripts exercised with real CLI |
| Authenticated `GET /api/v1/doctor` | done-offline | `src/server/index.ts` uses the same `authorizeRequest` path; returns `redact(control.diagnostics())` |
| Doctor endpoint integration test | done-offline | `tests/integration/p24-doctor.test.ts` — 401 without auth, 403 foreign Origin, paired session and CLI bearer both get the truthful P21 report, no secrets |
| Current docs | done-offline | `CLAUDE.md`, `PROGRESS.md`, `WORKSTREAM.md`, `DELIVERY_REPORT.md` |
| Five review rounds | in progress | Round 1 completed; Rounds 2–5 pending |
| Final post-review consistency/checks | not-done | depends on the five rounds |

## Review rounds

Rounds are executed **one at a time**; a round is not closed until its findings are fixed or explicitly blocked externally and targeted regression has run.

| Round | Status | Notes |
|---|---|---|
| Round 1 — completeness/real wiring | completed 2026-10-24 | Whole-repo + chain review; 9 findings fixed, projection boundary documented; evidence in `DELIVERY_REPORT.md` |
| Round 2 — concurrency/crash/lifecycle | not-done | pending |
| Round 3 — protocol/data/permissions | not-done | pending |
| Round 4 — user flows/test credibility | not-done | pending |
| Round 5 — final independent reread/regression | not-done | pending |

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
- Never mark a task `done-offline` without a test or command evidence path; never mark P24 or the five rounds complete before they are.
- Never weaken tests, skip required cases, or turn failures into success.
- External boundaries stay unchanged: no real Minecraft server/world, paid model API, Windows SendInput or desktop capture.
- Do not push, deploy, publish or open a PR from this worktree.
