import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcessLike } from '../supervisor.js';
import type { BridgeServiceEntryConfig } from './entry.js';

export type BridgeServiceSpawnerOptions = { entryUrl?: URL; env?: NodeJS.ProcessEnv; cwd?: string };

/**
 * Forks the bridge service child. The relay child and observer worker live under the service
 * process; the parent Runtime only sees the versioned IPC surface.
 */
export function spawnBridgeServiceProcess(config: BridgeServiceEntryConfig, options: BridgeServiceSpawnerOptions = {}): ChildProcessLike {
  const entry = options.entryUrl ?? new URL('./entry.js', import.meta.url);
  const child: ChildProcess = fork(fileURLToPath(entry), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ...options.env, FUREVERCRAFT_SERVICE_CONFIG: JSON.stringify(config) },
    cwd: options.cwd ?? process.cwd(),
    execArgv: [],
  });
  if (!child.send) throw new Error('service-ipc-unavailable');
  return child as unknown as ChildProcessLike;
}
