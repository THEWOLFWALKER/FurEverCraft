# FurEverCraft v0.2 Delivery Report — P01–P23 merged, P24 in progress

## Status

The merged `p24-final` branch (`a2d216e`) contains an offline-verifiable implementation of P01–P23 on Linux. P24 is **in progress**: the documentation/consistency items in this worktree are done, but **none of the five full review rounds required by `REVIEW.md` has been completed**. Nothing here is a claim of live Minecraft 26.3, Windows, or paid-API compatibility.

Real Minecraft servers/worlds, real Windows input/capture, game assets, and paid model APIs were not used. Local results use Node `v22.23.4` / npm `10.9.9`; cloud CI was not observed.

## What is actually runnable

- **CLI**: `demo`, `serve`, `attach`, `status`, `doctor`, `bridge` (fixture/inspect/service; live remains gated), `goal:revise`, `events`, `trace:export`, `trace:replay`.
- **HTTP control plane**: Fastify `/api/v1` reads/writes, local pairing (one-time code, HttpOnly/SameSite session, CSRF), loopback/Host/Origin checks, CLI bearer, SSE snapshot/cursor/gap recovery. P24 adds authenticated `GET /api/v1/doctor`.
- **Web console**: React/Vite five-area control UI (overview, conversation, tasks, world, settings/diagnostics) served from the same ControlService as the CLI.
- **Runtime/bridge**: one RuntimeAssembly per storage path with cross-process owner lock; raw loopback TCP relay with read-only observer; framing/compression budgets; 3D Motor path with simulated body when explicitly injected; default simulated profile remains explicit legacy 2D.
- **Diagnostics**: truthful doctor over the attached runtime/store; bounded trace export and side-effect-free replay.

## Verified checks (offline Linux, 2026-10-24)

P01–P23 merged baseline `a2d216e`, post-build so conditional child-process tests execute:

```text
npm run typecheck            pass
npm run build                pass
npm run build:web            pass (Vite 5.4.11, 32 modules)
npm run test:offline         45 files / 383 tests passed, 0 skipped
npm run test:v:offline       integration 9 files / 47 tests passed
                             soak         2 files /  2 tests passed
                             diagnostics  2 files / 15 tests passed
npm run test:web:e2e         1 spec / 2 Chromium tests passed (~19 s)
npm run demo:offline         6/6 scenarios passed
npm run doctor               exit 0; truthful "degraded" default report
```

P24 work in this worktree adds `tests/integration/p24-doctor.test.ts`; current counts are **46 files / 384 tests** offline and **10 files / 48 tests** integration (soak/diagnostics/E2E unchanged). These are in-progress P24 results, not a completed P24.

Additional P24 checks: `npm run trace:export -- --db <tmp> --out <tmp>` and `npm run trace:replay -- --file <tmp>` were exercised against the real CLI subcommands (see commit evidence); the new doctor test proves unauthenticated access is denied and an authenticated CLI bearer receives the same truthful P21 report.

## P01–P23 status summary

Full evidence paths and test counts are in `PROGRESS.md`; implementation/test locations are summarized here.

| Area | Tasks | Status |
|---|---|---|
| Foundation | P01–P04 | done-offline — single Runtime assembly, execution/effect barrier, atomic ownership, recovery budget |
| Bridge | P05–P09 | P05/P06/P09 done-offline; P07/P08 done-limited (26.3 data absent, synthetic projection only) |
| Motion | P10–P13 | P10/P11 done-limited (3D contract + simulated Motor; some legacy 2D tools); P12/P13 done-offline (realtime control, simulated body) |
| Control/Agent | P14–P18 | P14–P16 done-offline (CLI, web, security/SSE); P17/P18 done-limited (injected provider transport, limited skill lifecycle) |
| Knowledge/Diagnostics | P19–P21 | P19/P20 done-limited (fixture knowledge, bounded scoped memory); P21 done-offline (doctor/trace/replay) |
| Verification | P22/P23 | done-offline — real headless Playwright E2E with simulated body; combined faults + 60 virtual-minute soak + wall-clock smoke |
| Finalization | P24 | **not-done / in progress** — docs, trace scripts and doctor endpoint done; five review rounds not started |

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
- **E2E body is simulated:** P22 starts a real Fastify server, real Chromium and real CLI, but the body is the simulated adapter, not a Minecraft client.
- **No screenshots:** E2E explicitly disables screenshots, video and traces; no visual evidence is claimed.
- **CI unobserved:** Node 22 and Playwright pass locally; cloud CI results are not known.

## What P24 and the five rounds still owe

1. Execute the five full review rounds in `REVIEW.md`, one at a time, over the whole repository and assembly chains (not one module per round).
2. For each round record start/end commit, coverage, findings with severity/trigger/file/impact, fixed / false-premise / blocked-external classification, targeted regression commands and remaining affected tasks.
3. Fix findings before advancing; do not defer them to the end. Do not weaken tests or reclassify incomplete work to make a round pass.
4. After round 5, perform the final consistency pass over docs/config/scripts/capability claims/node-22 CI, then rerun the affected standard checks.
5. Only then mark P24 complete. The five rounds and P24 remain **not-done** at the time of this report.

## Honest limits that must not be misreported

- A loopback fixture, synthetic projector, injected provider transport, or simulated body is **not** real-client/live evidence.
- `done-limited` is not equivalent to complete support: the stated limits (26.3 data, provider transport, skill scope) still apply.
- Local Node 22 passing does not mean CI ran; passing offline tests do not prove live Minecraft compatibility.
- No feature was silently removed from the batch; unavailable capabilities are explicit fail-closed surfaces with reasons.

## Testing discipline

Assertions target contracts or observable behavior; fixture provenance stays labelled. Async behavior is awaited, test databases use isolated temporary paths, and process/port/browser resources are cleaned up. Negative cases (auth denial, Origin rejection, cursor gaps, crash windows, ambiguous outcomes) are asserted. No assertion was weakened to force a green result. The P24 doctor test initially asserted that the pairing response itself never contains its CSRF token; that premise was wrong (the pairing response is designed to return it), so the assertion was corrected to scope secret checks to the doctor responses rather than weakening the implementation.
