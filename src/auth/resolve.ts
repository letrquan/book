/**
 * Turning the selected credential into request headers.
 *
 * Called by both transports immediately before the fetch, for two reasons.
 * A run outlives its access token — a long session refreshes several times, and
 * a header baked into the frozen `AgentConfig` at startup would be stale by the
 * second compaction. And a token refreshed by one `book` process has to be
 * visible to the others, which means reading the store per request rather than
 * caching it for the process lifetime. The store is one small file; the read it
 * costs is noise beside the inference call it precedes.
 *
 * When no auth profile is active this returns exactly the headers the
 * transports sent before subscription auth existed, so the API-key path is
 * unchanged byte for byte.
 */
import { createDebugLogger } from '../debug-log.js';
import type { AgentConfig } from '../types/runtime.js';
import type { OAuthTokens } from '../types/auth.js';
import { OAuthError, refreshAccessToken } from './oauth.js';
import type { FetchLike } from './oauth.js';
import { resolveAuthProfile, type AuthProfile } from './profiles.js';
import { readCredential, writeCredential, type AuthStoreOptions } from './store.js';

const log = createDebugLogger('auth:resolve');

/**
 * Refresh this far before expiry.
 *
 * A token that expires mid-stream fails the whole turn, and a long tool call
 * can sit between the header being built and the request being answered.
 */
export const REFRESH_SKEW_MS = 120_000;

export function isExpired(
  tokens: OAuthTokens,
  now = Date.now(),
  skewMs = REFRESH_SKEW_MS,
): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt - skewMs <= now;
}

/**
 * One refresh per profile at a time.
 *
 * Parallel subagents share a process and hit expiry together; without this,
 * each would spend the same refresh token, and a server that rotates refresh
 * tokens invalidates every attempt but the first — logging the user out.
 */
const inFlight = new Map<string, Promise<OAuthTokens>>();

export interface AuthHeaderOptions {
  fetchImpl?: FetchLike;
  store?: AuthStoreOptions;
  now?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export class AuthResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthResolutionError';
  }
}

async function currentAccessToken(
  profile: AuthProfile,
  options: AuthHeaderOptions,
): Promise<string> {
  const credential = readCredential(profile.id, options.store);
  if (!credential) {
    throw new AuthResolutionError(
      `No credential stored for the "${profile.id}" profile. Run: book auth login ${profile.id}`,
    );
  }
  if (credential.kind === 'api-key') {
    if (!credential.apiKey) {
      throw new AuthResolutionError(`Stored "${profile.id}" credential carries no API key.`);
    }
    return credential.apiKey;
  }

  const tokens = credential.tokens;
  if (!tokens) {
    throw new AuthResolutionError(`Stored "${profile.id}" credential carries no tokens.`);
  }
  if (!isExpired(tokens, options.now ?? Date.now())) return tokens.accessToken;

  if (!tokens.refreshToken) {
    throw new AuthResolutionError(
      `The "${profile.id}" access token expired and no refresh token is stored. ` +
        `Run: book auth login ${profile.id}`,
    );
  }

  const pending =
    inFlight.get(profile.id) ??
    (async (): Promise<OAuthTokens> => {
      log.debug('refreshing access token', { profile: profile.id });
      const refreshed = await refreshAccessToken({
        profile,
        refreshToken: tokens.refreshToken!,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        now: options.now,
      });
      writeCredential(
        profile.id,
        { kind: 'oauth', tokens: { ...refreshed, account: refreshed.account ?? tokens.account } },
        { ...options.store, now: options.now },
      );
      return refreshed;
    })();

  inFlight.set(profile.id, pending);
  try {
    return (await pending).accessToken;
  } catch (error) {
    if (error instanceof OAuthError) {
      throw new AuthResolutionError(
        `Could not refresh the "${profile.id}" credential (${error.message}). ` +
          `Run: book auth login ${profile.id}`,
      );
    }
    throw error;
  } finally {
    if (inFlight.get(profile.id) === pending) inFlight.delete(profile.id);
  }
}

/** Test seam: drop any memoized in-flight refresh. */
export function resetRefreshState(): void {
  inFlight.clear();
}

/**
 * Headers for one provider request.
 *
 * `fallback` is what the transport would have sent on its own — the API-key
 * headers — and is returned untouched whenever no auth profile is active.
 */
export async function resolveAuthHeaders(
  config: AgentConfig,
  fallback: Record<string, string>,
  options: AuthHeaderOptions = {},
): Promise<Record<string, string>> {
  if (!config.authProfile) return fallback;

  const profile = resolveAuthProfile(config.authProfile, config.settings, options.env);
  if (!profile) {
    throw new AuthResolutionError(
      `Auth profile "${config.authProfile}" is no longer configured. ` +
        'Set auth.profile to "api-key" or restore the profile in settings.',
    );
  }

  const token = await currentAccessToken(profile, options);
  // The fallback headers are *replaced*, not merged: Anthropic rejects a
  // request carrying both `x-api-key` and an OAuth bearer token, so a stray
  // key in the environment must not ride along with a subscription token.
  return { Authorization: `Bearer ${token}`, ...profile.headers };
}
