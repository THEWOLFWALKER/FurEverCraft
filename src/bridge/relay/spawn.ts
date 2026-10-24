import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcessLike } from '../supervisor.js';
import type { RelayEntryConfig } from './entry.js';

export type RelaySpawnerOptions = { entryUrl?: URL; env?: NodeJS.ProcessEnv; cwd?: string };

/**
 * Parent variables a relay/service child may inherit. Everything else (CLI bearer, pairing
 * code, provider API keys and unrelated secrets) stays in the parent process; only the
 * explicitly allowlisted runtime plumbing crosses the process boundary.
 */
const CHILD_ENV_ALLOWLIST = ['PATH', 'Path', 'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'NODE_OPTIONS'] as const;

/** Build the minimal child environment, filtered again so options.env cannot smuggle a secret. */
export function minimalChildEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = overrides[key] ?? process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

/**
 * Forks the relay child with a versioned IPC channel. The relay entry is intentionally a
 * separate process so a Runtime crash cannot take relay ownership with it.
 */
export function spawnRelayProcess(config: RelayEntryConfig, options: RelaySpawnerOptions = {}): ChildProcessLike {
  const entry = options.entryUrl ?? new URL('./entry.js', import.meta.url);
  const child: ChildProcess = fork(fileURLToPath(entry), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...minimalChildEnvironment(options.env), FUREVERCRAFT_RELAY_CONFIG: JSON.stringify(config) },
    cwd: options.cwd ?? process.cwd(),
    execArgv: [],
  });
  if (!child.send) throw new Error('relay-ipc-unavailable');
  return child as unknown as ChildProcessLike;
}
