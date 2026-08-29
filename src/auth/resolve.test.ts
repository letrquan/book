import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_SETTINGS } from '../settings.js';
import type { AgentConfig } from '../types/runtime.js';
import {
  AuthResolutionError,
  isExpired,
  REFRESH_SKEW_MS,
  resetRefreshState,
  resolveAuthHeaders,
} from './resolve.js';
import { readCredential, writeCredential } from './store.js';

let home: string;
const ENV = { BOOK_AUTH_CLIENT_ID_ANTHROPIC: 'client-123' } as NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'book-auth-resolve-'));
  resetRefreshState();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function config(authProfile?: string): AgentConfig {
  return {
    apiKey: 'sk-from-env',
    settings: structuredClone(DEFAULT_SETTINGS),
    authProfile,
  } as unknown as AgentConfig;
}

function tokenResponse(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe('the API-key path is unchanged', () => {
  it('returns the fallback headers verbatim when no profile is active', async () => {
    const fallback = { 'x-api-key': 'sk-from-env' };
    await expect(resolveAuthHeaders(config(), fallback, { store: { home } })).resolves.toBe(
      fallback,
    );
  });
});

describe('a valid token', () => {
  it('is presented as a bearer token with the profile headers', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'at', expiresAt: 10_000_000 } },
      { home },
    );
    const headers = await resolveAuthHeaders(
      config('anthropic'),
      { 'x-api-key': 'sk-from-env' },
      { store: { home }, env: ENV, now: 0 },
    );
    expect(headers).toEqual({
      Authorization: 'Bearer at',
      'anthropic-beta': 'oauth-2025-04-20',
    });
  });

  /**
   * Anthropic rejects a request carrying both x-api-key and a bearer token, so
   * a key left in the environment must not ride along with a subscription token.
   */
  it('drops the API-key header entirely rather than merging', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'at', expiresAt: 10_000_000 } },
      { home },
    );
    const headers = await resolveAuthHeaders(
      config('anthropic'),
      { 'x-api-key': 'sk-from-env' },
      { store: { home }, env: ENV, now: 0 },
    );
    expect(headers).not.toHaveProperty('x-api-key');
  });
});

describe('expiry', () => {
  it('treats a token inside the refresh skew as expired', () => {
    const now = 1_000_000;
    expect(isExpired({ accessToken: 'a', expiresAt: now + REFRESH_SKEW_MS - 1 }, now)).toBe(true);
    expect(isExpired({ accessToken: 'a', expiresAt: now + REFRESH_SKEW_MS + 1 }, now)).toBe(false);
  });

  it('treats a token with no stated expiry as valid', () => {
    expect(isExpired({ accessToken: 'a' }, Date.now())).toBe(false);
  });

  it('refreshes an expired token and persists the result', async () => {
    writeCredential(
      'anthropic',
      {
        kind: 'oauth',
        tokens: { accessToken: 'old', refreshToken: 'rt', expiresAt: 0, account: 'a@b.c' },
      },
      { home },
    );
    const fetchImpl = tokenResponse({ access_token: 'new', expires_in: 3600 });

    const headers = await resolveAuthHeaders(
      config('anthropic'),
      {},
      { store: { home }, env: ENV, now: 1_000_000, fetchImpl },
    );

    expect(headers.Authorization).toBe('Bearer new');
    const stored = readCredential('anthropic', { home });
    expect(stored?.tokens).toMatchObject({
      accessToken: 'new',
      // The server rotated none, so the old refresh token is kept.
      refreshToken: 'rt',
      // The refresh response carries no id_token; the known account survives.
      account: 'a@b.c',
    });
  });

  /**
   * Parallel subagents share a process and expire together. A server that
   * rotates refresh tokens would invalidate every concurrent attempt but the
   * first, logging the user out mid-run.
   */
  it('collapses concurrent refreshes into one token request', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'old', refreshToken: 'rt', expiresAt: 0 } },
      { home },
    );
    const fetchImpl = tokenResponse({ access_token: 'new', expires_in: 3600 });

    const headers = await Promise.all(
      Array.from({ length: 5 }, () =>
        resolveAuthHeaders(
          config('anthropic'),
          {},
          { store: { home }, env: ENV, now: 1_000_000, fetchImpl },
        ),
      ),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (const set of headers) expect(set.Authorization).toBe('Bearer new');
  });

  /** The single-flight entry is cleared on settle, not held for the process. */
  it('refreshes again once the replacement token has itself expired', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'old', refreshToken: 'rt', expiresAt: 0 } },
      { home },
    );
    // expires_in: 0 means the stored replacement is expired the moment it lands.
    const fetchImpl = tokenResponse({ access_token: 'new', expires_in: 0 });
    const options = { store: { home }, env: ENV, now: 1_000_000, fetchImpl };
    await resolveAuthHeaders(config('anthropic'), {}, options);
    await resolveAuthHeaders(config('anthropic'), {}, options);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not refresh a second time while the replacement is still valid', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'old', refreshToken: 'rt', expiresAt: 0 } },
      { home },
    );
    const fetchImpl = tokenResponse({ access_token: 'new', expires_in: 3600 });
    const options = { store: { home }, env: ENV, now: 1_000_000, fetchImpl };
    await resolveAuthHeaders(config('anthropic'), {}, options);
    const second = await resolveAuthHeaders(config('anthropic'), {}, options);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.Authorization).toBe('Bearer new');
  });
});

describe('actionable failures', () => {
  it('names the login command when nothing is stored', async () => {
    await expect(
      resolveAuthHeaders(config('anthropic'), {}, { store: { home }, env: ENV }),
    ).rejects.toThrow(/book auth login anthropic/);
  });

  it('names the login command when an expired token cannot be refreshed', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'old', expiresAt: 0 } },
      { home },
    );
    await expect(
      resolveAuthHeaders(config('anthropic'), {}, { store: { home }, env: ENV, now: 1_000_000 }),
    ).rejects.toThrow(/no refresh token is stored.*book auth login anthropic/s);
  });

  it('reports a rejected refresh as a login prompt, not a raw OAuth error', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'old', refreshToken: 'rt', expiresAt: 0 } },
      { home },
    );
    const fetchImpl = tokenResponse({ error: 'invalid_grant' }, 400);
    await expect(
      resolveAuthHeaders(config('anthropic'), {}, { store: { home }, env: ENV, now: 1, fetchImpl }),
    ).rejects.toThrow(/invalid_grant.*book auth login anthropic/s);
  });

  it('refuses a profile that settings no longer declare', async () => {
    await expect(
      resolveAuthHeaders(config('retired'), {}, { store: { home }, env: ENV }),
    ).rejects.toThrow(AuthResolutionError);
  });
});

describe('stored API keys', () => {
  it('spends an api-key credential without any OAuth traffic', async () => {
    writeCredential('anthropic', { kind: 'api-key', apiKey: 'sk-stored' }, { home });
    const headers = await resolveAuthHeaders(
      config('anthropic'),
      {},
      { store: { home }, env: ENV },
    );
    expect(headers.Authorization).toBe('Bearer sk-stored');
  });
});
