# Phase 2.1 Convergence Progress

Working through foundation fixes, C1, C2, and C3. Real server/world, paid model API, Windows SendInput and desktop capture remain intentionally untested.

| Stream | Status | Evidence |
|---|---|---|
| Foundation | implemented, integration review ongoing | `src/execution/factory.ts`, bridge capability interface, injected provider gate, shared assembly tests |
| C1 application/model/tool loop | partial | `src/agent/router.ts`, provider serializers, RuntimeFactory and offline tests; full readline console, goal fencing under CLI session, complete provider switching and retry budget remain open |
| C2 effects and restart recovery | partial | `src/execution/session.ts`, `src/persistence/store.ts`, `tests/unit/c2-recovery-events.test.ts`; scope/evidence/state tests exist, further fault windows/CAS and dispatch integration review remain |
| C3 offline byte protocol integration | partial | `MinecraftBytePacketTransport`, fragmented loopback packet test, bridge fixture/inspect CLI modes; independent listeners/upstream connector, library-driven phase/compression lifecycle and full domain normalization remain open |
| Windows helper/driver | partial | Fake transport tests and PowerShell source; native dry-run sink/state-machine coverage and independent watchdog verification remain open |
| Final offline verification | in progress | local Node 20.19.5 runs; Node 22 CI configured but not yet observed remotely |
