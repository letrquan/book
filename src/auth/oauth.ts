/**
 * OAuth 2.0 authorization-code exchange and refresh.
 *
 * Deliberately thin: no SDK, no discovery document, no implicit grant. Book
 * only ever performs authorization-code-with-PKCE against a profile's two
 * configured endpoints, so everything else is surface that could go wrong.
 *
 * Token responses are parsed defensively. A server that answers 200 with an
 * error body, or with a `token_type` Book does not present correctly, must fail
 * here rather than three layers down as an opaque 401 on the first inference
 * call.
 */
import type { OAuthTokens } from '../types/auth.js';
import { authClientIdEnvVar, type AuthProfile } from './profiles.js';

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface AuthorizeUrlInput {
  profile: AuthProfile;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const { profile } = input;
  if (!profile.clientId) {
    throw new OAuthError(missingClientIdMessage(profile));
  }
  const url = new URL(profile.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', profile.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  if (profile.scopes.length > 0) url.searchParams.set('scope', profile.scopes.join(' '));
  return url.toString();
}

/**
 * The first thing a new user sees, so it must name a remedy that works.
 *
 * Not `book config set`: that writes the workspace-local layer, and the whole
 * `auth` block is read only from a trusted source, so the command refuses. The
 * two routes below are the ones that actually take effect.
 */
export function missingClientIdMessage(profile: AuthProfile): string {
  return (
    `No OAuth client id configured for the "${profile.id}" profile. Book does not bundle ` +
    `vendor client ids — supply the one issued to you, either:\n` +
    `  ${authClientIdEnvVar(profile.id)}=<client-id>\n` +
    `  or add it to <BOOK_HOME>/settings.json (normally ~/.book/settings.json):\n` +
    `    { "auth": { "profiles": { "${profile.id}": { "clientId": "<client-id>" } } } }`
  );
}

interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
  id_token?: unknown;
  account?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * Pull a human-readable account label out of an OIDC id_token.
 *
 * Display only — the payload is read without signature verification, so nothing
 * here may influence an authorization decision. It exists so `book auth status`
 * can say *which* account is logged in.
 */
export function accountLabelFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== 'string') return undefined;
  const segments = idToken.split('.');
  if (segments.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >;
    for (const key of ['email', 'preferred_username', 'name', 'sub']) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // A malformed or encrypted id_token simply yields no label.
  }
  return undefined;
}

/** Accept a number or a numeric string; reject anything else, including NaN. */
function finiteSeconds(raw: unknown): number | undefined {
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function parseTokenBody(body: TokenResponseBody, now: number): OAuthTokens {
  if (typeof body.error === 'string') {
    const detail = typeof body.error_description === 'string' ? `: ${body.error_description}` : '';
    throw new OAuthError(`Authorization server rejected the request (${body.error}${detail})`);
  }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new OAuthError('Authorization server returned no access_token');
  }
  const tokenType = typeof body.token_type === 'string' ? body.token_type : undefined;
  if (tokenType && tokenType.toLowerCase() !== 'bearer') {
    throw new OAuthError(`Unsupported token_type "${tokenType}"; Book only presents bearer tokens`);
  }

  // Coerced, not type-checked: `expires_in` is frequently serialized as a
  // string, and silently dropping it stores a credential that `isExpired`
  // treats as never expiring - so the refresh token is never spent and the
  // session hard-401s the moment the access token really dies. Rounded because
  // the store requires an integer timestamp, and a ZodError here would land
  // after the single-use authorization code has already been redeemed.
  const expiresIn = finiteSeconds(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: expiresIn !== undefined ? Math.round(now + expiresIn * 1000) : undefined,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
    tokenType,
    account:
      (typeof body.account === 'string' ? body.account : undefined) ??
      accountLabelFromIdToken(body.id_token),
  };
}

export type FetchLike = typeof fetch;

async function postForm(
  url: string,
  form: Record<string, string>,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal; now?: number },
): Promise<OAuthTokens> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
      signal: options.signal,
    });
  } catch (error) {
    throw new OAuthError(
      `Could not reach the token endpoint ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const text = await response.text();
  let body: TokenResponseBody;
  try {
    body = text ? (JSON.parse(text) as TokenResponseBody) : {};
  } catch {
    throw new OAuthError(
      `Token endpoint returned a non-JSON response (HTTP ${response.status})`,
      response.status,
    );
  }

  if (!response.ok) {
    const detail =
      typeof body.error === 'string'
        ? `${body.error}${typeof body.error_description === 'string' ? `: ${body.error_description}` : ''}`
        : `HTTP ${response.status}`;
    throw new OAuthError(`Token request failed (${detail})`, response.status);
  }

  return parseTokenBody(body, options.now ?? Date.now());
}

export interface ExchangeInput {
  profile: AuthProfile;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: number;
}

export async function exchangeAuthorizationCode(input: ExchangeInput): Promise<OAuthTokens> {
  if (!input.profile.clientId) throw new OAuthError(missingClientIdMessage(input.profile));
  return postForm(
    input.profile.tokenUrl,
    {
      grant_type: 'authorization_code',
      client_id: input.profile.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      ...clientSecretField(input.profile),
    },
    input,
  );
}

/**
 * `client_secret_post` for a confidential client, omitted entirely otherwise.
 *
 * A loopback CLI is normally a public client, where PKCE is the binding and no
 * secret exists. But a corporate authorization server - exactly what the
 * per-profile endpoint overrides exist to support - often issues confidential
 * clients only, and rejects a token request that carries no client credential.
 */
function clientSecretField(profile: AuthProfile): Record<string, string> {
  return profile.clientSecret ? { client_secret: profile.clientSecret } : {};
}

export interface RefreshInput {
  profile: AuthProfile;
  refreshToken: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: number;
}

/**
 * Fold a refresh response onto the tokens it replaces.
 *
 * RFC 6749 §5.1 makes `expires_in` merely RECOMMENDED and `scope` OPTIONAL —
 * a conformant server omits them to mean "unchanged". Taking the response
 * wholesale would overwrite them with undefined, and an undefined `expiresAt`
 * reads as "never expires": the stored refresh token would then never be spent
 * again and the credential would 401 forever with no recovery but a browser
 * round trip. Rotation is likewise optional, so an absent `refresh_token`
 * means the existing one still works.
 */
export function mergeRefreshedTokens(previous: OAuthTokens, refreshed: OAuthTokens): OAuthTokens {
  return {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? previous.refreshToken,
    expiresAt: refreshed.expiresAt ?? previous.expiresAt,
    scope: refreshed.scope ?? previous.scope,
    tokenType: refreshed.tokenType ?? previous.tokenType,
    account: refreshed.account ?? previous.account,
  };
}

export async function refreshAccessToken(input: RefreshInput): Promise<OAuthTokens> {
  if (!input.profile.clientId) throw new OAuthError(missingClientIdMessage(input.profile));
  return postForm(
    input.profile.tokenUrl,
    {
      grant_type: 'refresh_token',
      client_id: input.profile.clientId,
      refresh_token: input.refreshToken,
      ...clientSecretField(input.profile),
    },
    input,
  );
}
