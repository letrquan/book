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
import type { AuthProfile } from './profiles.js';

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

export function missingClientIdMessage(profile: AuthProfile): string {
  const envKey = `BOOK_AUTH_CLIENT_ID_${profile.id.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
  return (
    `No OAuth client id configured for the "${profile.id}" profile. Book does not bundle ` +
    `vendor client ids — supply the one issued to you:\n` +
    `  ${envKey}=<client-id>\n` +
    `  or book config set auth.profiles.${profile.id}.clientId <client-id>`
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

  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: expiresIn !== undefined ? now + Math.max(0, expiresIn) * 1000 : undefined,
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
    },
    input,
  );
}

export interface RefreshInput {
  profile: AuthProfile;
  refreshToken: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: number;
}

export async function refreshAccessToken(input: RefreshInput): Promise<OAuthTokens> {
  if (!input.profile.clientId) throw new OAuthError(missingClientIdMessage(input.profile));
  const refreshed = await postForm(
    input.profile.tokenUrl,
    {
      grant_type: 'refresh_token',
      client_id: input.profile.clientId,
      refresh_token: input.refreshToken,
    },
    input,
  );
  // Rotation is optional: a server that returns no new refresh token expects
  // the old one to keep working. Dropping it would strand the credential.
  return { ...refreshed, refreshToken: refreshed.refreshToken ?? input.refreshToken };
}
