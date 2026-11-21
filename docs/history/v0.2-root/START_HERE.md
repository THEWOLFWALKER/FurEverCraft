# FurEverCraft v0.2 Full Development Batch

Continue the current repository. Read this file, `NEXT_BATCH.md`, and the three current design documents under `docs/design/`; consult `docs/research/26.3-proxy-route-research.md` for the fixed adapter evidence. The complete authorized batch is F01-F06, B01-B06, U01-U04, M01-M05, A01-A05, V01-V04. Preserve prior C1/C2/C3 implementation and Git history; do not reset or overwrite local work.

Implement continuously in dependency order and do not stop after one chain. Use independently reviewable local commits. Non-overlapping subagents may be used, but integrate and review all changes. The user will coordinate review; review fixes remain part of this batch. Do not push unless asked.

Target Minecraft Java 26.3. The production body route is original raw TCP forwarding with a read-only observer sidecar, not an application-level terminating proxy and not a second bot player. Keep the four external gates independent and default false: Minecraft upstream, model network, OS input, screen capture.

Hard restrictions: no real Minecraft server/world, no game server, no paid model API, no actual SendInput, no desktop capture, no game asset downloads. Offline loopback endpoints without a game engine and injected transports are allowed. Implement gated production code while testing only fixtures. Missing real environment constrains verification only; continue all independent code work.

Testing rules: tests must reflect contracts and observable behavior, await async APIs, use isolated temporary databases and explicit fixture provenance, and verify unknown/ambiguous/failure/cleanup paths. Do not use fake constants as production facts, weaken assertions, skip failures, or label a codec roundtrip as live interoperability.

Final delivery must update existing `PROGRESS.md`, `DELIVERY_REPORT.md`, and `PLANNING_AGENT_HANDOFF.md` with per-item implementation and verification states. Run the actual final commands listed in `NEXT_BATCH.md`; report local Node 22/Windows/live verification separately from CI configuration. Keep unresolved boundaries explicit and continue until all achievable F/B/U/M/A/V items are done.
