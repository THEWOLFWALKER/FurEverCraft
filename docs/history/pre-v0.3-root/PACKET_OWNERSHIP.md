# Packet ownership: Minecraft 1.20.4 / protocol 765

This table is an implementation boundary, not a claim of live-server compatibility. The protocol bridge owns only the loopback session and forwards packets through the injected transport. Packet names are checked against the installed `minecraft-data` 1.20.4 / protocol 765 definitions; fixture transports never connect to Minecraft.

| Direction | Phase | Ownership | Policy |
|---|---|---|---|
| downstream -> bridge | HANDSHAKE/STATUS/LOGIN/CONFIGURATION/PLAY | protocol session | decode and validate phase; forward once to the fixed injected upstream only when the network gate is enabled |
| bridge -> upstream | LOGIN/CONFIGURATION/PLAY | upstream session | forward only after fixed target and session identity are selected |
| upstream -> bridge | CONFIGURATION/PLAY | observation + forwarding | normalize an observation copy, then forward packet once |
| bridge -> downstream | CONFIGURATION/PLAY | forwarding | preserve phase ordering; library-owned compression/keepalive are not manually duplicated |
| any | CLOSED | session lifecycle | close both sides, clear observer queue and release owned input |

Library-owned handshake, compression, keepalive, configuration acknowledgements and encryption negotiation are not blindly echoed as ordinary packets. The fixture bridge validates names but does not reimplement minecraft-protocol's serializer, compression, encryption, or state handlers. Unsupported or unknown packets are reported as degraded/unknown and never silently promoted to authoritative state.

## Fixture coverage

The offline fixture uses `LoopbackFixtureTransport` and `ProtocolSession` in `tests/unit/protocol.test.ts`. It covers the explicit HANDSHAKE -> LOGIN -> CONFIGURATION -> PLAY lifecycle, both directions, phase/name validation, the default-deny upstream gate, normalized session/body epochs, bounded observation overflow with an `observation_gap`, and close cleanup. These tests are protocol/state-machine fixtures, not evidence of a live server connection.
