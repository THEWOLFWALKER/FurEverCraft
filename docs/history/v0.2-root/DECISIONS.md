# Current v0.2 Architecture Decisions

This file contains legacy v0.1/phase-two implementation decisions and is retained as migration history. The current architecture authority is:

- `docs/design/minecraft-agent-top-level-design-v0.2.md`
- `docs/design/minecraft-agent-client-bridge-contracts-v0.2.md`
- `docs/design/minecraft-agent-motion-navigation-recovery-v0.2.md`
- `NEXT_BATCH.md`

Current target is Minecraft Java 26.3, with raw TCP forwarding plus a read-only observer sidecar. The prior 1.20.4/protocol 765 terminating-proxy plan is retired as a current target. Existing code remains useful where compatible, but it is not evidence of 26.3 support. The target profile's protocol/data version must be validated against pinned dependencies and evidence before capability is enabled.

The v0.2 decisions supersede conflicting legacy text below. The legacy section is retained for history and migration context; do not use it to select new implementation behavior.

---

# Legacy phase-two decisions (historical, superseded where noted)
