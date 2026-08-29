import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.js';
import {
  authClientIdEnvVar,
  BUILT_IN_PROFILE_IDS,
  listAuthProfiles,
  profileOrigin,
  redirectUri,
  resolveAuthProfile,
} from './profiles.js';

const NO_ENV = {} as NodeJS.ProcessEnv;

function settingsWith(profiles: Record<string, unknown>) {
  return { auth: { profiles } } as unknown as Pick<typeof DEFAULT_SETTINGS, 'auth'>;
}

describe('built-in profiles', () => {
  it('ships anthropic and codex', () => {
    expect([...BUILT_IN_PROFILE_IDS].sort()).toEqual(['anthropic', 'codex']);
  });

  /**
   * The load-bearing claim of the whole feature: Book never presents itself to
   * a vendor's authorization server as that vendor's own client. If a client id
   * ever gets committed, this fails.
   */
  it('bundles no client id for any built-in profile', () => {
    for (const id of BUILT_IN_PROFILE_IDS) {
      expect(resolveAuthProfile(id, undefined, NO_ENV)?.clientId).toBe('');
    }
  });

  it('routes each profile to the transport that can spend its token', () => {
    expect(resolveAuthProfile('anthropic', undefined, NO_ENV)?.providerType).toBe('anthropic');
    expect(resolveAuthProfile('codex', undefined, NO_ENV)?.providerType).toBe('openai');
  });
});

describe('client id resolution', () => {
  it('reads the per-profile environment variable', () => {
    const profile = resolveAuthProfile('anthropic', undefined, {
      BOOK_AUTH_CLIENT_ID_ANTHROPIC: 'from-env',
    } as NodeJS.ProcessEnv);
    expect(profile?.clientId).toBe('from-env');
  });

  it('lets the environment outrank settings, like every other Book secret', () => {
    const profile = resolveAuthProfile(
      'anthropic',
      settingsWith({ anthropic: { clientId: 'from-settings' } }),
      { BOOK_AUTH_CLIENT_ID_ANTHROPIC: 'from-env' } as NodeJS.ProcessEnv,
    );
    expect(profile?.clientId).toBe('from-env');
  });

  it('falls back to settings when the environment says nothing', () => {
    const profile = resolveAuthProfile(
      'codex',
      settingsWith({ codex: { clientId: 'from-settings' } }),
      NO_ENV,
    );
    expect(profile?.clientId).toBe('from-settings');
  });
});

describe('overrides', () => {
  it('redirects a built-in profile at a self-hosted authorization server', () => {
    const profile = resolveAuthProfile(
      'anthropic',
      settingsWith({
        anthropic: {
          authorizeUrl: 'https://sso.example.com/authorize',
          tokenUrl: 'https://sso.example.com/token',
          baseUrl: 'https://gateway.example.com/v1',
          scopes: ['inference'],
        },
      }),
      NO_ENV,
    );
    expect(profile).toMatchObject({
      authorizeUrl: 'https://sso.example.com/authorize',
      baseUrl: 'https://gateway.example.com/v1',
      scopes: ['inference'],
      // Untouched fields keep the built-in value.
      providerType: 'anthropic',
      redirectPort: 54545,
    });
  });

  it('merges headers rather than replacing the built-in set', () => {
    const profile = resolveAuthProfile(
      'anthropic',
      settingsWith({ anthropic: { headers: { 'x-org': 'acme' } } }),
      NO_ENV,
    );
    expect(profile?.headers).toEqual({ 'anthropic-beta': 'oauth-2025-04-20', 'x-org': 'acme' });
  });

  it('accepts a wholly user-declared profile that supplies its own endpoints', () => {
    const profile = resolveAuthProfile(
      'internal',
      settingsWith({
        internal: {
          authorizeUrl: 'https://sso.example.com/authorize',
          tokenUrl: 'https://sso.example.com/token',
          baseUrl: 'https://gateway.example.com/v1',
          clientId: 'internal-client',
        },
      }),
      NO_ENV,
    );
    expect(profile).toMatchObject({ id: 'internal', clientId: 'internal-client' });
  });

  it('rejects a declared profile missing an endpoint instead of inventing one', () => {
    const profile = resolveAuthProfile(
      'internal',
      settingsWith({ internal: { clientId: 'internal-client' } }),
      NO_ENV,
    );
    expect(profile).toBeUndefined();
  });

  it('returns nothing for an unknown id, so a typo does not silently pick a vendor', () => {
    expect(resolveAuthProfile('anthropik', undefined, NO_ENV)).toBeUndefined();
  });
});

describe('listAuthProfiles', () => {
  it('includes user-declared profiles alongside the built-ins', () => {
    const ids = listAuthProfiles(
      settingsWith({
        internal: {
          authorizeUrl: 'https://sso.example.com/authorize',
          tokenUrl: 'https://sso.example.com/token',
          baseUrl: 'https://gateway.example.com/v1',
        },
      }),
      NO_ENV,
    ).map((profile) => profile.id);
    expect(ids).toEqual(['anthropic', 'codex', 'internal']);
  });
});

describe('redirectUri', () => {
  /**
   * The literal loopback address, never `localhost`: the listener binds
   * 127.0.0.1 only, so on a host where `localhost` resolves to ::1 first the
   * browser would get ECONNREFUSED and the login would die at the timeout
   * blaming the browser. RFC 8252 §7.3 says the same, and adds that `localhost`
   * is subject to the system proxy while a literal IP is not.
   */
  it('uses the literal loopback address the listener actually binds', () => {
    const profile = resolveAuthProfile('codex', undefined, NO_ENV)!;
    expect(redirectUri(profile)).toBe('http://127.0.0.1:1455/auth/callback');
    expect(redirectUri(profile, 3000)).toBe('http://127.0.0.1:3000/auth/callback');
  });
});

describe('profileOrigin', () => {
  it('reduces a base URL to the origin a credential may be sent to', () => {
    expect(profileOrigin('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com');
    expect(profileOrigin('https://api.anthropic.com')).toBe('https://api.anthropic.com');
  });

  it('yields nothing for an unparseable base URL, so the comparison fails closed', () => {
    expect(profileOrigin('not-a-url')).toBeUndefined();
    expect(profileOrigin('')).toBeUndefined();
  });
});

describe('client id and secret environment variables', () => {
  it('slugs a custom profile id the same way the reader and the error message do', () => {
    expect(authClientIdEnvVar('my-corp-sso')).toBe('BOOK_AUTH_CLIENT_ID_MY_CORP_SSO');
    expect(authClientIdEnvVar('anthropic')).toBe('BOOK_AUTH_CLIENT_ID_ANTHROPIC');
  });

  it('reads a confidential client secret from the environment', () => {
    const profile = resolveAuthProfile('anthropic', undefined, {
      BOOK_AUTH_CLIENT_SECRET_ANTHROPIC: 'shh',
    } as NodeJS.ProcessEnv);
    expect(profile?.clientSecret).toBe('shh');
  });

  it('leaves the secret unset for a public client, which is the normal case', () => {
    expect(resolveAuthProfile('anthropic', undefined, NO_ENV)?.clientSecret).toBeUndefined();
  });
});

/**
 * The profile id reaches `resolveAuthProfile` from a CLI argument and from
 * settings, so a bare index would let `constructor` resolve to a prototype
 * member typed as a profile - reported as a missing client id rather than an
 * unknown profile.
 */
describe('prototype keys are not profiles', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('rejects %s', (name) => {
    expect(resolveAuthProfile(name, undefined, NO_ENV)).toBeUndefined();
  });
});
