# FurEverCraft v0.2 Delivery Report

## Status

A substantial offline implementation of the v0.2 batch is complete and verified on loopback fixtures. It is not a claim of live Minecraft 26.3, Windows, or paid-API compatibility. Real servers/worlds, paid model APIs, actual SendInput and desktop capture were not used.

Current HEAD after this pass: `279fd8d` (plus documentation commits).

## What is implemented

### Foundation and providers (F)
- One `createRuntime` assembly (`src/execution/factory.ts`) with a single injected `Clock`, Store, Session, Executor, Router, provider, AgentLoop and ControlService.
- Executor: owner token, AbortSignal propagation, resource leases with resource-scoped generation, lease/watchdog renewal on progress, no ambiguous→confirmed promotion, terminal-state protection.
- Store: transactional migrations, effect state guards, action receipt lifecycle, checkpoint persistence, context-scoped queries.
- WorldState: schema-validated updates, read-time TTL, sticky gap cleared only by a full baseline, all cells unknown after a gap, immutable listener notifications.
- EventHub: `{bootEpoch, sequence}` cursor, filtered reads without manufactured gaps, validated limits.
- Providers: canonical history (text/image/tool/termination), OpenAI and Anthropic serializers with correct tool pairing, UTF-8 SSE across arbitrary byte chunks, record/response/tool-argument limits, truncation rejection, `Retry-After`-aware bounded retry, cancellation fence, `allowModelNetwork` gate.

### Bridge (B)
- `src/bridge/version-profile.ts`: 26.3 / protocol 777 / data 5023 candidate metadata with explicit limitations.
- `src/bridge/relay/raw.ts`: raw TCP byte relay with handshake rewrite (protocol/nextState validated), correct `write=false` backpressure + drain resume, hard limit, bounded close flush, half-close propagation, EOF session cleanup, retryable startup.
- `src/bridge/observer/bounded.ts`: async bounded dispatch queue with concurrency/timeout, per-frame byte offsets, sticky global unknown, explicit gap events.
- `src/bridge/ipc/endpoint.ts`: versioned protocol, session-epoch fencing (stale responses cannot settle requests), bounded pending, listener cleanup.
- `src/bridge/protocol/domain.ts`: packet→domain projection; unsupported packets become explicit `unknown` observations, never silent drops.
- Windows driver/helper: request-ID matching, command-ID dedup, disabled-safe cleanup, binding/input checks (Linux-tested via `FakeHelperTransport` only).

### Control surface (U)
- `src/control/service.ts`: shared ControlService with canonical payload hashing, durable requestId dedupe, CAS conflicts, goal set/revise, message, chat, pause/resume/stop/cancel/save/quit; stop cancels non-terminal executions; save persists a checkpoint.
- `src/server/index.ts`: JSON API, SSE snapshot+consistent ascending cursor, bounds, same-origin static hosting of the built UI.
- `web/`: React + Vite control console using the calm blue-white design tokens, truthful unknown (`--`) states, live SSE feed, capability-gated actions, responsive breakpoints.
- CLI: `serve`, `attach`, `demo`, `status`, `doctor`, `bridge` (fixture/inspect/live-gated).

### Motor, autonomy and verification (M/A/V)
- `src/motor/*` + `src/fixtures/*`: sparse 3D voxel world, swept-collision A*, primitives, independent simulated body, no-progress/recovery controller.
- `src/autonomous/*`: GoalManager/TaskScheduler, knowledge/spatial/episodic memory, session supervisor, bounded capture history.
- Eleven skills registered; `look_at`, `dig_one`, `return_to_place` implemented against simulated capabilities and fail closed when the capability is absent.
- `src/diagnostics/trace.ts` bounded trace.
- Tests: unit, integration, soak (60 virtual minutes) and trace suites.

## Verified commands (local Linux, Node 20.19.5, npm 10.8.2)

```text
npm run typecheck            pass
npm run build                pass
npm run build:web            pass
npm run test:offline         21 files / 94 tests pass
npm run test:v:offline       integration + soak + trace pass
npm run demo:offline         6 scenarios pass
npm run doctor -- --profile simulated   pass
npm run bridge:protocol -- --config configs/simulated.json   pass (fixture, loopback)
npm run test:web             web typecheck + vite build pass
```

Loopback smoke: `serve` served the built UI (200 text/html), `/api/v1/status` returned running, `goal.set` returned terminal, and the JS asset loaded (200).

## Honest limits / not implemented

- Minecraft codec remains the legacy 1.20.4/765 fixture. The 26.3 adapter is candidate metadata only; no live 26.3 packet decoding is claimed.
- Raw relay verified on loopback sockets only; no real upstream connection.
- No child-process Supervisor; IPC endpoint exists but process orchestration is not implemented.
- `collect_nearby` and `gather_blocks` intentionally fail closed (no capability).
- No Playwright browser E2E; the web build and same-origin serving are verified but not driven by a browser.
- Node 22 CI is configured (Linux verify + Windows helper static parse) but has not been observed passing on GitHub.
- Real Windows SendInput/capture, paid model APIs and real Minecraft remain unverified.

## Testing discipline

Every assertion is grounded in a contract or observable behavior. Fixture provenance is preserved (`fixture`/`simulated`), async tests use `await`/`rejects`, databases use isolated temp paths, and unknown/ambiguous/failure/cleanup paths are asserted. No assertion was weakened to force green; several tests were corrected where their premise (not the implementation) was wrong.
