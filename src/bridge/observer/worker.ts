import { parentPort } from 'node:worker_threads';
import { BoundedObserver } from './bounded.js';

/**
 * Observer worker entry. The heavy frame assembly and bounded queue live here so the relay
 * event loop is never blocked by observation work. Only redacted observation/gap events are
 * posted back; the worker never receives raw socket write authority.
 */
export type WorkerInbound = { type: 'chunk'; direction: 'client-to-server' | 'server-to-client'; bytes: Uint8Array } | { type: 'stop' } | { type: 'reset'; direction: 'client-to-server' | 'server-to-client' };

if (parentPort) {
  const observer = new BoundedObserver({ maxQueuedFrames: 64, maxQueuedBytes: 8 * 1024 * 1024, maxConcurrency: 2, taskTimeoutMs: 2_000 });
  observer.subscribe(event => parentPort!.postMessage({ type: 'event', event }));
  parentPort.on('message', (message: WorkerInbound) => {
    if (message.type === 'chunk') observer.attach(message.direction, message.bytes);
    else if (message.type === 'reset') observer.reset(message.direction);
    else if (message.type === 'stop') void observer.stop().then(() => parentPort!.close());
  });
}
