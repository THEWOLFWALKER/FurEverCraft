# Workstream Record

Single maintenance ledger for the FurEverCraft batch. It records what is actually implemented and verified, not what is planned.

- Repository: `/home/orca/projects/furevercraft-phase2-handoff`
- Remote: https://github.com/THEWOLFWALKER/FurEverCraft
- Branch history: `main` fast-forwards through reviewed feature branches (`p01-p04`, future `p05-p09`, ...)
- Scope sources: `NEXT_BATCH.md` (P01–P24), `REVIEW.md` (five rounds), `GOAL.md`
- Status vocabulary: `done-offline`, `done-limited`, `blocked-external`, `not-started`, `in-progress`

## Baseline

| Item | Value |
|---|---|
| Baseline commit | `f384c99` |
| Node (local) | v20.19.5 |
| Typecheck | pass |
| Build / build:web | pass |
| test:offline | 26 files / 192 tests pass |
| test:v:offline | integration + soak + trace pass |
| demo:offline | 6 scenarios pass |

## P01–P24 status

| Task | Status | Evidence |
|---|---|---|
| P01 gap mapping | done-offline | `PROGRESS.md` P01–P04 table |
| P02 runtime assembly | done-offline | `src/execution/factory.ts` — explicit `RuntimeDependencies`; client-offline rejects non-real body |
| P03 execution/effect boundary | done-offline | `src/execution/admission.ts`, `src/agent/router.ts`; `tests/unit/p01-p04.test.ts` |
| P04 ownership/recovery | done-offline | `src/execution/ownership.ts`, `src/execution/session.ts`; `tests/unit/c2-recovery-events.test.ts` |
| P05 raw TCP relay | not-started | relay exists (`src/bridge/relay/raw.ts`) but downstream listener / upstream connector lifecycle is not wired as required |
| P06 framing/compression | not-started | observer frames only; no decompression, per-direction compression state |
| P07 adapter import/capability matrix | not-started | 26.3 codec data absent; only candidate metadata + fail-closed gate |
| P08 domain projection | not-started | `src/bridge/protocol/domain.ts` maps position/chat/registry only; not wired into runtime |
| P09 process orchestration | not-started | supervisor/observer host exist but are not started from a public entry |
| P10 3D bridge contract migration | not-started | tools still use 2D `ClientBridgeCapabilities` |
| P11 navigation → Motor wiring | not-started | `src/motor/*` is standalone; skills use 2D navigation |
| P12 realtime control | not-started | no 20Hz loop, no progress-based replanning in runtime |
| P13 independent offline body | done-limited | `src/fixtures/simulated-body.ts` verified standalone; not used by runtime |
| P14 attach CLI | not-started | `serve`/`attach` exist but command set is incomplete |
| P15 web main workflow | done-limited | five areas + Canvas; no full write-path coverage per P15 |
| P16 security/SSE consistency | done-limited | pairing/CSRF/SSE watermark implemented and tested; needs review round |
| P17 provider multi-turn/switch | not-started | serializers exist; no provider switch path |
| P18 skills/scheduler closeout | not-started | 11 skills registered; several fail-closed, no full lifecycle |
| P19 knowledge wiring | not-started | JSON rule loader exists; no source manifest/release/coverage |
| P20 spatial/episodic memory | not-started | basic places/episodes CRUD only |
| P21 doctor/trace/replay | done-limited | `trace:export`/`trace:replay` exist; doctor is partly static |
| P22 Playwright E2E | not-started | script is a not-run stub |
| P23 fault combinations/soak | done-limited | soak covers 60 virtual minutes + rebuilds; combined faults absent |
| P24 final consistency/five reviews | in-progress | no review round completed yet |

## Review rounds

| Round | Status | Notes |
|---|---|---|
| Round 1 completeness/wiring | not-started | |
| Round 2 contract/state/side effects | not-started | |
| Round 3 bridge/Windows/protocol | not-started | |
| Round 4 model tools/UI/observability | not-started | |
| Round 5 integration/release | not-started | |

## Prior work included in baseline

- 500-issue audit remediation batches (relay stop/half-close, supervisor fencing, observer bounds, world delta merge, lease epoch/owner fencing, strict goal CAS, verified navigation/dig, explicit tool failures, static asset routing, clock overflow, scheduler goal wiring).
- Fastify migration with local pairing, HttpOnly session, CSRF, CLI bearer.
- Five-area React console with top-down canvas view.
- S01–S14 acceptance-mapped offline tests and U04 concurrency tests.

## Maintenance rules

- Each P block is developed on its own branch, merged with `--no-ff`, and must keep `typecheck`, `build`, `build:web`, `test:offline`, `test:v:offline` green before merge.
- Update this file and `PROGRESS.md` in the same commit that completes a block.
- Never mark a task `done-offline` without a test or command evidence path.
- External boundaries stay unchanged: no real Minecraft server/world, paid model API, Windows SendInput or desktop capture.
