# FurEverCraft v0.2 Development Batch – Readiness Report

Status: v0.2 design and implementation batch synchronized; implementation has not started. The previous phase2.1 convergence commits are preserved as the working baseline, not treated as proof of v0.2 completion.

## Stable baseline

Repository: `/home/orca/projects/furevercraft-phase2-handoff`
Starting HEAD: `c345159` before documentation alignment; local baseline includes the prior convergence chain through `2eb776d`.
Starting worktree: clean before documentation sync.
Current architecture authority: `docs/design/minecraft-agent-top-level-design-v0.2.md`, `docs/design/minecraft-agent-client-bridge-contracts-v0.2.md`, `docs/design/minecraft-agent-motion-navigation-recovery-v0.2.md`, and `NEXT_BATCH.md`.

## Documents synchronized

- Added the three v0.2 design documents under `docs/design/`.
- Added the 26.3 proxy route research under `docs/research/`.
- Added `NEXT_BATCH.md` with the full F01-F06/B01-B06/U01-U04/M01-M05/A01-A05/V01-V04 delivery scope.
- Replaced `START_HERE.md` with the current full-batch brief.
- Marked legacy `DECISIONS.md` 1.20.4/protocol 765 terminating-proxy material as historical and superseded.
- Updated root `README.md` to identify v0.2 current authority, the 26.3 raw-relay + read-only observer route, hard boundaries, and intended commands.
- Updated `CLAUDE.md` and `AGENTS.md` with v0.2 priority, complete scope, subagent allowance, review discipline, and test premise rules.
- Updated `PROGRESS.md` with F/B/U/M/A/V task groups and separate implementation/verification evidence columns.

## Prior baseline verification (not v0.2 evidence)

At the prior phase2.1 checkpoint on Linux/Node 20.19.5, `npm run typecheck`, `npm run build`, `npm run test:offline`, six-scenario offline demo, simulated doctor, bridge fixture, and bridge inspect had passed; test result then was 9 files / 42 tests. This is historical evidence only. It does not prove Minecraft 26.3, raw TCP relay, web/control service, 3D motor, Node 22, or live integration.

## Current v0.2 scope

All 30 tasks are authorized and remain in scope:

- F01-F06: RuntimeFactory/Clock/owner, execution and admission, durable effects, Store/state/event corrections, providers, docs/rules.
- B01-B06: fixed 26.3 version manifest, raw TCP Relay, bounded sidecar Observer, domain projection, Windows gateway contract, IPC/Supervisor/CLI assembly.
- U01-U04: shared ControlService, Fastify API/SSE/auth, React control UI, simultaneous CLI/web CAS and tests.
- M01-M05: sparse 3D projection, local action graph/A*, supported primitive closures, independent SimulatedBody, progress/recovery controller.
- A01-A05: autonomous task loop, knowledge/spatial/episodic memory, eleven skills, session supervision/auth coordination, bounded capture/capability/long-run policies.
- V01-V04: 14 integrated scenarios, crash/write/soak tests, trace/replay/docs, Node 22 CI and coordinated review.

## Hard boundaries

No real Minecraft server/world, no game server, no paid model API, no actual Windows SendInput, no desktop capture, no game asset download. Loopback fixtures have no game engine. Production live code must remain explicitly gated; default network/model/OS/capture permissions are false.

Tests must use contract-correct premises, explicit fixture provenance, awaited async assertions, isolated temporary DBs, and assert ambiguous/unknown/cleanup behavior. Do not infer completion from test count or demo labels. Do not push unless separately authorized.

## Next action

Begin with F01 shared RuntimeFactory, one injected Clock and bridge-neutral contracts; then progress through C1/F, C2, B/U, M/A, and V dependencies. Commit reviewable local increments, continuously update `PROGRESS.md`, and continue through all achievable tasks before final review.

## Truth-state matrix

| Surface | State | Evidence |
|---|---|---|
| Code baseline | verified-current | local branch/history at `c345159` before documentation sync |
| Runtime production state | out-of-scope for this doc-sync step | no code changes in this step |
| Docs | changed-and-verified | v0.2 docs copied from checksum-verified archive; root authority references updated |
| Rules | changed-and-verified | `CLAUDE.md`, `AGENTS.md`, `START_HERE.md` align to full v0.2 batch |
| Memory | not-applicable | no memory write requested or made |
| Workspace | verified-current | source archive checksum verified; no cleanup/deletion performed |
| Remote publication | pending | this documentation sync has not been pushed |
