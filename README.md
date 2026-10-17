# FurEverCraft v0.2 Development

Stage: autonomous player runtime + raw TCP relay/sidecar observer + Windows input gateway + CLI/web control surface.
Date: 2026-10-17
Target repository: https://github.com/THEWOLFWALKER/FurEverCraft

## Current authority

The v0.2 design in `docs/design/` and implementation batch in `NEXT_BATCH.md` replace the current design direction of the earlier v0.1/phase-two handoff. Earlier documents are retained as history or implementation context; they do not override v0.2 decisions where they conflict.

The target game profile is Minecraft Java 26.3. Protocol/data/runtime values are candidate evidence and must be validated against the pinned dependency manifest. This repository is not yet evidence of live 26.3 interoperability.

## Scope

This development batch covers all 30 items F01-F06, B01-B06, U01-U04, M01-M05, A01-A05, V01-V04. It closes the C1/C2/C3 convergence work and completes related prior-stage runtime gaps. Do not stop after one vertical chain or shrink the delivery to a demo-only slice.

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

The following are the intended final commands; availability must be implemented and verified before being reported complete:

```bash
npm ci
npm run typecheck
npm run build
npm run build:web
npm run test:offline
npm run test:integration:offline
npm run test:soak:offline
npm run test:web
npm run test:web:e2e
npm run demo:offline
npm run demo:autonomy -- --scenario gather-return
npm run doctor -- --profile simulated
npm run bridge:fixture
npm run cli -- bridge --mode inspect --config configs/client-offline.example.json
npm run serve -- --profile simulated
npm run cli -- attach --url http://127.0.0.1:3000
```

## Evidence status

Read `PROGRESS.md` and `DELIVERY_REPORT.md` for current implementation and verification states. Design documents are contracts, not implementation evidence. Local Node 20 verification is not Node 22 evidence; a CI workflow definition is not a passing CI run. Real client/server/Windows/API compatibility remains unverified until separately authorized testing.
