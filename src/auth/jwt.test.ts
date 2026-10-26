import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { decodeJwt, validateIdTokenClaims, verifyJwtSignature } from './jwt.js';

function token(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  sigFor?: (input: Buffer) => Buffer,
): string {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = sigFor ? sigFor(Buffer.from(`${h}.${p}`)).toString('base64url') : '';
  return `${h}.${p}.${s}`;
}

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = (key: KeyObject, extra: Record<string, unknown>) => ({
  ...key.export({ format: 'jwk' }),
  ...extra,
});
const jwks = {
  keys: [
    jwk(rsa.publicKey, { kid: 'r1', alg: 'RS256', use: 'sig' }),
    jwk(ec.publicKey, { kid: 'e1', alg: 'ES256' }),
  ],
};

describe('verifyJwtSignature', () => {
  it('accepts RS256 and ES256 tokens signed by the published key their kid names', () => {
    const rs = token({ alg: 'RS256', kid: 'r1' }, { sub: 'a' }, (input) =>
      sign('sha256', input, rsa.privateKey),
    );
    expect(() => verifyJwtSignature(decodeJwt(rs), jwks)).not.toThrow();
    const es = token({ alg: 'ES256', kid: 'e1' }, { sub: 'a' }, (input) =>
      sign('sha256', input, { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }),
    );
    expect(() => verifyJwtSignature(decodeJwt(es), jwks)).not.toThrow();
  });

  it('refuses none and HMAC algorithms, whatever the token says', () => {
    for (const alg of ['none', 'HS256', 'hs256', '']) {
      expect(() => verifyJwtSignature(decodeJwt(token({ alg, kid: 'r1' }, {})), jwks)).toThrow(
        /not accepted/,
      );
    }
  });

  it('refuses a signature from another key, a changed payload, and an unknown kid', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = token({ alg: 'RS256', kid: 'r1' }, { sub: 'a' }, (input) =>
      sign('sha256', input, other.privateKey),
    );
    expect(() => verifyJwtSignature(decodeJwt(forged), jwks)).toThrow(/does not verify/);

    const genuine = token({ alg: 'RS256', kid: 'r1' }, { sub: 'a' }, (input) =>
      sign('sha256', input, rsa.privateKey),
    );
    const [h, , s] = genuine.split('.');
    const swapped = `${h}.${Buffer.from('{"sub":"b"}').toString('base64url')}.${s}`;
    expect(() => verifyJwtSignature(decodeJwt(swapped), jwks)).toThrow(/does not verify/);

    expect(() =>
      verifyJwtSignature(decodeJwt(token({ alg: 'RS256', kid: 'nope' }, {})), jwks),
    ).toThrow(/no single RS256 key/);
  });

  it('refuses a token that is not three base64url segments', () => {
    expect(() => decodeJwt('a.b')).toThrow(/compact JWT/);
    expect(() => decodeJwt('a.b.c+d')).toThrow(/compact JWT/);
  });
});

describe('validateIdTokenClaims', () => {
  const base = {
    iss: 'https://issuer.example',
    aud: 'oaiapp_1',
    sub: 'user-1',
    nonce: 'n1',
    exp: 2_000_000_000,
  };
  const expected = {
    issuer: 'https://issuer.example',
    audience: 'oaiapp_1',
    nonce: 'n1',
    now: 1_900_000_000_000,
  };

  it('returns the subject of a token that passes every check', () => {
    expect(validateIdTokenClaims(base, expected)).toBe('user-1');
    expect(validateIdTokenClaims({ ...base, aud: ['x', 'oaiapp_1'] }, expected)).toBe('user-1');
  });

  it('names the claim that fails', () => {
    expect(() => validateIdTokenClaims({ ...base, iss: 'https://x' }, expected)).toThrow(
      /issued by/,
    );
    expect(() => validateIdTokenClaims({ ...base, aud: 'other' }, expected)).toThrow(
      /different client/,
    );
    expect(() => validateIdTokenClaims({ ...base, exp: 1_000 }, expected)).toThrow(/expired/);
    expect(() => validateIdTokenClaims({ ...base, nonce: 'n2' }, expected)).toThrow(/nonce/);
    expect(() => validateIdTokenClaims({ ...base, sub: '' }, expected)).toThrow(/no account/);
    expect(() => validateIdTokenClaims(base, { ...expected, subject: 'user-2' })).toThrow(
      /different ChatGPT account/,
    );
  });
});
