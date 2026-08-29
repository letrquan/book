import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_SETTINGS } from '../settings.js';
import type { AgentConfig } from '../types/runtime.js';
import {
  AuthResolutionError,
  describeExpiry,
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

/** Defaults to the anthropic profile's own origin, which the header path requires. */
function config(authProfile?: string, baseUrl = 'https://api.anthropic.com/v1'): AgentConfig {
  return {
    apiKey: 'sk-from-env',
    baseUrl,
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

/**
 * The credential is selected by profile id, but several things can change the
 * request's base URL afterwards - BOOK_BASE_URL, a repository-shipped legacy
 * .bookrc.json, a provider entry. This is the single place that sees both the
 * credential and its destination, so the binding is enforced here.
 */
describe('origin binding', () => {
  beforeEach(() => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'at', expiresAt: 10_000_000 } },
      { home },
    );
  });

  it('refuses to send the credential to a host the profile did not issue it for', async () => {
    await expect(
      resolveAuthHeaders(
        config('anthropic', 'https://collector.evil.example/v1'),
        {},
        { store: { home }, env: ENV, now: 0 },
      ),
    ).rejects.toThrow(
      /Refusing to send the "anthropic" credential to https:\/\/collector.evil.example/,
    );
  });

  it('names the overrides that could have caused it', async () => {
    await expect(
      resolveAuthHeaders(
        config('anthropic', 'https://openrouter.ai/api/v1'),
        {},
        { store: { home }, env: ENV, now: 0 },
      ),
    ).rejects.toThrow(/BOOK_BASE_URL/);
  });

  it('refuses before the credential is read, so nothing leaks on the way to the check', async () => {
    // No credential stored for this profile at all: the origin refusal must
    // still be what comes back, not "run book auth login".
    await expect(
      resolveAuthHeaders(
        config('codex', 'https://collector.evil.example/v1'),
        {},
        { store: { home }, env: ENV, now: 0 },
      ),
    ).rejects.toThrow(/Refusing to send/);
  });

  it('accepts a different path on the same origin', async () => {
    const headers = await resolveAuthHeaders(
      config('anthropic', 'https://api.anthropic.com'),
      {},
      { store: { home }, env: ENV, now: 0 },
    );
    expect(headers.Authorization).toBe('Bearer at');
  });

  it('accepts the profile endpoint the user redirected it to', async () => {
    const configured = config('anthropic', 'https://gateway.example.com/v1');
    configured.settings.auth = {
      profiles: { anthropic: { baseUrl: 'https://gateway.example.com/v1' } },
    } as typeof configured.settings.auth;

    const headers = await resolveAuthHeaders(configured, {}, { store: { home }, env: ENV, now: 0 });
    expect(headers.Authorization).toBe('Bearer at');
  });

  it('fails closed on a base URL that will not parse', async () => {
    await expect(
      resolveAuthHeaders(config('anthropic', 'not-a-url'), {}, { store: { home }, env: ENV }),
    ).rejects.toThrow(/Refusing to send/);
  });
});

/**
 * A cancelled turn must not fail the healthy turns sharing its refresh. The
 * de-duplication exists precisely because parallel subagents expire together.
 */
describe('cancellation is per caller', () => {
  it('does not abort the shared refresh when one caller gives up', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'old', refreshToken: 'rt', expiresAt: 0 } },
      { home },
    );

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      await gate;
      // The shared refresh must not carry any caller's signal.
      expect(init?.signal).toBeUndefined();
      return new Response(JSON.stringify({ access_token: 'new', expires_in: 3600 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const cancelled = new AbortController();
    const healthy = resolveAuthHeaders(
      config('anthropic'),
      {},
      { store: { home }, env: ENV, now: 1_000_000, fetchImpl },
    );
    const giving_up = resolveAuthHeaders(
      config('anthropic'),
      {},
      { store: { home }, env: ENV, now: 1_000_000, fetchImpl, signal: cancelled.signal },
    ).catch((error: Error) => error);

    cancelled.abort();
    expect(await giving_up).toBeInstanceOf(AuthResolutionError);

    release?.();
    await expect(healthy).resolves.toMatchObject({ Authorization: 'Bearer new' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/**
 * RFC 6749 §5.1 makes expires_in RECOMMENDED and scope OPTIONAL: a conformant
 * server omits them to mean "unchanged". Taking the response wholesale wrote
 * `expiresAt: undefined`, which reads as "never expires" - so the refresh token
 * was never spent again and the credential 401'd forever.
 */
describe('a sparse refresh response', () => {
  it('keeps the expiry and scope the response omitted', async () => {
    writeCredential(
      'anthropic',
      {
        kind: 'oauth',
        tokens: {
          accessToken: 'old',
          refreshToken: 'rt',
          expiresAt: 1_000,
          scope: 'user:inference',
          account: 'a@b.c',
        },
      },
      { home },
    );
    const fetchImpl = tokenResponse({ access_token: 'new', token_type: 'Bearer' });

    await resolveAuthHeaders(
      config('anthropic'),
      {},
      { store: { home }, env: ENV, now: 1_000_000, fetchImpl },
    );

    expect(readCredential('anthropic', { home })?.tokens).toEqual({
      accessToken: 'new',
      refreshToken: 'rt',
      expiresAt: 1_000,
      scope: 'user:inference',
      tokenType: 'Bearer',
      account: 'a@b.c',
    });
  });
});

/**
 * Two processes can both observe expiry and both spend the same refresh token.
 * On a rotating server the loser gets invalid_grant while the winner has
 * already written a good token to the shared store.
 */
describe('losing a cross-process refresh race', () => {
  it('uses the token another process just wrote instead of demanding a login', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'old', refreshToken: 'rt', expiresAt: 0 } },
      { home },
    );
    const fetchImpl = vi.fn(async () => {
      // The "other process" wins while this refresh is in flight.
      writeCredential(
        'anthropic',
        {
          kind: 'oauth',
          tokens: { accessToken: 'winner', refreshToken: 'rt2', expiresAt: 9_999_999_999 },
        },
        { home },
      );
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }) as unknown as typeof fetch;

    const headers = await resolveAuthHeaders(
      config('anthropic'),
      {},
      { store: { home }, env: ENV, now: 1_000_000, fetchImpl },
    );
    expect(headers.Authorization).toBe('Bearer winner');
  });

  it('still reports the failure when no other process helped', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'old', refreshToken: 'rt', expiresAt: 0 } },
      { home },
    );
    const fetchImpl = tokenResponse({ error: 'invalid_grant' }, 400);
    await expect(
      resolveAuthHeaders(
        config('anthropic'),
        {},
        { store: { home }, env: ENV, now: 1_000_000, fetchImpl },
      ),
    ).rejects.toThrow(/book auth login anthropic/);
  });
});

describe('describeExpiry', () => {
  it('uses the same skew the refresh path does', () => {
    const now = 1_000_000;
    // Inside the skew: already "expired" as far as the header path is
    // concerned, so doctor must not call it valid.
    expect(
      describeExpiry({ accessToken: 'a', expiresAt: now + 60_000, refreshToken: 'r' }, now),
    ).toBe('expired, refreshable');
    expect(describeExpiry({ accessToken: 'a', expiresAt: now + 60_000 }, now)).toBe(
      'expired, not refreshable',
    );
    expect(describeExpiry({ accessToken: 'a' }, now)).toBe('no stated expiry');
    expect(describeExpiry({ accessToken: 'a', expiresAt: now + 600_000 }, now)).toBe(
      'valid for 10m',
    );
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
