import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * One strict loader for the shipped profile config files.
 *
 * A key is accepted only when the entrypoint that loads the file can actually honor it:
 * bridge modes consume the relay target and the upstream gate; serve consumes the runtime
 * profile and the model-network gate. Recognized-but-unhonored keys fail loudly with
 * `config-key-unused:<key>` instead of being silently ignored.
 */

export type ProfileConfigConsumer = 'bridge' | 'serve';

const WindowsHelperSchema = z.object({
  scriptPath: z.string().min(1),
  heartbeatIntervalMs: z.number().int().positive(),
  dryRun: z.boolean(),
}).strict();

const ProfileConfigSchema = z.object({
  /** Runtime profile. `serve` selects it; `bridge` reports/validates it. */
  profile: z.enum(['simulated', 'simulated-3d', 'client-offline']).optional(),
  /** Relay upstream target. Honored by `bridge --mode service`. */
  targetHost: z.string().min(1).optional(),
  targetPort: z.number().int().min(1).max(65_535).optional(),
  /** Independent upstream gate. Required explicitly by every bridge mode that uses a relay. */
  allowMinecraftUpstream: z.boolean().optional(),
  /** Local relay listener. Honored by `bridge --mode service`. Port 0 asks the OS to choose. */
  listenHost: z.string().min(1).optional(),
  listenPort: z.number().int().min(0).max(65_535).optional(),
  /**
   * Rewrite only the first downstream handshake frame to the configured target host/port.
   * Never enabled implicitly; every later byte is forwarded verbatim.
   */
  rewriteHandshake: z.boolean().optional(),
  /** Bounded handshake rewrite limits; only meaningful together with rewriteHandshake. */
  handshakeLimitBytes: z.number().int().min(1).max(1_048_576).optional(),
  handshakeTimeoutMs: z.number().int().min(1).max(600_000).optional(),
  /** Provider network gate. Honored by `serve` when it assembles the Runtime. */
  allowModelNetwork: z.boolean().optional(),
  /**
   * Recognized so a stale config gets a precise `config-key-unused` error. No shipped
   * entrypoint assembles the Windows helper yet (the service entry owns relay/observer only),
   * so this key is not honored anywhere and is deliberately not in any consumer's used set.
   */
  windowsHelper: WindowsHelperSchema.optional(),
}).strict();

export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;

/** Keys each consumer can actually honor. Everything else is a hard error. */
const CONSUMER_KEYS: Record<ProfileConfigConsumer, ReadonlySet<string>> = {
  // `profile` is reported and checked by the bridge command; it is not used to choose a
  // fallback body, so it cannot quietly turn a fixture into a live client.
  bridge: new Set([
    'profile', 'targetHost', 'targetPort', 'allowMinecraftUpstream',
    'listenHost', 'listenPort', 'rewriteHandshake', 'handshakeLimitBytes', 'handshakeTimeoutMs',
  ]),
  serve: new Set(['profile', 'allowModelNetwork']),
};

export class ProfileConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProfileConfigError';
  }
}

/** Parse and validate an already-decoded config document. */
export function parseProfileConfig(value: unknown, consumer: ProfileConfigConsumer): ProfileConfig {
  const parsed = ProfileConfigSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    if (issue.code === 'unrecognized_keys') {
      const key = issue.keys[0] ?? '<unknown>';
      throw new ProfileConfigError('config-key-unused', `config-key-unused:${key}`);
    }
    const path = issue.path.length ? issue.path.join('.') : '<root>';
    throw new ProfileConfigError('config-invalid', `config-invalid:${path}:${issue.message}`);
  }
  for (const key of Object.keys(parsed.data)) {
    if (!CONSUMER_KEYS[consumer].has(key)) {
      throw new ProfileConfigError('config-key-unused', `config-key-unused:${key}`);
    }
  }
  return parsed.data;
}

/** Read, decode and strictly validate a profile config file. */
export function loadProfileConfig(file: string, consumer: ProfileConfigConsumer): ProfileConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ProfileConfigError('config-file-unreadable', `config-file-unreadable:${file}`);
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ProfileConfigError('config-invalid-json', `config-invalid-json:${file}`);
  }
  return parseProfileConfig(document, consumer);
}
