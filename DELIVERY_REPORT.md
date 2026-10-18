# FurEverCraft v0.2 Delivery Report

## Status

A substantial offline implementation of the v0.2 batch exists and is verified on loopback fixtures. It is not a claim of live Minecraft 26.3, Windows, or paid-API compatibility. Real servers/worlds, paid model APIs, actual SendInput and desktop capture were not used.

## What is implemented

### Foundation and providers (F)
- One `createRuntime` assembly with a shared injected Clock, Store, Session, Executor, Router, provider, AgentLoop, ControlService, GoalManager and TaskScheduler.
- Executor: owner token, AbortSignal, resource leases with per-resource generation, lease/watchdog renewal on progress, watchdog aborts in-flight work, terminal-state writes are guarded in the store, ambiguous/partial never promoted to confirmed.
- Store: transactional migrations, effect state guards, action receipt lifecycle (`conflict`/`rejected` preserved), checkpoint persistence, terminal-safe execution writes.
- WorldState: schema-validated updates, read-time TTL, sticky gap cleared only by a full baseline, prior cells preserved as `unknown` after a gap, immutable notifications.
- EventHub: `bootEpoch` + sequence, validated cursors, filtered reads without manufactured gaps.
- Providers: canonical history, OpenAI/Anthropic serializers with correct tool pairing, UTF-8 SSE across arbitrary byte chunks, record/response/tool-argument limits, truncation rejection, `Retry-After`-aware bounded retry, cancellation fence, `allowModelNetwork` gate, no-key unavailable provider.
- Side-effect skills persist `prepared → may-have-dispatched` before dispatch and settle `confirmed/partial/ambiguous` by outcome; `place` is only confirmed when the target cell is observed blocked.

### Bridge (B)
- `version-profile.ts`: 26.3 / 777 / 5023 candidate metadata with explicit limitations; the legacy 1.20.4/765 codec is labelled as a fixture and never presented as 26.3 support.
- Raw TCP relay: `allowHalfOpen`, validated handshake rewrite (protocol/nextState), declared-length limit, backpressure on `write=false` with drain resume, bounded close flush, half-close reply preservation, EOF session cleanup, retryable startup, deterministic stop.
- Bounded observer: async bounded queue with concurrency/timeout, per-frame byte offsets, sequence advance on dropped frames, sticky global unknown, reset clears partial frames, worker_threads host with failure isolation.
- IPC: versioned protocol, session-epoch fencing, bounded pending requests, listener cleanup.
- Domain projection: position/chat/registry with explicit `unknown` for unsupported or malformed packets.
- Windows driver/helper: 250 ms heartbeat default, PID/HWND confirmation on bind, identity required to permit input, request-ID matching, command-ID dedup, best-effort cleanup. Linux-tested only via `FakeHelperTransport`.
- Supervisor: owner epoch, child session/boot fencing, hello-before-request, 3-per-60s restart budget, owner-loss revoke, explicit quit; relay child entry and fork spawner, verified end-to-end over loopback child IPC.

### Control surface (U)
- Shared ControlService: canonical payload hash, atomic in-flight claim for concurrent requestId dedupe, durable receipts, CAS conflicts, pause blocks new admission, stop cancels non-terminal executions and releases body input, save persists a checkpoint, message goal-revision conflicts surface as `conflict`.
- HTTP/SSE: JSON API, Zod DTOs, 400/409, SSE snapshot at a consistent watermark, gap re-sends a fresh snapshot, bounded events/bytes, heartbeats with backpressure checks, same-origin static hosting.
- React + Vite console using the calm blue-white tokens, truthful `--` unknown states, live SSE feed, capability-aware panels, responsive breakpoints.
- CLI: `serve` (default 127.0.0.1:3000), `attach`, `demo`, `status`, `doctor`, `bridge` fixture/inspect/live-gated.

### Motor / autonomy / verification (M/A/V)
- Sparse 3D world with explicit unknown; action graph requires an actual support surface (air is not support); continuous simulated body with gravity, yaw-relative movement, jump and support checks; progress controller with correct cooldown reset.
- GoalManager rejects cycles and unknown skills; TaskScheduler is subscribed to the EventHub and advances a real AgentLoop turn; knowledge rules load from a versioned JSON file; episodic memory can be recorded.
- Eleven skills registered; `look_at`, `dig_one`, `return_to_place`, `collect_nearby`, `gather_blocks` run against simulated capabilities and fail closed when absent.
- Soak: 60 virtual minutes, ≥50 command transitions, pause/resume cycles, 5 runtime/db rebuilds with receipt dedupe verified after restart.

## Verified commands (local Linux, Node 20.19.5)

```text
npm run typecheck            pass
npm run build                pass
npm run build:web            pass
npm run test:offline         24 files / 112 tests pass
npm run test:v:offline       integration (incl. forked relay child) + soak + trace pass
npm run demo:offline         6 scenarios pass
npm run demo:autonomy        pass
npm run doctor -- --profile simulated   pass
npm run bridge:protocol -- --config configs/simulated.json   pass (fixture, loopback)
npm run test:web             web typecheck + vite build pass
```

Loopback smoke: `serve` served the built UI (200 text/html), `/api/v1/status` returned running, `goal.set` returned terminal, and the JS asset loaded (200).

## Review passes performed

Two full read-only review passes covered every group without a finding cap:
- F01–F06, B01–B06, U01–U04, M01–M05, A01–A05, V01–V04.
- Each item is classified satisfied/partial/unmet with file:line evidence.

Fixes applied from those reviews include: relay stop deadlock and half-close reply loss, supervisor late-exit/hello/boot-epoch/owner-revoke, observer sequence/reset/concurrency, relay declared-length limit, Windows identity/heartbeat, atomic command claim, pause admission, stop body release, real capabilities, SSE watermark and gap recovery, motor support/cooldown/body physics, task cycles/unknown skills, scheduler wiring, knowledge loader, deterministic demo DBs, real autonomous demo path, and the missing `demo:autonomy`/`test:web:e2e` scripts.

## Honest limits (explicitly not implemented or not verified)

- **26.3 codec is absent**: the installed `minecraft-data` has no 26.3 data; the codec remains the 1.20.4/765 fixture. The 26.3 profile is candidate metadata only. This is a fail-closed boundary, not live support.
- **Domain adapters are partial**: only position/chat/registry are projected; health/inventory/entity/chunk/light/respawn are explicit `unknown`. No coverage query or `CapabilityProvider`.
- **Observer lacks decompression/compression-ratio enforcement** and phase progression; it frames bytes but does not decompress or type-parse 26.3 packets.
- **Relay STATUS independent probe** has no explicit session classification; it relies on per-connection upstreams.
- **CompositeClientBridge does not implement the Runtime capability interface**, so `client-offline` cannot be assembled as a production bridge.
- **Windows**: no real SendInput/capture; no SDL3 mapping or calibration; helper restart control-uncertain is not implemented.
- **Motor is not wired into the Runtime**: M01–M05 is a verified standalone module, not the production control path.
- **React UI**: no Canvas top-down map, no Playwright browser E2E, no list pagination/cursor; `test:web` is typecheck+build.
- **V01 has 2 integrated scenarios**, not the 14 named S01–S14; S12 entityDelta/PositionPath is absent.
- **Node 22 CI is configured but unobserved**; Windows CI only statically parses the helper.
- **No real Minecraft server/world, paid API, SendInput or screenshot verification.**

## Testing discipline

Assertions are grounded in contracts or observable behavior. Fixture provenance stays `fixture`/`simulated`. Async tests use `await`/`rejects`. Databases use isolated temp paths. Unknown/ambiguous/failure/cleanup paths are asserted. Tests corrected during review had wrong premises (e.g. missing full baseline, incomplete helper identity, snapshot watermark semantics); no assertion was weakened to force green.
