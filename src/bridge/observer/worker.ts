import { parentPort } from 'node:worker_threads';
import { BoundedObserver, type ControlEvent, type ObserverDirection } from './bounded.js';

/**
 * Observer worker entry. Bounded frame assembly and decompression live here so the relay
 * event loop is never blocked by observation work. Only redacted observation/gap events
 * and per-direction framing state are posted back; the worker never receives raw socket
 * write authority and never scans for a guessed packet boundary.
 */
export type WorkerInbound =
  | { type: 'chunk'; direction: ObserverDirection; bytes: Uint8Array }
  | { type: 'stop' }
  | { type: 'reset'; direction: ObserverDirection }
  | { type: 'control'; direction: ObserverDirection; event: unknown }
  | { type: 'set-compression'; direction: ObserverDirection; enabled: boolean; threshold?: number }
  | { type: 'set-phase'; direction: ObserverDirection; phase: string };

if (parentPort) {
  const observer = new BoundedObserver({
    maxQueuedFrames: 64,
    maxQueuedBytes: 8 * 1024 * 1024,
    maxConcurrency: 2,
    taskTimeoutMs: 2_000,
  });
  const postState = (direction: ObserverDirection) => {
    const state = observer.state();
    const selected = direction === 'client-to-server' ? state.downstream : state.upstream;
    parentPort!.postMessage({ type: 'state', direction, state: selected });
  };
  observer.subscribe(event => parentPort!.postMessage({ type: 'event', event }));
  parentPort.on('message', (message: WorkerInbound) => {
    if (message.type === 'chunk') {
      observer.attach(message.direction, message.bytes);
      postState(message.direction);
    } else if (message.type === 'reset') {
      observer.reset(message.direction);
      postState(message.direction);
    } else if (message.type === 'control') {
      observer.control(message.direction, message.event as ControlEvent | undefined);
      postState(message.direction);
    } else if (message.type === 'set-compression') {
      observer.setCompression(message.direction, message.enabled, message.threshold);
      postState(message.direction);
    } else if (message.type === 'set-phase') {
      observer.setPhase(message.direction, message.phase as never);
      postState(message.direction);
    } else if (message.type === 'stop') {
      void observer.stop().then(() => parentPort!.close());
    }
  });
}
