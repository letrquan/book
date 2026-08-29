/**
 * Credential shapes shared by the auth store, the OAuth client, and the
 * provider transports. Runtime-import free, like every other `src/types/*` file.
 */

/** How a request proves who it belongs to. */
export type AuthKind = 'api-key' | 'oauth';

/** An OAuth 2.0 token set as Book persists it. */
export interface OAuthTokens {
  accessToken: string;
  /** Absent when the authorization server issues no refresh token. */
  refreshToken?: string;
  /** Epoch milliseconds. Absent when the server returned no `expires_in`. */
  expiresAt?: number;
  /** Space-delimited scopes actually granted, which may narrow what was asked. */
  scope?: string;
  /** Token type as returned; anything but `Bearer` is rejected on exchange. */
  tokenType?: string;
  /**
   * Display-only account label (email, org name, subject id) parsed from the
   * token response. Never used for authorization — only to tell two logins
   * apart in `book auth status`.
   */
  account?: string;
}

/** One stored credential, keyed in the store by auth-profile id. */
export interface StoredCredential {
  kind: AuthKind;
  /** Auth profile this credential was issued for (`anthropic`, `codex`, …). */
  profile: string;
  /** Present only when `kind` is `api-key`. */
  apiKey?: string;
  /** Present only when `kind` is `oauth`. */
  tokens?: OAuthTokens;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

/** A credential rendered for display: every secret already removed. */
export interface RedactedCredential {
  profile: string;
  kind: AuthKind;
  account?: string;
  scope?: string;
  expiresAt?: number;
  /** True when an expired access token can still be renewed without a browser. */
  refreshable: boolean;
  createdAt: number;
  updatedAt: number;
}
