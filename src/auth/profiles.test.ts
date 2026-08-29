import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.js';
import {
  BUILT_IN_PROFILE_IDS,
  listAuthProfiles,
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
  it('binds to localhost on the profile port', () => {
    const profile = resolveAuthProfile('codex', undefined, NO_ENV)!;
    expect(redirectUri(profile)).toBe('http://localhost:1455/auth/callback');
    expect(redirectUri(profile, 3000)).toBe('http://localhost:3000/auth/callback');
  });
});
