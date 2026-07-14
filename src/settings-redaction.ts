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

export function redactSettingValue(path: string, value: unknown): unknown {
  const parts = path.split('.');
  if (parts[0] !== 'provider') return value;
  if (parts.length === 1) return redactProviderMap(value);
  if (parts.length === 2) return redactProviderRecord(value);
  return parts[parts.length - 1] === 'apiKey' ? REDACTED_SECRET : value;
}

export function redactSettingsForDisplay<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const clone = structuredClone(value) as Record<string, unknown>;
  clone.provider = redactProviderMap(clone.provider);
  return clone as T;
}
