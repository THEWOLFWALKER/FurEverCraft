# FurEverCraft v0.2 Development

Stage: autonomous player runtime + raw TCP relay/sidecar observer + Windows input gateway + CLI/web control surface.
Target repository: https://github.com/THEWOLFWALKER/FurEverCraft

## Current state

- Branch / HEAD: `main` at `c7815a2` (`fix(P24 final): truthful skills, control, bridge and docs after audit`).
- Round history: Round 1–2 checkpoint `17cdf06`; Round 3 checkpoint `ee9eea7`; Rounds 4–5 on `f1c5f90`; post-review audit fixes on `c7815a2`.
- All five review rounds in `REVIEW.md` are complete. Rounds 4 and 5 were executed concurrently at the user's explicit request to speed up delivery. A post-review independent audit (workflow) then produced additional truthful-behavior fixes in `c7815a2` (explore_area/start_skill fail-closed on legacy, real body release channel, observed preconditions, cancel/quit receipt truthfulness, provider non-success mapping, observer recovery/arm/shutdown truthfulness, capability advertisement narrowing, dead facade removal); the full validation was re-run on `c7815a2`.
- P24 is `done-offline` for this offline scope. This is not evidence of live Minecraft 26.3, Windows input/capture or paid-model compatibility.

The v0.2 design in `docs/design/` and implementation batch in `NEXT_BATCH.md` replace the current design direction of the earlier v0.1/phase-two handoff. Earlier documents are retained as history or implementation context; they do not override v0.2 decisions where they conflict.

The target game profile is Minecraft Java 26.3. Protocol/data/runtime values are candidate evidence and must be validated against the pinned dependency manifest. This repository is not yet evidence of live 26.3 interoperability.

## Scope

This development batch is **P01–P24** in `NEXT_BATCH.md`. The older F/B/U/M/A/V groups are historical traceability labels, not the current task numbering. The batch closes the C1/C2/C3 convergence work and related prior-stage runtime gaps; it is not a demo-only slice.

The architecture is one real Java client body, original-player identity, raw TCP relay with read-only observer sidecar, Windows 10/11 input helper, one Runtime and shared ControlService for CLI/web. The v0.2 route is raw byte forwarding plus sidecar observation, not an application-level terminating proxy or second protocol bot.

## Hard boundaries

- Do not connect to a real Minecraft server or world.
- Do not start a real Minecraft server or integrated world.
- Do not download game assets.
- Do not call paid model APIs.
- Do not execute real Windows SendInput or desktop capture.
- Loopback protocol/HTTP peers must be short-lived fixtures without a game engine.
- Fixture/simulated evidence must never be labelled live-client/server evidence.
- Unknown effects remain unknown; no blind replay of text, clicks, mouse deltas, or old input plans.

The production live path may be implemented behind explicit independent gates, but this batch runs only offline fixtures. `allowMinecraftUpstream`, `allowModelNetwork`, `allowOsInput`, and `allowScreenCapture` default false.

## Current entrypoints

```bash
npm ci
npm run typecheck
npm run build
npm run build:web
npm run test:offline
npm run test:v:offline
npm run test:web
npm run test:web:e2e
npm run demo:offline
npm run demo:autonomy
npm run doctor -- --profile simulated
npm run doctor -- --profile simulated-3d
npm run bridge:fixture
npm run bridge:protocol
npm run cli -- bridge --mode inspect --config configs/client-offline.example.json
npm run serve -- --profile simulated
npm run serve -- --profile simulated-3d
npm run serve -- --config configs/serve-offline.example.json
npm run cli -- attach --url http://127.0.0.1:3000
```

`simulated` is the explicit legacy planar profile. `simulated-3d` assembles the
same ControlService/runtime and the simulated 3D BodyAdapter/Motor chain; it is
simulated evidence, not a real 26.3 client.

## Auth modes

`serve` defaults to local pairing with a one-time 128-bit code. The mode is also exposed publicly (and without secrets) at `GET /api/v1/auth-mode`.

| Mode | How to start | Browser behavior |
|---|---|---|
| `pairing` | default, or `--pairing-code <code>` | Pair with the one-time code; HttpOnly session + CSRF |
| `bearer-only` | `--no-pairing --cli-bearer <token>` (or `MINECRAFT_AGENT_CLI_TOKEN`) | Browser access is disabled; use the CLI bearer |
| `loopback-open` | `--no-pairing` with no bearer | Open on loopback only; explicit development mode |

A generated pairing code is printed only when stdout is an interactive TTY. A non-TTY `serve` (for example under a supervisor) must receive an explicit code via `--pairing-code` or `MINECRAFT_AGENT_PAIRING_CODE`, otherwise it fails with `pairing-code-required:non-tty` instead of starting an unreachable daemon. An explicitly supplied code is not printed.

## Serve config and provider selection

`serve --config <path>` uses the strict profile loader. A serve config may set `profile` and `allowModelNetwork`; any key the serving runtime cannot honor (for example a relay target or Windows helper) fails with `config-key-unused:<key>` rather than being silently ignored. `configs/serve-offline.example.json` keeps the model-network gate closed.

Provider selection is opt-in and never implied:

```bash
# Requires a config with "allowModelNetwork": true and an API key.
npm run serve -- --config <serve-config.json> --provider openai --model <model>
```

- Open gate without a provider fails (`model-provider-required`).
- Provider with the gate closed fails (`model-network-gate-disabled`).
- Provider without an API key (`--api-key` or `MINECRAFT_AGENT_MODEL_API_KEY`) fails (`model-provider-not-configured`).
- No paid model API was called in this batch. The options exist so the gate is not inert and startup metadata is truthful.

## Bridge fixtures: `bridge:fixture` vs `bridge:protocol`

- `npm run bridge:fixture` uses `configs/bridge-fixture.example.json` and runs the default fixture mode against a loopback echo target. It is the runnable default fixture.
- `npm run bridge:protocol` uses `configs/simulated.json` and reports the version/protocol summary in fixture mode.
- Fixture mode always uses and reports the loopback echo target, never a configured real target. `service` mode is the only mode that uses `targetHost`/`targetPort`, and `live` remains gate-blocked and cannot run without a real client environment.
- `configs/client-offline.example.json` has `allowMinecraftUpstream: false`; use it for `bridge --mode inspect` (as the CI workflow specifies), not for the default fixture mode.

## Evidence status

Final validation on `c7815a2`: `npx tsc --noEmit` exit 0; `npm run build` exit 0; `npm run test:offline` 58 files / 601 tests, 0 skipped; `npm run build:web` exit 0; `npm run test:v:offline` 98 tests (integration 11 files / 71, soak 2/2, diagnostics 2 files / 25); `npm run test:web:e2e` 9/9 Chromium headless with no screenshots/video/trace; `npm run demo:offline` 6/6; `npm run doctor` exit 0 with truthful `degraded` (runtimeProfile simulated, body legacy-2d); `npm run doctor -- --profile simulated-3d` exit 0 with runtime profile `simulated-3d`, body mode 3d and `threeDimensional: true`.

Read `PROGRESS.md` and `DELIVERY_REPORT.md` for implementation and verification states. Design documents are contracts, not implementation evidence. Local Node 22 (`v22.23.4`, npm `10.9.9`, Linux x86_64) verification is not proof that cloud CI ran; the CI workflow defines a Playwright browser job, but no CI run was observed. Real client/server/Windows/API compatibility remains unverified until separately authorized testing.

## Honest 26.3 and live limits

- `minecraft-data@3.87.0` has no decodable 26.3 version/protocol data; `configs/adapters/target-26.3.candidate.json` is a candidate/unsupported manifest with unverified provenance.
- Real 26.3 projectors are `unavailable`; only synthetic contract projectors are assembled in tests, explicitly labelled synthetic-only. The observer emits frame metadata only.
- No real Minecraft server/world/client, Windows SendInput/capture, or paid model API was used. The Motor is simulated; E2E uses fixture/simulated bodies.
- No screenshots/video/trace are produced or claimed.
