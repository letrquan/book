import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createPkcePair, createState, statesMatch } from './pkce.js';

describe('createPkcePair', () => {
  it('derives an S256 challenge from the verifier', () => {
    const pair = createPkcePair();
    expect(pair.method).toBe('S256');
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
  });

  it('produces RFC 7636-legal, URL-safe verifiers', () => {
    const { verifier } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('does not repeat a verifier across flows', () => {
    const seen = new Set(Array.from({ length: 32 }, () => createPkcePair().verifier));
    expect(seen.size).toBe(32);
  });
});

describe('statesMatch', () => {
  const state = createState();

  it('accepts the exact state', () => {
    expect(statesMatch(state, state)).toBe(true);
  });

  it('rejects a different, absent, or non-string state', () => {
    expect(statesMatch(state, createState())).toBe(false);
    expect(statesMatch(state, null)).toBe(false);
    expect(statesMatch(state, undefined)).toBe(false);
    // A prefix must not pass: length is compared before content.
    expect(statesMatch(state, state.slice(0, -1))).toBe(false);
  });
});
