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
 * Secret-bearing keys under `auth.profiles.<id>`.
 *
 * `clientSecret` is a client credential. `headers` is free-form and documented
 * as riding along with the bearer token, so a gateway key belongs there as
 * readily as a content type - and `book config list` dumps the whole resolved
 * document into terminal scrollback and pasted bug reports. `clientId` is a
 * public identifier by design and stays visible, which is what makes
 * "no client id configured" diagnosable.
 */
const AUTH_PROFILE_SECRET_KEYS = new Set(['clientSecret', 'headers']);

function redactAuthProfile(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const clone = structuredClone(value) as Record<string, unknown>;
  for (const key of AUTH_PROFILE_SECRET_KEYS) {
    if (key in clone) clone[key] = REDACTED_SECRET;
  }
  return clone;
}

function redactAuthProfileMap(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const clone = structuredClone(value) as Record<string, unknown>;
  for (const [id, profile] of Object.entries(clone)) clone[id] = redactAuthProfile(profile);
  return clone;
}

function redactAuth(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const clone = structuredClone(value) as Record<string, unknown>;
  if ('profiles' in clone) clone.profiles = redactAuthProfileMap(clone.profiles);
  return clone;
}

export function redactSettingValue(path: string, value: unknown): unknown {
  const parts = path.split('.');
  if (parts[0] === 'auth') {
    if (parts.length === 1) return redactAuth(value);
    if (parts[1] !== 'profiles') return value;
    if (parts.length === 2) return redactAuthProfileMap(value);
    if (parts.length === 3) return redactAuthProfile(value);
    return AUTH_PROFILE_SECRET_KEYS.has(parts[3]) ? REDACTED_SECRET : value;
  }
  if (parts[0] !== 'provider') return value;
  if (parts.length === 1) return redactProviderMap(value);
  if (parts.length === 2) return redactProviderRecord(value);
  return parts[parts.length - 1] === 'apiKey' ? REDACTED_SECRET : value;
}

export function redactSettingsForDisplay<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const clone = structuredClone(value) as Record<string, unknown>;
  clone.provider = redactProviderMap(clone.provider);
  clone.auth = redactAuth(clone.auth);
  return clone as T;
}
