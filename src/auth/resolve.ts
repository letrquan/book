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
 * This is also the choke point that binds a credential to a *host*. Selection
 * decides which profile a run spends; only this function knows the URL the
 * token is about to be sent to, so the origin check lives here rather than
 * being re-derived at each of the several places that can change a base URL.
 *
 * When no auth profile is active this returns exactly the headers the
 * transports sent before subscription auth existed, so the API-key path is
 * unchanged byte for byte.
 */
import { createDebugLogger } from '../debug-log.js';
import type { AgentConfig } from '../types/runtime.js';
import type { OAuthTokens, StoredCredential } from '../types/auth.js';
import { mergeRefreshedTokens, OAuthError, refreshAccessToken } from './oauth.js';
import type { FetchLike } from './oauth.js';
import { profileOrigin, resolveAuthProfile, type AuthProfile } from './profiles.js';
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
 * One refresh per profile+store at a time.
 *
 * Parallel subagents share a process and hit expiry together; without this,
 * each would spend the same refresh token, and a server that rotates refresh
 * tokens invalidates every attempt but the first — logging the user out.
 *
 * Module-level state, against the codebase's usual rule, because the thing
 * being de-duplicated *is* process-wide: the callers are independent turns with
 * independent configs, and there is no object they share to hang it on. The key
 * includes the store path so an evaluation run pointed at its own BOOK_HOME
 * never joins the live session's refresh and silently receives its token.
 */
const inFlight = new Map<string, Promise<OAuthTokens>>();

/** Test seam: drop any memoized in-flight refresh. */
export function resetRefreshState(): void {
  inFlight.clear();
}

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

function refreshKey(profile: AuthProfile, options: AuthHeaderOptions): string {
  return `${options.store?.path ?? options.store?.home ?? ''} ${profile.id}`;
}

/** Let a caller give up on the shared refresh without cancelling it for anyone else. */
function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const cancel = (): void => reject(new AuthResolutionError('Request cancelled'));
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
    }),
  ]);
}

/**
 * Refresh, de-duplicated across concurrent callers.
 *
 * The shared request deliberately carries no AbortSignal. It used to inherit
 * whichever caller created it, so one subagent being cancelled — or the user
 * pressing Esc on an unrelated turn — aborted the refresh every other caller
 * was awaiting, failing healthy turns with "log in again" for a credential that
 * was fine. A token request is small and short; each caller races its own
 * signal against it instead.
 */
async function sharedRefresh(
  profile: AuthProfile,
  tokens: OAuthTokens,
  options: AuthHeaderOptions,
): Promise<OAuthTokens> {
  const key = refreshKey(profile, options);
  const pending =
    inFlight.get(key) ??
    (async (): Promise<OAuthTokens> => {
      log.debug('refreshing access token', { profile: profile.id });
      const refreshed = await refreshAccessToken({
        profile,
        refreshToken: tokens.refreshToken as string,
        fetchImpl: options.fetchImpl,
        now: options.now,
      });
      const merged = mergeRefreshedTokens(tokens, refreshed);
      writeCredential(
        profile.id,
        { kind: 'oauth', tokens: merged },
        { ...options.store, now: options.now },
      );
      return merged;
    })();

  inFlight.set(key, pending);
  try {
    return await raceSignal(pending, options.signal);
  } finally {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }
}

/**
 * Recover from losing a refresh race with another process.
 *
 * The in-flight map is process-local, so two `book` processes can both observe
 * expiry and both spend the same refresh token. On a server that rotates them,
 * the loser gets `invalid_grant` — while the winner has already written a
 * perfectly good token to the shared store. Re-reading before giving up turns a
 * spurious "log in again" into a no-op.
 */
function recoverFromStore(
  profile: AuthProfile,
  before: StoredCredential,
  options: AuthHeaderOptions,
): string | undefined {
  const tokens = readCredential(profile.id, options.store)?.tokens;
  if (!tokens || tokens.accessToken === before.tokens?.accessToken) return undefined;
  return isExpired(tokens, options.now ?? Date.now()) ? undefined : tokens.accessToken;
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

  try {
    return (await sharedRefresh(profile, tokens, options)).accessToken;
  } catch (error) {
    if (error instanceof AuthResolutionError) throw error;
    const recovered = recoverFromStore(profile, credential, options);
    if (recovered) {
      log.debug('another process refreshed first; using the stored token', { profile: profile.id });
      return recovered;
    }
    if (error instanceof OAuthError) {
      throw new AuthResolutionError(
        `Could not refresh the "${profile.id}" credential (${error.message}). ` +
          `Run: book auth login ${profile.id}`,
      );
    }
    throw error;
  }
}

/**
 * Refuse to present a profile's credential to anything but its own origin.
 *
 * The credential is selected by profile id, but several things can change the
 * URL a request goes to after that selection: `BOOK_BASE_URL`, a legacy
 * `.bookrc.json` (which a repository ships, and which bypasses the settings
 * trust layers entirely), a named `provider.<id>` entry. Guarding each of those
 * one at a time is a losing game — a subscription token is an account-wide
 * bearer credential, and the only place that knows both the credential and its
 * destination is here. So the rule is stated once, at the point of use.
 */
function assertOriginAllowed(profile: AuthProfile, baseUrl: string): void {
  const expected = profileOrigin(profile.baseUrl);
  const actual = profileOrigin(baseUrl);
  if (expected && actual && expected === actual) return;
  throw new AuthResolutionError(
    `Refusing to send the "${profile.id}" credential to ${actual ?? baseUrl}: it is issued for ` +
      `${expected ?? profile.baseUrl}. Clear the base-URL override (BOOK_BASE_URL, a legacy ` +
      `.bookrc.json, or provider.<id>.baseURL), point auth.profiles.${profile.id}.baseUrl at the ` +
      'host you mean, or set auth.profile to "api-key" and use an API key instead.',
  );
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

  assertOriginAllowed(profile, config.baseUrl);

  const token = await currentAccessToken(profile, options);
  // The fallback headers are *replaced*, not merged: Anthropic rejects a
  // request carrying both `x-api-key` and an OAuth bearer token, so a stray
  // key in the environment must not ride along with a subscription token.
  return { Authorization: `Bearer ${token}`, ...profile.headers };
}

export type AuthHeaderOutcome =
  { ok: true; headers: Record<string, string> } | { ok: false; message: string };

/**
 * `resolveAuthHeaders` as a result rather than an exception.
 *
 * The transports are async generators that must yield a stream error event
 * rather than throw. Converting here means one definition of how a credential
 * failure reaches the user, instead of two copies that drift.
 */
export async function tryResolveAuthHeaders(
  config: AgentConfig,
  fallback: Record<string, string>,
  options: AuthHeaderOptions = {},
): Promise<AuthHeaderOutcome> {
  try {
    return { ok: true, headers: await resolveAuthHeaders(config, fallback, options) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One rendering of a credential's expiry, shared by `book doctor` and
 * `book auth status`.
 *
 * Both used to derive it independently, and both dropped `REFRESH_SKEW_MS` — so
 * doctor could call a token "valid" that `resolveAuthHeaders` was about to
 * treat as expired, which is the opposite of what the diagnosing command is for.
 */
export function describeExpiry(tokens: OAuthTokens | undefined, now = Date.now()): string {
  if (!tokens) return 'no tokens stored';
  if (tokens.expiresAt === undefined) return 'no stated expiry';
  if (isExpired(tokens, now)) {
    return tokens.refreshToken ? 'expired, refreshable' : 'expired, not refreshable';
  }
  const minutes = Math.round((tokens.expiresAt - now) / 60_000);
  return minutes < 60
    ? `valid for ${minutes}m`
    : `valid until ${new Date(tokens.expiresAt).toISOString()}`;
}
