# FurEverCraft v0.2 Full Batch Progress

Current authorization: F01-F06, B01-B06, U01-U04, M01-M05, A01-A05, V01-V04. Status reflects verified offline behavior only. Real servers/worlds, paid APIs, actual Windows input and screenshots remain prohibited.

| Task group | Status | Implementation evidence | Verification evidence |
|---|---|---|---|
| F01 Runtime/Clock/ownership | implemented-offline | `src/execution/factory.ts` single assembly, shared injected Clock, `SystemClock` production default | `tests/unit/runtime.test.ts`, C1 factory tests |
| F02 execution/cancel/admission | implemented-offline | `src/execution/runtime.ts` owner token, AbortSignal, lease+watchdog renewal on progress, no ambiguous→confirmed | `tests/unit/execution-skills.test.ts` |
| F03 durable dispatch/recovery | implemented-offline (partial) | `src/execution/session.ts`, effect ledger + receipts in store; dispatch-boundary intent wiring limited | `tests/unit/c2-recovery-events.test.ts`, `tests/integration/v01-v04.integration.test.ts` |
| F04 Store/state/events | implemented-offline | transactional migration, CAS, sticky read-time WorldState invalidation, event cursor | `tests/unit/persistence.test.ts`, `tests/unit/world.test.ts` |
| F05 providers | implemented-offline | canonical history, tool pairing, UTF-8 SSE, limits, retry/Retry-After, network gate | `tests/unit/providers.test.ts` |
| F06 docs/rules | implemented | v0.2 authority synced in README/CLAUDE/AGENTS/DECISIONS | this file |
| B01 26.3 version profile | implemented-offline (candidate) | `src/bridge/version-profile.ts` 26.3/777/5023 candidate; codec remains legacy 1.20.4 fixture (not live) | `tests/unit/version-profile.test.ts` |
| B02 raw TCP relay | implemented-offline | `src/bridge/relay/raw.ts` byte relay, handshake rewrite with nextState validation, backpressure, half-close, bounded flush | `tests/unit/raw-relay.test.ts` (7 tests) |
| B03 bounded observer | implemented-offline (partial) | `src/bridge/observer/bounded.ts` async bounded queue, per-frame offsets, sticky unknown; no compression/typed worker | `tests/unit/bounded-observer.test.ts` (5 tests) |
| B04 domain adapters | implemented-offline (partial) | `src/bridge/protocol/domain.ts` position/chat/registry projection with explicit unknown for unmapped packets; 26.3 complete packet families not available | `tests/unit/domain-projection.test.ts` |
| B05 Windows helper/driver | implemented-unverified (Linux) | `src/bridge/windows/driver.ts`, PowerShell helper; no real SendInput run | `tests/unit/windows-driver.test.ts` |
| B06 IPC/Supervisor | implemented-offline | `src/bridge/ipc/*` session-epoch fencing; `src/bridge/supervisor.ts` owner epoch/restart budget/owner-loss; `src/bridge/relay/entry.ts` + `spawn.ts` fork IPC; `src/bridge/observer/host.ts` worker_threads observer | `tests/unit/ipc-endpoint.test.ts`, `supervisor.test.ts`, `observer-host.test.ts`, `tests/integration/relay-child.test.ts` |
| U01 shared ControlService | implemented-offline | `src/control/service.ts`, `serve`/`attach` CLI | `tests/unit/control-service.test.ts` |
| U02 HTTP/SSE | implemented-offline | `src/server/index.ts`, JSON API, SSE snapshot+cursor, bounds, same-origin static hosting | `tests/integration/server.test.ts` |
| U03 React control UI | implemented-offline | `web/` Vite+React console with the blue-white design tokens, truthful states, command forms, SSE feed | `npm run test:web`, `npm run build:web`, loopback smoke |
| U04 concurrent CLI/Web | implemented-offline (partial) | requestId dedupe + CAS via ControlService; CLI `serve`/`attach` share one Runtime | server + control tests; Playwright E2E not implemented |
| M01-M05 3D state/motor | implemented-offline (partial) | `src/motor/*`, `src/fixtures/*`; not wired into production runtime | `tests/unit/m01-m05.test.ts` |
| A01 GoalManager/TaskScheduler | implemented-offline | `src/autonomous/tasks.ts` | `tests/unit/autonomous.test.ts` |
| A02 knowledge/spatial/episodic memory | implemented-offline | `src/autonomous/memory.ts` | `tests/unit/autonomous.test.ts` |
| A03 eleven skills | implemented-offline (partial) | registry has 11; look_at/dig_one/return_to_place implemented against simulated capabilities and fail closed when absent; collect_nearby/gather_blocks intentionally unavailable | `tests/unit/execution-skills.test.ts` |
| A04 session/auth | implemented-offline | `src/autonomous/session.ts` secretRef only | `tests/unit/autonomous.test.ts` |
| A05 capture/long-run bounds | implemented-offline | bounded capture history | `tests/unit/autonomous.test.ts` |
| V01 integrated scenarios | partial | `tests/integration/v01-v04.integration.test.ts`, server tests | 5 integration tests |
| V02 crash/write/soak | partial | `tests/soak/v02-soak.test.ts` virtual-time 60 min | 1 soak test |
| V03 trace/replay/docs | partial | `src/diagnostics/trace.ts` + tests | `tests/diagnostics/trace.test.ts` |
| V04 CI/review | partial | `.github/workflows/offline.yml` Node 22 commands | not yet observed on CI |

## Honest limits

- The Minecraft codec path is the legacy 1.20.4/765 fixture; the 26.3 adapter is candidate metadata only. No live 26.3 interoperability is claimed.
- The raw relay is verified on loopback sockets only; no real server was contacted.
- The React web UI is implemented and served same-origin; browser Playwright E2E and full 26.3 domain normalizers remain not implemented.
- Six of the eleven skills are registered but intentionally return unavailable without the corresponding capability.
- Real Windows input/capture, paid model APIs, Node 22 execution and real Minecraft are unverified.
