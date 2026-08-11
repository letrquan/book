import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export const Sha256DigestSchema = z.string().regex(SHA256_PATTERN);
export const SafeEvaluationIdSchema = z.string().regex(SAFE_ID_PATTERN);

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) {
        throw new TypeError('Canonical JSON rejects lone UTF-16 surrogates.');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('Canonical JSON rejects lone UTF-16 surrogates.');
    }
  }
}

function serializeCanonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON accepts only finite I-JSON numbers.');
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON cannot encode ${typeof value}.`);
  }

  if (ancestors.has(value)) throw new TypeError('Canonical JSON cannot encode cycles.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.some(
          (key) =>
            typeof key !== 'string' ||
            (key !== 'length' && !/^0$|^[1-9]\d*$/.test(key)) ||
            (key !== 'length' && !Object.getOwnPropertyDescriptor(value, key)?.enumerable) ||
            (key !== 'length' && !('value' in Object.getOwnPropertyDescriptor(value, key)!)),
        )
      ) {
        throw new TypeError('Canonical JSON arrays cannot have named properties.');
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError('Canonical JSON arrays cannot be sparse.');
      }
      return `[${value.map((item) => serializeCanonicalJson(item, ancestors)).join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON accepts only plain JSON objects.');
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => {
        if (typeof key !== 'string') return true;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !('value' in descriptor);
      })
    ) {
      throw new TypeError('Canonical JSON accepts only enumerable string-keyed data properties.');
    }
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries
      .map(([key, item]) => {
        assertUnicodeScalarString(key);
        return `${JSON.stringify(key)}:${serializeCanonicalJson(item, ancestors)}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Serialize an I-JSON value with the deterministic ordering and ECMAScript primitive rendering
 * required by RFC 8785 (JSON Canonicalization Scheme).
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonicalJson(value, new Set());
}

export function evaluationDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
