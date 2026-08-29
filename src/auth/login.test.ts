import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createState } from './pkce.js';
import { parsePastedRedirect, runOAuthLogin } from './login.js';
import { resolveAuthProfile, type AuthProfile } from './profiles.js';
import { readCredential } from './store.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'book-auth-login-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function profile(): AuthProfile {
  return {
    ...resolveAuthProfile('anthropic', undefined, {} as NodeJS.ProcessEnv)!,
    clientId: 'client-123',
  };
}

describe('parsePastedRedirect', () => {
  const state = createState();

  it('takes the code out of a redirect URL whose state matches', () => {
    expect(
      parsePastedRedirect(`http://localhost:54545/callback?code=abc&state=${state}`, state),
    ).toEqual({ code: 'abc' });
  });

  it('tolerates surrounding whitespace from a terminal paste', () => {
    expect(
      parsePastedRedirect(`  http://localhost:54545/callback?code=abc&state=${state}\n`, state),
    ).toEqual({ code: 'abc' });
  });

  it('rejects a URL from a different login attempt', () => {
    const result = parsePastedRedirect(
      `http://localhost:54545/callback?code=abc&state=${createState()}`,
      state,
    );
    expect(result).toEqual({ error: expect.stringMatching(/different login attempt/) });
  });

  it('reports the authorization server error rather than a missing code', () => {
    const result = parsePastedRedirect(
      `http://localhost:54545/callback?error=access_denied&error_description=nope&state=${state}`,
      state,
    );
    expect(result).toEqual({ error: expect.stringMatching(/access_denied: nope/) });
  });

  /**
   * Some consent screens show the code as text with nowhere to copy a URL from.
   * A bare code carries no state, leaving PKCE as the binding - which is what
   * PKCE is for.
   */
  it('accepts a bare authorization code', () => {
    expect(parsePastedRedirect('ac_012-abc~xyz', state)).toEqual({ code: 'ac_012-abc~xyz' });
  });

  it('rejects empty or unparseable input', () => {
    expect(parsePastedRedirect('   ', state)).toEqual({ error: 'No redirect URL entered' });
    expect(parsePastedRedirect('what? no.', state)).toEqual({
      error: expect.stringMatching(/Could not read that/),
    });
  });

  it('rejects a URL with no code at all', () => {
    expect(parsePastedRedirect('http://localhost:54545/callback', state)).toEqual({
      error: expect.stringMatching(/no authorization code/),
    });
  });
});

describe('manual login', () => {
  /** Manual mode binds no listener, so this exercises the flow end to end. */
  it('exchanges the pasted code and stores the credential', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    let authorizeUrl = '';
    const result = await runOAuthLogin({
      profile: profile(),
      manual: true,
      noBrowser: true,
      store: { home },
      now: 1_000_000,
      fetchImpl,
      events: {
        onAuthorizeUrl(url) {
          authorizeUrl = url;
        },
      },
      readRedirectUrl: async () => {
        // Echo back the state the flow generated, as a real browser would.
        const state = new URL(authorizeUrl).searchParams.get('state')!;
        return `http://localhost:54545/callback?code=pasted-code&state=${state}`;
      },
    });

    expect(result.tokens).toMatchObject({ accessToken: 'at', expiresAt: 4_600_000 });
    expect(readCredential('anthropic', { home })).toMatchObject({
      kind: 'oauth',
      profile: 'anthropic',
      tokens: { accessToken: 'at', refreshToken: 'rt' },
    });
  });

  it('sends the code verifier matching the challenge it advertised', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ access_token: 'at' }), { status: 200 });
    }) as unknown as typeof fetch;

    let authorizeUrl = '';
    await runOAuthLogin({
      profile: profile(),
      manual: true,
      noBrowser: true,
      store: { home },
      fetchImpl,
      events: {
        onAuthorizeUrl(url) {
          authorizeUrl = url;
        },
      },
      readRedirectUrl: async () =>
        `http://localhost:54545/callback?code=c&state=${new URL(authorizeUrl).searchParams.get('state')}`,
    });

    const { createHash } = await import('node:crypto');
    const verifier = new URLSearchParams(bodies[0]).get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      new URL(authorizeUrl).searchParams.get('code_challenge'),
    );
  });

  it('stores nothing when the pasted URL fails validation', async () => {
    await expect(
      runOAuthLogin({
        profile: profile(),
        manual: true,
        noBrowser: true,
        store: { home },
        events: { onAuthorizeUrl() {} },
        readRedirectUrl: async () => 'http://localhost:54545/callback?code=c&state=wrong',
      }),
    ).rejects.toThrow(/different login attempt/);
    expect(readCredential('anthropic', { home })).toBeUndefined();
  });

  it('refuses to start without a client id', async () => {
    await expect(
      runOAuthLogin({
        profile: { ...profile(), clientId: '' },
        manual: true,
        noBrowser: true,
        store: { home },
        events: { onAuthorizeUrl() {} },
        readRedirectUrl: async () => '',
      }),
    ).rejects.toThrow(/No OAuth client id configured/);
  });
});
