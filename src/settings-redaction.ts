const REDACTED_SECRET = '*** (stored)';

function redactProviderRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const clone = structuredClone(value) as Record<string, unknown>;
  if ('apiKey' in clone) clone.apiKey = REDACTED_SECRET;
  return clone;
}

function redactProviderMap(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const clone = structuredClone(value) as Record<string, unknown>;
  for (const [id, provider] of Object.entries(clone)) clone[id] = redactProviderRecord(provider);
  return clone;
}

/**
 * Removed blocks that may still carry a credential in a real settings file.
 *
 * Subscription authentication is gone, but `auth.profiles.<id>.clientSecret`
 * and the free-form `headers` that rode along with the bearer token are still
 * on disk wherever it was configured — and `book config list` prints the *raw*
 * document, not the validated one, so those keys survive into terminal
 * scrollback and pasted bug reports. Validation discarding a block is not the
 * same as a display path being safe, so the whole subtree is masked rather than
 * its individual leaves: nothing reads it any more, so there is nothing in it
 * worth showing.
 */
const REMOVED_SECRET_BEARING_BLOCKS = ['auth'];

export function redactSettingValue(path: string, value: unknown): unknown {
  const parts = path.split('.');
  if (parts[0] && REMOVED_SECRET_BEARING_BLOCKS.includes(parts[0])) return REDACTED_SECRET;
  if (parts[0] !== 'provider') return value;
  if (parts.length === 1) return redactProviderMap(value);
  if (parts.length === 2) return redactProviderRecord(value);
  return parts[parts.length - 1] === 'apiKey' ? REDACTED_SECRET : value;
}

export function redactSettingsForDisplay<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const clone = structuredClone(value) as Record<string, unknown>;
  clone.provider = redactProviderMap(clone.provider);
  for (const key of REMOVED_SECRET_BEARING_BLOCKS) {
    if (clone[key] !== undefined) clone[key] = REDACTED_SECRET;
  }
  return clone as T;
}
