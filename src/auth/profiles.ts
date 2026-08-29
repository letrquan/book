/**
 * Subscription auth profiles.
 *
 * A profile is everything Book needs to run an OAuth 2.0 authorization-code
 * flow against one vendor and then spend the resulting token on that vendor's
 * inference API: the two endpoints, the scopes, the redirect shape, and the
 * headers the API wants for a token rather than an API key.
 *
 * ## Why no client id ships with Book
 *
 * Every field below is public endpoint metadata. The one field that is not —
 * `clientId` — identifies *which application* the authorization server is
 * releasing a subscription token to, and it is deliberately left empty. Book
 * shipping another vendor's first-party client id would make every Book user
 * appear to that vendor as their own official CLI, which is impersonation
 * whatever the intent behind it. So the id is configuration:
 *
 *   BOOK_AUTH_CLIENT_ID_ANTHROPIC=…            (env, per profile)
 *   auth.profiles.anthropic.clientId = "…"     (settings.json)
 *
 * `book auth login` says exactly this when the id is missing. Endpoints,
 * scopes, and the API base are overridable through the same settings block, so
 * a self-hosted or proxied authorization server needs no code change.
 */
import type { BookSettings } from '../settings.js';

export interface AuthProfile {
  id: string;
  label: string;
  /** Which transport spends the token. */
  providerType: 'anthropic' | 'openai';
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /**
   * Loopback redirect. Authorization servers register an exact redirect URI,
   * so the port is fixed rather than ephemeral; `0` means "any free port",
   * which only works against a server that accepts a wildcard port.
   */
  redirectPort: number;
  redirectPath: string;
  /** API base to use while this profile is the active credential. */
  baseUrl: string;
  /**
   * Extra headers the API requires for subscription traffic, sent alongside
   * the bearer token. Anthropic's OAuth surface needs a beta opt-in header;
   * most providers need nothing.
   */
  headers: Record<string, string>;
  /**
   * Model used when the profile is active and nothing else selected one.
   * Without it, logging in with a Claude subscription would still send Book's
   * generic `gpt-4o` default to api.anthropic.com.
   */
  defaultModel?: string;
  /** Empty until the user supplies one. See the module comment. */
  clientId: string;
  /**
   * Only for a *confidential* client, which a corporate authorization server
   * often issues by default. A loopback CLI is normally a public client and
   * needs none; PKCE, not a secret, is what binds the code to this process.
   */
  clientSecret?: string;
}

/**
 * Built-in profile metadata.
 *
 * These are defaults, not assertions: a vendor can move an endpoint or change a
 * scope name at any time, and the settings overrides exist so that does not
 * require a Book release.
 */
const BUILT_IN: Record<string, Omit<AuthProfile, 'clientId'>> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude subscription)',
    providerType: 'anthropic',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
    scopes: ['user:inference', 'user:profile'],
    redirectPort: 54545,
    redirectPath: '/callback',
    baseUrl: 'https://api.anthropic.com/v1',
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    defaultModel: 'claude-sonnet-5',
  },
  codex: {
    id: 'codex',
    label: 'OpenAI Codex (ChatGPT subscription)',
    providerType: 'openai',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    redirectPort: 1455,
    redirectPath: '/auth/callback',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    headers: {},
    defaultModel: 'gpt-5',
  },
};

export const BUILT_IN_PROFILE_IDS: readonly string[] = Object.freeze(Object.keys(BUILT_IN));

/** Reserved selection meaning "ignore any stored credential and use the API key". */
export const API_KEY_PROFILE = 'api-key';

/**
 * Environment variable carrying a profile's client id.
 *
 * Exported because `missingClientIdMessage` prints this name and must derive it
 * from the same expression that reads it — otherwise the error can name a
 * variable Book never looks at. The slug matters for custom ids:
 * `my-corp-sso` becomes `BOOK_AUTH_CLIENT_ID_MY_CORP_SSO`.
 */
export function authClientIdEnvVar(profileId: string): string {
  return `BOOK_AUTH_CLIENT_ID_${profileId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
}

/** Environment variable carrying a confidential client's secret, if it has one. */
export function authClientSecretEnvVar(profileId: string): string {
  return `BOOK_AUTH_CLIENT_SECRET_${profileId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
}

/**
 * Resolve a profile with settings and environment overrides applied.
 *
 * Returns undefined for an id that is neither built in nor declared in
 * settings, so a typo in `auth.profile` fails loudly at the call site instead
 * of silently falling back to a different vendor.
 */
export function resolveAuthProfile(
  profileId: string,
  settings?: Pick<BookSettings, 'auth'>,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfile | undefined {
  const profiles = settings?.auth?.profiles;
  // `Object.hasOwn`, not a bare index: `resolveAuthProfile('constructor')`
  // would otherwise return a prototype member typed as a profile.
  const override = profiles && Object.hasOwn(profiles, profileId) ? profiles[profileId] : undefined;
  const base = Object.hasOwn(BUILT_IN, profileId) ? BUILT_IN[profileId] : undefined;
  if (!base && !override) return undefined;

  // A wholly user-declared profile has to supply the endpoints itself.
  if (!base) {
    if (!override?.authorizeUrl || !override.tokenUrl || !override.baseUrl) return undefined;
  }

  const merged: Omit<AuthProfile, 'clientId'> = {
    id: profileId,
    label: override?.label ?? base?.label ?? profileId,
    providerType: override?.providerType ?? base?.providerType ?? 'openai',
    authorizeUrl: override?.authorizeUrl ?? base!.authorizeUrl,
    tokenUrl: override?.tokenUrl ?? base!.tokenUrl,
    scopes: override?.scopes ?? base?.scopes ?? [],
    redirectPort: override?.redirectPort ?? base?.redirectPort ?? 0,
    redirectPath: override?.redirectPath ?? base?.redirectPath ?? '/callback',
    baseUrl: override?.baseUrl ?? base!.baseUrl,
    headers: { ...(base?.headers ?? {}), ...(override?.headers ?? {}) },
    defaultModel: override?.defaultModel ?? base?.defaultModel,
  };

  return {
    ...merged,
    clientId: env[authClientIdEnvVar(profileId)]?.trim() || override?.clientId || '',
    clientSecret: env[authClientSecretEnvVar(profileId)]?.trim() || override?.clientSecret,
  };
}

/** Every profile a user could log into: built-ins plus anything settings declares. */
export function listAuthProfiles(
  settings?: Pick<BookSettings, 'auth'>,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfile[] {
  const ids = new Set([...BUILT_IN_PROFILE_IDS, ...Object.keys(settings?.auth?.profiles ?? {})]);
  return [...ids]
    .sort()
    .map((id) => resolveAuthProfile(id, settings, env))
    .filter((profile): profile is AuthProfile => profile !== undefined);
}

/**
 * The loopback redirect URI registered with the authorization server.
 *
 * The literal `127.0.0.1`, never `localhost`, per RFC 8252 §7.3 and for two
 * concrete reasons. `localhost` resolves to `::1` first on many hosts, where
 * the IPv4-only listener is not reachable and the login dies at the timeout
 * with a message blaming the browser. And `localhost` is subject to the system
 * proxy configuration, so an enterprise setup that does not bypass the proxy
 * for local names would route the authorization code through it.
 */
export function redirectUri(profile: AuthProfile, port = profile.redirectPort): string {
  return `http://127.0.0.1:${port}${profile.redirectPath}`;
}

/**
 * The origin a profile's credential may be presented to.
 *
 * `resolveAuthHeaders` compares this against the request's base URL, which is
 * what actually binds the token to a host. Returns undefined for a base URL
 * that will not parse, which fails the comparison closed.
 */
export function profileOrigin(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
}
