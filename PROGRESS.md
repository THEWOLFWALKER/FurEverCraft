# FurEverCraft v0.2 Full Batch Progress

Current authorization: P01–P24 in `NEXT_BATCH.md` with five review rounds in `REVIEW.md`. Maintenance ledger: `WORKSTREAM.md`. Status reflects verified offline behavior only; real servers/worlds, paid APIs, actual Windows input and screenshots remain prohibited.

## Current batch: P01–P04 (production assembly and execution boundary)

| Task | Status | Implementation | Verification |
|---|---|---|---|
| P01 gap mapping (this batch) | done-offline | P02-P04 entry points mapped below; the 500/208-item list is not present in the repo, so no item numbers are invented | this table |
| P02 runtime assembly | done-offline | `src/execution/factory.ts` builds one explicit `RuntimeDependencies` container (Clock/Store/Events/Provider/Body/Nav/Motor), rejects client-offline without a real body, defaults client input off, and exposes owner/inputs/ownership state | `tests/unit/p01-p04.test.ts` |
| P03 execution/effect boundary | done-offline | `src/execution/admission.ts` + `src/agent/router.ts` check goal revision, owner, epoch and capability before prepare and again before dispatch; prepared is durable before may-have-dispatched; write failures abort before body input; terminal cancel/timeout is never overwritten; barrier evidence survives settlement | `tests/unit/p01-p04.test.ts`, `tests/integration/v01-v04.integration.test.ts`, `tests/integration/s01-s14-acceptance.test.ts` |
| P04 ownership/recovery | done-offline | `src/execution/ownership.ts` atomic cross-process lock (reclaims only verified-dead same-host owners, never deletes unknown/foreign locks, releases only its own record); `src/execution/session.ts` recovery budget, retry, world/account isolation and cross-epoch reobservation without confirmation | `tests/unit/p01-p04.test.ts`, `tests/unit/c2-recovery-events.test.ts` |


| Task group | Status | Implementation evidence | Verification evidence |
|---|---|---|---|
| F01 Runtime/Clock/ownership | implemented-offline (partial) | `src/execution/factory.ts` single assembly, injected Clock, profile validation, idempotent close | `tests/unit/runtime.test.ts` |
| F02 execution/cancel/admission | implemented-offline | owner token, AbortSignal, watchdog aborts, lease renewal, ordered tools | `tests/unit/execution-skills.test.ts` |
| F03 durable dispatch/recovery | implemented-offline (partial) | prepared→may-have-dispatched barrier, effect settlement, receipts; no full receipt vocabulary/child execution | `tests/unit/c2-recovery-events.test.ts`, `tests/integration/v01-v04.integration.test.ts` |
| F04 Store/state/events | implemented-offline (partial) | transactional migrations, terminal-safe writes, sticky read-time WorldState, event cursor; no versioned migration dispatch | `tests/unit/persistence.test.ts`, `tests/unit/world.test.ts` |
| F05 providers | implemented-offline (partial) | canonical history, tool pairing, SSE limits, retry, gate; no provider-switch path | `tests/unit/providers.test.ts` |
| F06 docs/rules | implemented | v0.2 authority synced; reports updated with actual numbers | this file |
| B01 26.3 version profile | implemented-offline (candidate) | candidate metadata + runtime fail-closed gate when 26.3 data is absent; codec remains legacy fixture | `tests/unit/version-profile.test.ts` |
| B02 raw TCP relay | implemented-offline | allowHalfOpen, handshake validation, backpressure, bounded flush, deterministic stop | `tests/unit/raw-relay.test.ts` |
| B03 bounded observer | implemented-offline (partial) | async bounded queue, offsets, sequence advance, sticky unknown, worker host; no decompression | `tests/unit/bounded-observer.test.ts`, `observer-host.test.ts` |
| B04 domain adapters | partial | position/chat/registry; other families explicit unknown | `tests/unit/domain-projection.test.ts` |
| B05 Windows helper/driver | implemented-unverified (Linux) | 250ms heartbeat, identity confirmation, dedupe; no real SendInput | `tests/unit/windows-driver.test.ts` |
| B06 IPC/Supervisor | implemented-offline | session/boot fencing, restart budget, owner revoke, relay child fork | `tests/unit/supervisor.test.ts`, `tests/integration/relay-child.test.ts` |
| U01 shared ControlService | implemented-offline (partial) | atomic claim, CAS, pause admission, stop body release; no child-execution cancel | `tests/unit/control-service.test.ts` |
| U02 HTTP/SSE | implemented-offline | Fastify API, local pairing (5 min, single use), HttpOnly/SameSite session, CSRF, CLI bearer, SSE watermark/gap recovery, bounds | `tests/integration/server.test.ts` |
| U03 React control UI | implemented-offline | five areas (overview/conversation/tasks/world/settings), Canvas top view, truthful states, SSE | `npm run test:web` |
| U04 concurrent CLI/Web | implemented-offline (partial) | concurrent requestId dedupe + CAS tested; no Playwright browser E2E | control/server tests |
| M01 3D state/geometry | partial | sparse voxel, explicit unknown, support required; not wired to Runtime | `tests/unit/m01-m05.test.ts` |
| M02 action graph | implemented-offline (partial) | A* with support required, budget/status; walk edges only | `tests/unit/m01-m05.test.ts` |
| M03 primitives | partial | InputPlan validation; no closed-loop 20Hz controller | `tests/unit/m01-m05.test.ts` |
| M04 simulated body | partial | continuous tick, gravity, yaw-relative movement; no jump trajectory | `tests/unit/m01-m05.test.ts` |
| M05 progress/recovery | implemented-offline | cooldown reset, failure classes, phase wait | `tests/unit/m01-m05.test.ts` |
| A01 GoalManager/Scheduler | implemented-offline | cycle detection, unknown-skill rejection, scheduler wired to events | `tests/unit/autonomous.test.ts` |
| A02 memory | partial | spatial/episodic + JSON knowledge loader; no auto episodic summary on completion | `tests/unit/autonomous.test.ts` |
| A03 eleven skills | implemented-offline (partial) | all 11 registered; 5 capability-backed; gather is single-block | `tests/unit/execution-skills.test.ts` |
| A04 session/auth | partial | secretRef, single owner, lifecycle states; no backoff/lease revoke | `tests/unit/autonomous.test.ts` |
| A05 capture/bounds | implemented-offline (partial) | bounded history; synthetic PNG not a valid image | `tests/unit/autonomous.test.ts` |
| V01 integrated scenarios | implemented-offline (partial) | S01–S14 acceptance-mapped offline tests (7 groups) + U04 concurrency | `tests/integration/v01-v04.integration.test.ts` |
| V02 crash/write/soak | partial | 60 virtual min, 50+ transitions, 5 rebuilds; no injected write failures | `tests/soak/v02-soak.test.ts` |
| V03 trace/replay/docs | implemented-offline | TraceRecorder, `trace:export`, `trace:replay`, tests | `tests/diagnostics/trace.test.ts` |
| V04 CI/review | partial | Node 22 + Windows static parse jobs; not observed | `.github/workflows/offline.yml` |

## Review status

Two uncapped read-only review passes covered every group. Confirmed defects were fixed with regression tests; remaining items are listed as partial/unmet above and in `DELIVERY_REPORT.md`.

## Honest limits

- 26.3 codec absent (installed data has no 26.3); legacy fixture is labelled and never presented as live support.
- Relay/observer verified on loopback only; no real server.
- Motor is not wired into the Runtime.
- React UI has a Canvas top view and five areas; Playwright browser E2E is still not implemented and `test:web` is typecheck+build.
- V01 covers S01–S14 in grouped offline tests (not one test per scenario); S04/S05/S08/S09/S12/S13 have limited depth due to missing 26.3 data.
- Real Windows input/capture, paid model APIs, Node 22 execution and real Minecraft are unverified.
