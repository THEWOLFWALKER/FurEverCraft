import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcessLike } from '../supervisor.js';
import type { RelayEntryConfig } from './entry.js';

export type RelaySpawnerOptions = { entryUrl?: URL; env?: NodeJS.ProcessEnv; cwd?: string };

/**
 * Forks the relay child with a versioned IPC channel. The relay entry is intentionally a
 * separate process so a Runtime crash cannot take relay ownership with it.
 */
export function spawnRelayProcess(config: RelayEntryConfig, options: RelaySpawnerOptions = {}): ChildProcessLike {
  const entry = options.entryUrl ?? new URL('./entry.js', import.meta.url);
  const child: ChildProcess = fork(fileURLToPath(entry), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ...options.env, FUREVERCRAFT_RELAY_CONFIG: JSON.stringify(config) },
    cwd: options.cwd ?? process.cwd(),
    execArgv: [],
  });
  if (!child.send) throw new Error('relay-ipc-unavailable');
  return child as unknown as ChildProcessLike;
}
