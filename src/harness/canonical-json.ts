import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization shared by the evidence ledger and the
 * workflow registry. Object keys are sorted, `undefined` members are dropped,
 * and non-finite numbers are rejected so the same logical value always hashes
 * to the same digest across processes and platforms.
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number is not canonical JSON.');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(',')}}`;
  }
  throw new Error(`Unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Domain-separated digest so registry hashes can never collide with record hashes. */
export function canonicalDigest(domain: string, value: unknown): string {
  return sha256Hex(`${domain}\0${canonicalize(value)}`);
}
