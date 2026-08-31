/**
 * The `book auth login` flow, host-agnostic.
 *
 * Sequencing lives here rather than in `cli/auth-cmd.ts` so the TUI can drive
 * the same flow later without duplicating it. Every side effect the caller
 * might want to render — the URL, the wait, the outcome — is a callback.
 *
 * Two ways in:
 *
 * - **loopback** (default): a listener on 127.0.0.1 catches the redirect.
 * - **manual**: the same authorization URL, but the user pastes back the URL
 *   the browser landed on. This is the flow that works when the browser is on
 *   a different machine from the CLI, which is most remote development.
 */
import type { OAuthTokens, StoredCredential } from '../types/auth.js';
import { openInBrowser } from './browser.js';
import { LoopbackError, startLoopbackListener } from './loopback.js';
import { buildAuthorizeUrl, exchangeAuthorizationCode, missingClientIdMessage } from './oauth.js';
import type { FetchLike } from './oauth.js';
import { createPkcePair, createState, statesMatch } from './pkce.js';
import { redirectUri, type AuthProfile } from './profiles.js';
import { writeCredential, type AuthStoreOptions } from './store.js';

export const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;

export interface LoginEvents {
  /** The authorization URL, already printed by the caller if it wants to. */
  onAuthorizeUrl(url: string, opened: boolean): void;
  onWaiting?(detail: { port: number; timeoutMs: number }): void;
}

export interface LoginOptions {
  profile: AuthProfile;
  events: LoginEvents;
  /** Skip the loopback listener and read the redirect URL from the caller. */
  manual?: boolean;
  /** Supplies the pasted redirect URL in manual mode. */
  readRedirectUrl?: () => Promise<string>;
  noBrowser?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  store?: AuthStoreOptions;
  now?: number;
  platform?: NodeJS.Platform;
}

/**
 * Pull `code` out of a redirect URL the user pasted back.
 *
 * Accepts a bare code too: some consent screens show the code as text rather
 * than redirecting anywhere the user can copy a URL from. A bare code carries
 * no state to check, so PKCE is the only binding left — which is precisely
 * what PKCE is for.
 */
export function parsePastedRedirect(
  pasted: string,
  expectedState: string,
): { code: string } | { error: string } {
  const trimmed = pasted.trim();
  if (!trimmed) return { error: 'No redirect URL entered' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return /^[A-Za-z0-9._~+/=-]+$/.test(trimmed)
      ? { code: trimmed }
      : { error: 'Could not read that as a redirect URL or an authorization code' };
  }

  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description');
    return { error: `Authorization denied (${error}${description ? `: ${description}` : ''})` };
  }

  const code = url.searchParams.get('code');
  if (!code) return { error: 'That URL carries no authorization code' };

  const state = url.searchParams.get('state');
  if (state !== null && !statesMatch(expectedState, state)) {
    return { error: 'That URL belongs to a different login attempt (state mismatch)' };
  }
  return { code };
}

export interface LoginResult {
  credential: StoredCredential;
  tokens: OAuthTokens;
}

export async function runOAuthLogin(options: LoginOptions): Promise<LoginResult> {
  const { profile } = options;
  if (!profile.clientId) throw new Error(missingClientIdMessage(profile));

  const pkce = createPkcePair();
  const state = createState();
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

  // In manual mode the listener never binds, but the redirect URI still has to
  // be byte-identical to the one the authorization server has registered.
  const listener = options.manual
    ? undefined
    : await startLoopbackListener({
        port: profile.redirectPort,
        path: profile.redirectPath,
        expectedState: state,
        timeoutMs,
        signal: options.signal,
      });

  try {
    const uri = redirectUri(profile, listener?.port ?? profile.redirectPort);
    const authorizeUrl = buildAuthorizeUrl({
      profile,
      redirectUri: uri,
      codeChallenge: pkce.challenge,
      state,
    });

    const opened = options.noBrowser
      ? false
      : await openInBrowser(authorizeUrl, options.platform ?? process.platform);
    options.events.onAuthorizeUrl(authorizeUrl, opened);

    let code: string;
    if (listener) {
      options.events.onWaiting?.({ port: listener.port, timeoutMs });
      code = (await listener.result).code;
    } else {
      if (!options.readRedirectUrl) {
        throw new LoopbackError('Manual login needs a way to read the pasted redirect URL');
      }
      const parsed = parsePastedRedirect(await options.readRedirectUrl(), state);
      if ('error' in parsed) throw new Error(parsed.error);
      code = parsed.code;
    }

    const tokens = await exchangeAuthorizationCode({
      profile,
      code,
      codeVerifier: pkce.verifier,
      redirectUri: uri,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
      now: options.now,
    });

    const credential = writeCredential(
      profile.id,
      { kind: 'oauth', tokens },
      { ...options.store, now: options.now },
    );
    return { credential, tokens };
  } finally {
    listener?.close();
  }
}
