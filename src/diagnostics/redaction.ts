const SECRET_KEY = /(api[_-]?key|auth(?:orization|entication)?|password|passphrase|secret|token|credential|cookie)/i;
const SENSITIVE_TEXT = /(bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]+|ghp_[a-z0-9]+|xox[baprs]-[a-z0-9-]+)/gi;

export function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(SENSITIVE_TEXT, '[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

export function redactError(error: unknown): string {
  return String(redact(error instanceof Error ? error.message : error));
}
