/**
 * The JWT checks Sign in with ChatGPT needs: decode, verify the signature against a JWKS, and
 * validate an ID token's claims. `node:crypto` imports a JWK directly, so no JOSE dependency.
 *
 * Only asymmetric algorithms on an allowlist are accepted. `none` and every HMAC algorithm are
 * refused outright: a token that names one is signed with nothing the issuer published.
 */

import { createPublicKey, verify as verifySignature, type JsonWebKeyInput } from 'node:crypto';

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  /** `<header>.<payload>`, exactly as received: what the signature covers. */
  signingInput: string;
  signature: Buffer;
}

const ALGORITHMS: Readonly<
  Record<string, { kty: string; hash: string; dsaEncoding?: 'ieee-p1363' }>
> = {
  RS256: { kty: 'RSA', hash: 'sha256' },
  RS384: { kty: 'RSA', hash: 'sha384' },
  RS512: { kty: 'RSA', hash: 'sha512' },
  ES256: { kty: 'EC', hash: 'sha256', dsaEncoding: 'ieee-p1363' },
  ES384: { kty: 'EC', hash: 'sha384', dsaEncoding: 'ieee-p1363' },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeSegment(segment: string, what: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (isRecord(parsed)) return parsed;
  } catch {
    // reported below
  }
  throw new Error(`The token's ${what} is not a JSON object.`);
}

/** Split and decode a compact JWS. Throws on anything that is not three base64url segments. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) {
    throw new Error('The token is not a compact JWT.');
  }
  return {
    header: decodeSegment(parts[0], 'header'),
    payload: decodeSegment(parts[1], 'payload'),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

/**
 * Verify a decoded token's signature with the issuer's published keys. The key is chosen by
 * `kid`; a token without one is accepted only when exactly one published key fits its algorithm.
 */
export function verifyJwtSignature(token: DecodedJwt, jwks: unknown): void {
  const alg = typeof token.header.alg === 'string' ? token.header.alg : '';
  const spec = Object.hasOwn(ALGORITHMS, alg) ? ALGORITHMS[alg] : undefined;
  if (!spec) throw new Error(`The token's signing algorithm "${alg || 'none'}" is not accepted.`);
  const keys = isRecord(jwks) && Array.isArray(jwks.keys) ? jwks.keys.filter(isRecord) : [];
  const kid = typeof token.header.kid === 'string' ? token.header.kid : undefined;
  const fitting = keys.filter(
    (key) =>
      key.kty === spec.kty &&
      (key.alg === undefined || key.alg === alg) &&
      (key.use === undefined || key.use === 'sig') &&
      (kid === undefined || key.kid === kid),
  );
  if (fitting.length !== 1) {
    throw new Error(
      kid
        ? `The issuer publishes no single ${alg} key with id "${kid}".`
        : `The token names no key id and the issuer publishes ${fitting.length} ${alg} keys.`,
    );
  }
  let valid = false;
  try {
    const key = createPublicKey({ key: fitting[0] as JsonWebKeyInput['key'], format: 'jwk' });
    valid = verifySignature(
      spec.hash,
      Buffer.from(token.signingInput),
      spec.dsaEncoding ? { key, dsaEncoding: spec.dsaEncoding } : key,
      token.signature,
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("The token's signature does not verify against the issuer's keys.");
}

export interface IdTokenExpectations {
  issuer: string;
  /** The OAuth client the token must be issued to (`aud`). */
  audience: string;
  /** The nonce the authorization request carried; omitted for a refresh. */
  nonce?: string;
  /** The account the token must belong to (`sub`), when one is already known. */
  subject?: string;
  /** Milliseconds since the epoch; defaults to now. */
  now?: number;
}

/** Clock skew tolerated on `exp`, in seconds. */
const LEEWAY_SECONDS = 120;

/** Check an ID token's claims. Returns its `sub`; throws naming the first claim that fails. */
export function validateIdTokenClaims(
  payload: Record<string, unknown>,
  expected: IdTokenExpectations,
): string {
  if (payload.iss !== expected.issuer) {
    throw new Error(`The ID token was issued by "${String(payload.iss)}", not ${expected.issuer}.`);
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(expected.audience)) {
    throw new Error('The ID token was issued to a different client.');
  }
  const nowSeconds = (expected.now ?? Date.now()) / 1000;
  if (typeof payload.exp !== 'number' || payload.exp + LEEWAY_SECONDS < nowSeconds) {
    throw new Error('The ID token has expired.');
  }
  if (expected.nonce !== undefined && payload.nonce !== expected.nonce) {
    throw new Error("The ID token's nonce does not match this sign-in.");
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('The ID token names no account.');
  }
  if (expected.subject !== undefined && payload.sub !== expected.subject) {
    throw new Error('The ID token belongs to a different ChatGPT account.');
  }
  return payload.sub;
}
