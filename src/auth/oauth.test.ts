import { describe, expect, it, vi } from 'vitest';
import {
  accountLabelFromIdToken,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  missingClientIdMessage,
  OAuthError,
  refreshAccessToken,
} from './oauth.js';
import { resolveAuthProfile, type AuthProfile } from './profiles.js';

function profile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  const base = resolveAuthProfile('anthropic', undefined, {} as NodeJS.ProcessEnv)!;
  return { ...base, clientId: 'client-123', ...overrides };
}

/** A fetch double that records the request and answers with a canned body. */
function stubFetch(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; form: URLSearchParams }> } {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      form: new URLSearchParams(String(init?.body ?? '')),
    });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('buildAuthorizeUrl', () => {
  it('carries PKCE, state, and the redirect the listener bound', () => {
    const url = new URL(
      buildAuthorizeUrl({
        profile: profile(),
        redirectUri: 'http://localhost:54545/callback',
        codeChallenge: 'challenge',
        state: 'state-value',
      }),
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-value');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:54545/callback');
    expect(url.searchParams.get('scope')).toBe('user:inference user:profile');
  });

  it('refuses to build a URL with no client id, naming both ways to set one', () => {
    expect(() =>
      buildAuthorizeUrl({
        profile: profile({ clientId: '' }),
        redirectUri: 'http://localhost:54545/callback',
        codeChallenge: 'c',
        state: 's',
      }),
    ).toThrow(OAuthError);
    const message = missingClientIdMessage(profile({ clientId: '' }));
    expect(message).toContain('BOOK_AUTH_CLIENT_ID_ANTHROPIC');
    expect(message).toContain('auth.profiles.anthropic.clientId');
  });
});

describe('exchangeAuthorizationCode', () => {
  it('posts the code and verifier as a form, and converts expires_in', async () => {
    const { fetchImpl, calls } = stubFetch(200, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'user:inference',
    });

    const tokens = await exchangeAuthorizationCode({
      profile: profile(),
      code: 'the-code',
      codeVerifier: 'the-verifier',
      redirectUri: 'http://localhost:54545/callback',
      fetchImpl,
      now: 1_000_000,
    });

    expect(calls[0].url).toBe('https://console.anthropic.com/v1/oauth/token');
    expect(Object.fromEntries(calls[0].form)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'client-123',
      code: 'the-code',
      code_verifier: 'the-verifier',
      redirect_uri: 'http://localhost:54545/callback',
    });
    expect(tokens).toMatchObject({ accessToken: 'at', refreshToken: 'rt', expiresAt: 4_600_000 });
  });

  it('surfaces an OAuth error body rather than a bare status', async () => {
    const { fetchImpl } = stubFetch(400, {
      error: 'invalid_grant',
      error_description: 'code already used',
    });
    await expect(
      exchangeAuthorizationCode({
        profile: profile(),
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'http://localhost/callback',
        fetchImpl,
      }),
    ).rejects.toThrow(/invalid_grant: code already used/);
  });

  it('rejects a 200 that carries an error instead of a token', async () => {
    const { fetchImpl } = stubFetch(200, { error: 'access_denied' });
    await expect(
      exchangeAuthorizationCode({
        profile: profile(),
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'http://localhost/callback',
        fetchImpl,
      }),
    ).rejects.toThrow(/access_denied/);
  });

  it('rejects a token type it would present incorrectly', async () => {
    const { fetchImpl } = stubFetch(200, { access_token: 'at', token_type: 'mac' });
    await expect(
      exchangeAuthorizationCode({
        profile: profile(),
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'http://localhost/callback',
        fetchImpl,
      }),
    ).rejects.toThrow(/Unsupported token_type "mac"/);
  });

  it('rejects a non-JSON response instead of parsing garbage', async () => {
    const { fetchImpl } = stubFetch(200, '<html>gateway</html>');
    await expect(
      exchangeAuthorizationCode({
        profile: profile(),
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'http://localhost/callback',
        fetchImpl,
      }),
    ).rejects.toThrow(/non-JSON response/);
  });
});

describe('refreshAccessToken', () => {
  it('keeps the old refresh token when the server rotates none', async () => {
    const { fetchImpl, calls } = stubFetch(200, { access_token: 'new-at', expires_in: 60 });
    const tokens = await refreshAccessToken({
      profile: profile(),
      refreshToken: 'old-rt',
      fetchImpl,
      now: 0,
    });
    expect(Object.fromEntries(calls[0].form)).toMatchObject({ grant_type: 'refresh_token' });
    expect(tokens).toMatchObject({ accessToken: 'new-at', refreshToken: 'old-rt' });
  });

  it('takes the rotated refresh token when one is returned', async () => {
    const { fetchImpl } = stubFetch(200, { access_token: 'new-at', refresh_token: 'new-rt' });
    const tokens = await refreshAccessToken({
      profile: profile(),
      refreshToken: 'old-rt',
      fetchImpl,
    });
    expect(tokens.refreshToken).toBe('new-rt');
  });
});

describe('accountLabelFromIdToken', () => {
  function idToken(payload: Record<string, unknown>): string {
    return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  }

  it('prefers email, then falls back through the usual claims', () => {
    expect(accountLabelFromIdToken(idToken({ email: 'a@b.c', sub: 'x' }))).toBe('a@b.c');
    expect(accountLabelFromIdToken(idToken({ sub: 'user-1' }))).toBe('user-1');
  });

  it('yields nothing for a malformed or absent token rather than throwing', () => {
    expect(accountLabelFromIdToken('not-a-jwt')).toBeUndefined();
    expect(accountLabelFromIdToken('a.!!!!.c')).toBeUndefined();
    expect(accountLabelFromIdToken(undefined)).toBeUndefined();
    expect(accountLabelFromIdToken(42)).toBeUndefined();
  });
});
