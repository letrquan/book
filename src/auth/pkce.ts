/**
 * PKCE (RFC 7636) and the CSRF state parameter.
 *
 * The loopback redirect is the weak point of a desktop OAuth flow: any local
 * process can race the listener or replay a captured authorization code. PKCE
 * binds the code to a verifier only this process knows, and `state` binds the
 * callback to the request Book actually started.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** 32 random bytes → a 43-character verifier, the RFC's recommended shape. */
export function createPkcePair(random: (size: number) => Buffer = randomBytes): PkcePair {
  const verifier = base64Url(random(32));
  return {
    verifier,
    challenge: base64Url(createHash('sha256').update(verifier).digest()),
    method: 'S256',
  };
}

export function createState(random: (size: number) => Buffer = randomBytes): string {
  return base64Url(random(32));
}

/**
 * Compare the returned `state` without leaking its length or content through
 * timing. A mismatch means the callback belongs to some other flow.
 */
export function statesMatch(expected: string, received: string | null | undefined): boolean {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(received, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
