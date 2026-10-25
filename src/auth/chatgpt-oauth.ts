/**
 * Sign in with ChatGPT, the self-serve route OpenAI documents for open-source and locally hosted
 * apps (https://developers.openai.com/siwc/token-sharing-open-source). Experimental and opt-in:
 * nothing here runs unless the user signs in, and the tokens are used only for a provider entry
 * of `type: "chatgpt"` in the user's own settings.
 *
 * The flow, as OpenAI documents it:
 * - The host id (`ext_agent_host_id`) is chosen and saved before the first sign-in.
 * - A loopback listener on `127.0.0.1` receives the redirect. Every attempt has fresh state,
 *   nonce and PKCE (S256) values.
 * - The first sign-in registers a client dynamically (`client_id=dynamic_agent_client`), and the
 *   redirect returns the issued client id, which is saved and reused for every later sign-in.
 * - The code is exchanged with PKCE. The ID token is verified against the issuer's JWKS (issuer,
 *   audience, expiry, nonce), and the grant must include `chatgpt.tokens.use.direct`, the plan
 *   scope.
 * - Access tokens last an hour. They are refreshed near expiry, and once on a 401, under a
 *   cross-process lock, because refresh tokens rotate.
 * - Sign-out revokes the refresh token at the issuer's `revocation_endpoint`, then clears the
 *   tokens. The registration and host id are kept.
 *
 * No `id_token_hint` is ever sent. The authorize URL is shown to the user, and the TUI
 * transcript is saved with the session, so the URL must carry nothing secret.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { delay } from '../async.js';
import {
  chatGptSigninPath,
  ensureChatGptSignin,
  readChatGptSignin,
  withChatGptSigninLock,
  writeChatGptSignin,
  type ChatGptTokens,
} from './chatgpt-store.js';
import { decodeJwt, validateIdTokenClaims, verifyJwtSignature } from './jwt.js';

export const CHATGPT_ISSUER = 'https://auth.openai.com';
/** Plan-billed inference goes here, and nowhere else (not ChatGPT's `backend-api`). */
export const CHATGPT_API_BASE = 'https://api.openai.com/v1';
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  CHATGPT_PLAN_SCOPE,
] as const;
export const CHATGPT_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const CHATGPT_AGENT_NAME = 'Book';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage';
export const CHATGPT_LOGIN_COMMAND = 'book auth login';
/** Where a user disconnects Book from their account, as OpenAI's help describes it. */
export const CHATGPT_DISCONNECT_PATH =
  'ChatGPT Settings > Security and login > Sign in with ChatGPT > Book > Disconnect';

/** Test-only overrides, honoured only for a loopback server so they can never carry tokens away. */
export const CHATGPT_ISSUER_ENV = 'BOOK_CHATGPT_ISSUER';
export const CHATGPT_API_BASE_ENV = 'BOOK_CHATGPT_API_BASE';

/** Refresh an access token this close to its expiry. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000;

/** Refresh errors after which the refresh token is unusable, per OpenAI's errors page. */
const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

export interface ChatGptEndpoints {
  issuer: string;
  authorize: string;
  token: string;
  apiBase: string;
}

/** The run has no usable sign-in: the message names the command that fixes it. */
export class ChatGptSignInRequiredError extends Error {
  constructor(reason: string) {
    super(`${reason} Run \`${CHATGPT_LOGIN_COMMAND}\` to sign in with ChatGPT.`);
    this.name = 'ChatGptSignInRequiredError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loopbackOverride(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL.`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(
      `${name} may only name a loopback test server (http://127.0.0.1:<port>); unset it to use OpenAI.`,
    );
  }
  return raw.replace(/\/+$/, '');
}

export function chatGptEndpoints(env: NodeJS.ProcessEnv = process.env): ChatGptEndpoints {
  const issuer = loopbackOverride(env, CHATGPT_ISSUER_ENV) ?? CHATGPT_ISSUER;
  return {
    issuer,
    authorize: `${issuer}/api/accounts/authorize`,
    token: `${issuer}/api/accounts/oauth/token`,
    apiBase: loopbackOverride(env, CHATGPT_API_BASE_ENV) ?? CHATGPT_API_BASE,
  };
}

export interface ChatGptRequestOptions {
  /** The record's path; defaults to `<BOOK_HOME>/chatgpt-signin.json`. */
  path?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Milliseconds since the epoch; defaults to `Date.now`. */
  now?: () => number;
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function getJson(
  url: string,
  options: ChatGptRequestOptions,
): Promise<Record<string, unknown>> {
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: requestSignal(options.signal),
  });
  if (!response.ok) throw new Error(`GET ${url} answered HTTP ${response.status}.`);
  return readJson(response);
}

async function postForm(
  url: string,
  fields: Record<string, string>,
  options: ChatGptRequestOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'error',
    signal: requestSignal(options.signal),
  });
  return { status: response.status, body: await readJson(response) };
}

interface Discovery {
  jwksUri: string;
  revocationEndpoint?: string;
}

async function discover(
  endpoints: ChatGptEndpoints,
  options: ChatGptRequestOptions,
): Promise<Discovery> {
  const document = await getJson(`${endpoints.issuer}/.well-known/openid-configuration`, options);
  if (document.issuer !== endpoints.issuer) {
    throw new Error(`The OpenID configuration names issuer "${String(document.issuer)}".`);
  }
  if (typeof document.jwks_uri !== 'string') {
    throw new Error('The OpenID configuration names no jwks_uri.');
  }
  return {
    jwksUri: document.jwks_uri,
    ...(typeof document.revocation_endpoint === 'string'
      ? { revocationEndpoint: document.revocation_endpoint }
      : {}),
  };
}

async function verifiedIdTokenClaims(
  idToken: string,
  expected: { audience: string; nonce?: string; subject?: string },
  endpoints: ChatGptEndpoints,
  options: ChatGptRequestOptions,
): Promise<Record<string, unknown>> {
  const decoded = decodeJwt(idToken);
  const { jwksUri } = await discover(endpoints, options);
  verifyJwtSignature(decoded, await getJson(jwksUri, options));
  validateIdTokenClaims(decoded.payload, {
    issuer: endpoints.issuer,
    ...expected,
    now: (options.now ?? Date.now)(),
  });
  return decoded.payload;
}

function epochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** A token endpoint's answer as stored tokens; `previous` supplies what a refresh may omit. */
function tokensFromResponse(
  body: Record<string, unknown>,
  now: number,
  previous?: ChatGptTokens,
  callbackScope?: string,
): ChatGptTokens {
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('The token endpoint returned no access token.');
  }
  const idToken = typeof body.id_token === 'string' ? body.id_token : previous?.idToken;
  if (!idToken) throw new Error('The token endpoint returned no ID token.');
  const scope =
    typeof body.scope === 'string' ? body.scope : (callbackScope ?? previous?.scopes.join(' '));
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  const refreshToken =
    typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refreshToken;
  const earliestRefreshAt = epochMs(body.earliest_refresh_at);
  return {
    accessToken: body.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    idToken,
    expiresAt: now + expiresIn * 1000,
    ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}),
    scopes: (scope ?? '').split(/\s+/).filter(Boolean),
    savedAt: now,
  };
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken();
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function chatGptAuthorizeUrl(input: {
  endpoints: ChatGptEndpoints;
  clientId: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.endpoints.authorize);
  const params: Array<[string, string]> = [
    ['client_id', input.clientId],
    // Named only at registration; a reauthorization omits it.
    ...(input.clientId === CHATGPT_DYNAMIC_CLIENT_ID
      ? [['agent_name_hint', CHATGPT_AGENT_NAME] as [string, string]]
      : []),
    ['ext_agent_host_id', input.hostId],
    ['response_type', 'code'],
    ['redirect_uri', input.redirectUri],
    ['scope', CHATGPT_SCOPES.join(' ')],
    ['resource', input.endpoints.apiBase],
    ['state', input.state],
    ['nonce', input.nonce],
    ['code_challenge_method', 'S256'],
    ['code_challenge', input.codeChallenge],
  ];
  for (const [key, value] of params) url.searchParams.set(key, value);
  return url.toString();
}

const CALLBACK_PATH = '/auth/callback';

interface LoopbackCallback {
  redirectUri: string;
  /** The first request to the callback path, held open until `finish` answers it. */
  received: Promise<URLSearchParams>;
  finish(ok: boolean, message: string): void;
  close(): Promise<void>;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function startLoopback(timeoutMs: number, signal?: AbortSignal): Promise<LoopbackCallback> {
  let pending: ServerResponse | undefined;
  let resolveReceived!: (params: URLSearchParams) => void;
  let rejectReceived!: (error: Error) => void;
  const received = new Promise<URLSearchParams>((resolve, reject) => {
    resolveReceived = resolve;
    rejectReceived = reject;
  });
  // Handled here so an abandoned flow cannot surface as an unhandled rejection.
  received.catch(() => undefined);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || pending) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    pending = res;
    resolveReceived(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(
    () => rejectReceived(new Error('Timed out waiting for the browser to finish signing in.')),
    timeoutMs,
  );
  timer.unref?.();
  const onAbort = (): void => rejectReceived(new Error('Sign-in cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  return {
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    received,
    finish(ok, message) {
      if (!pending || pending.writableEnded) return;
      pending
        .writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(
          `<!doctype html><meta charset="utf-8"><title>Book</title><p>${escapeHtml(message)}</p>`,
        );
    },
    close: () =>
      new Promise<void>((resolve) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

export interface ChatGptLoginOptions extends ChatGptRequestOptions {
  /** Called with the authorize URL before the browser opens, so it can always be printed. */
  onAuthorizeUrl?: (url: string) => void;
  /** Opens the URL; omitted, nothing is opened and the user follows the printed URL. */
  openBrowser?: (url: string) => Promise<unknown> | unknown;
  /** Register a new client instead of reusing the saved one (another ChatGPT account). */
  newRegistration?: boolean;
  timeoutMs?: number;
}

export interface ChatGptLoginResult {
  clientId: string;
  subject: string;
  email?: string;
  expiresAt: number;
  /** True the first time plan usage is enabled on this host: show the plan-usage notice. */
  firstSignIn: boolean;
  newRegistration: boolean;
}

/** Run the browser sign-in once. Throws, saving nothing, on any failed check. */
export async function signInWithChatGpt(
  options: ChatGptLoginOptions = {},
): Promise<ChatGptLoginResult> {
  const endpoints = chatGptEndpoints(options.env);
  const path = options.path ?? chatGptSigninPath();
  const now = options.now ?? Date.now;
  const record = ensureChatGptSignin(path);
  const saved = options.newRegistration ? undefined : record.account;
  const requestedClientId = saved?.clientId ?? CHATGPT_DYNAMIC_CLIENT_ID;
  const state = randomToken();
  const nonce = randomToken();
  const pkce = pkcePair();
  const loopback = await startLoopback(
    options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    options.signal,
  );
  try {
    const url = chatGptAuthorizeUrl({
      endpoints,
      clientId: requestedClientId,
      hostId: record.hostId,
      redirectUri: loopback.redirectUri,
      state,
      nonce,
      codeChallenge: pkce.challenge,
    });
    options.onAuthorizeUrl?.(url);
    // Not awaited: the browser's request is the callback this flow is about to wait for. A
    // failure to open one is not an error, since the printed URL is the fallback.
    void Promise.resolve()
      .then(() => options.openBrowser?.(url))
      .catch(() => undefined);

    const params = await loopback.received;
    if (params.get('state') !== state) {
      throw new Error('The sign-in response does not belong to this attempt (state mismatch).');
    }
    const error = params.get('error');
    if (error) {
      throw new Error(
        error === 'access_denied'
          ? 'Sign-in was declined in the browser.'
          : `Sign-in failed: ${error}${params.get('error_description') ? ` (${params.get('error_description')})` : ''}.`,
      );
    }
    const code = params.get('code');
    if (!code) throw new Error('The sign-in response carried no authorization code.');
    const returnedClientId = params.get('client_id');
    let clientId: string;
    if (requestedClientId === CHATGPT_DYNAMIC_CLIENT_ID) {
      if (!returnedClientId || returnedClientId === CHATGPT_DYNAMIC_CLIENT_ID) {
        throw new Error('The registration returned no client id.');
      }
      clientId = returnedClientId;
    } else {
      if (returnedClientId && returnedClientId !== requestedClientId) {
        throw new Error('The sign-in response names a different client than this host registered.');
      }
      clientId = requestedClientId;
    }

    const exchanged = await postForm(
      endpoints.token,
      {
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: pkce.verifier,
        redirect_uri: loopback.redirectUri,
        resource: endpoints.apiBase,
      },
      options,
    );
    if (exchanged.status !== 200) {
      const reason = typeof exchanged.body.error === 'string' ? exchanged.body.error : '';
      throw new Error(
        `The code exchange failed (HTTP ${exchanged.status}${reason ? `, ${reason}` : ''}). Sign in again.`,
      );
    }
    const tokens = tokensFromResponse(
      exchanged.body,
      now(),
      undefined,
      params.get('scope') ?? undefined,
    );
    const claims = await verifiedIdTokenClaims(
      tokens.idToken,
      // A saved registration is bound to its account: another account must not replace it.
      { audience: clientId, nonce, ...(saved ? { subject: saved.subject } : {}) },
      endpoints,
      options,
    );
    if (!tokens.scopes.includes(CHATGPT_PLAN_SCOPE)) {
      throw new Error(
        `ChatGPT plan usage was not granted (the ${CHATGPT_PLAN_SCOPE} scope is missing). ` +
          'Sign in again and allow Book to use your plan.',
      );
    }

    const subject = claims.sub as string;
    const email = typeof claims.email === 'string' ? claims.email : undefined;
    const firstSignIn = record.welcomed !== true;
    await withChatGptSigninLock(path, async () => {
      const latest = readChatGptSignin(path) ?? record;
      writeChatGptSignin(path, {
        ...latest,
        account: { clientId, subject, ...(email ? { email } : {}), tokens },
        welcomed: true,
      });
    });
    loopback.finish(true, 'Book is signed in with ChatGPT. You can close this tab.');
    return {
      clientId,
      subject,
      ...(email ? { email } : {}),
      expiresAt: tokens.expiresAt,
      firstSignIn,
      newRegistration: requestedClientId === CHATGPT_DYNAMIC_CLIENT_ID,
    };
  } catch (error) {
    loopback.finish(
      false,
      `Book could not sign in: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  } finally {
    await loopback.close();
  }
}

function needsRefresh(tokens: ChatGptTokens, now: number): boolean {
  if (tokens.expiresAt - now > REFRESH_MARGIN_MS) return false;
  // OpenAI may say when a refresh is first allowed; an access token still valid waits for it.
  if (tokens.earliestRefreshAt !== undefined && now < tokens.earliestRefreshAt) {
    return now >= tokens.expiresAt;
  }
  return true;
}

/**
 * Renew the tokens under the record's lock. `staleAccessToken` is the token a request was just
 * refused with (a 401): the tokens are renewed unless another process already replaced it.
 */
export async function refreshChatGptTokens(
  options: ChatGptRequestOptions & { staleAccessToken?: string } = {},
): Promise<ChatGptTokens> {
  const endpoints = chatGptEndpoints(options.env);
  const path = options.path ?? chatGptSigninPath();
  const now = options.now ?? Date.now;
  return withChatGptSigninLock(path, async () => {
    const record = readChatGptSignin(path);
    const account = record?.account;
    const tokens = account?.tokens;
    if (!record || !account || !tokens) throw new ChatGptSignInRequiredError('Not signed in.');
    const refused =
      options.staleAccessToken !== undefined && tokens.accessToken === options.staleAccessToken;
    if (!refused && !needsRefresh(tokens, now())) return tokens;
    if (!tokens.refreshToken) {
      throw new ChatGptSignInRequiredError('The ChatGPT sign-in has expired.');
    }
    const answer = await postForm(
      endpoints.token,
      {
        grant_type: 'refresh_token',
        client_id: account.clientId,
        refresh_token: tokens.refreshToken,
        resource: endpoints.apiBase,
      },
      options,
    );
    if (answer.status !== 200) {
      const code = typeof answer.body.error === 'string' ? answer.body.error : '';
      if (TERMINAL_REFRESH_ERRORS.has(code)) {
        // The refresh token is spent: clear it, keep the registration for the next sign-in.
        writeChatGptSignin(path, { ...record, account: { ...account, tokens: undefined } });
        throw new ChatGptSignInRequiredError(
          `The ChatGPT sign-in has expired or was revoked (${code}).`,
        );
      }
      // Anything else may be temporary: the tokens stay, and the next request tries again.
      throw new Error(
        `Could not refresh the ChatGPT sign-in (HTTP ${answer.status}${code ? `, ${code}` : ''}).`,
      );
    }
    const renewed = tokensFromResponse(answer.body, now(), tokens);
    if (typeof answer.body.id_token === 'string') {
      await verifiedIdTokenClaims(
        renewed.idToken,
        { audience: account.clientId, subject: account.subject },
        endpoints,
        options,
      );
    }
    writeChatGptSignin(path, { ...record, account: { ...account, tokens: renewed } });
    return renewed;
  });
}

/**
 * The access token for one request. Reads the record without the network unless the token is
 * near expiry or was just refused; never opens a browser.
 */
export async function chatGptAccessToken(
  options: ChatGptRequestOptions & { staleAccessToken?: string } = {},
): Promise<string> {
  const path = options.path ?? chatGptSigninPath();
  const tokens = readChatGptSignin(path)?.account?.tokens;
  if (!tokens) throw new ChatGptSignInRequiredError('Not signed in to ChatGPT.');
  if (!tokens.scopes.includes(CHATGPT_PLAN_SCOPE)) {
    throw new ChatGptSignInRequiredError('This sign-in does not allow ChatGPT plan usage.');
  }
  const now = (options.now ?? Date.now)();
  if (options.staleAccessToken === undefined && !needsRefresh(tokens, now)) {
    return tokens.accessToken;
  }
  return (await refreshChatGptTokens({ ...options, path })).accessToken;
}

/** Whether the record holds tokens a request could use, without touching the network. */
export function hasChatGptTokens(path: string = chatGptSigninPath()): boolean {
  try {
    return Boolean(readChatGptSignin(path)?.account?.tokens);
  } catch {
    return false;
  }
}

export interface ChatGptSignOutResult {
  /** Whether there were tokens to sign out of. */
  signedIn: boolean;
  /** Whether OpenAI confirmed the refresh token's revocation. */
  revoked: boolean;
}

/**
 * Revoke the refresh token, then clear the tokens. The registration and host id are kept, so the
 * next sign-in reuses the client. A revocation that cannot be confirmed still clears the tokens;
 * the caller tells the user how to disconnect Book in ChatGPT's settings.
 */
export async function signOutOfChatGpt(
  options: ChatGptRequestOptions = {},
): Promise<ChatGptSignOutResult> {
  const endpoints = chatGptEndpoints(options.env);
  const path = options.path ?? chatGptSigninPath();
  const record = readChatGptSignin(path);
  const account = record?.account;
  const tokens = account?.tokens;
  if (!record || !account || !tokens) return { signedIn: false, revoked: false };
  let revoked = false;
  if (tokens.refreshToken) {
    try {
      const { revocationEndpoint } = await discover(endpoints, options);
      for (let attempt = 0; revocationEndpoint && attempt < 3 && !revoked; attempt += 1) {
        if (attempt > 0) await delay(500 * attempt, options.signal);
        try {
          const answer = await postForm(
            revocationEndpoint,
            {
              token: tokens.refreshToken,
              token_type_hint: 'refresh_token',
              client_id: account.clientId,
            },
            options,
          );
          revoked = answer.status === 200;
          // A 4xx will not change on a retry; only a server error or a network failure might.
          if (!revoked && answer.status < 500) break;
        } catch {
          // A network failure: try again while attempts remain.
        }
      }
    } catch {
      // No discovery: the revocation stays unconfirmed.
    }
  }
  await withChatGptSigninLock(path, async () => {
    const latest = readChatGptSignin(path) ?? record;
    if (latest.account) {
      writeChatGptSignin(path, { ...latest, account: { ...latest.account, tokens: undefined } });
    }
  });
  return { signedIn: true, revoked };
}

export interface ChatGptSigninStatus {
  path: string;
  state: 'signed-out' | 'signed-in' | 'unreadable';
  email?: string;
  clientId?: string;
  expiresAt?: number;
  /** Whether the grant includes the plan scope. */
  planUsage?: boolean;
  /** Whether a refresh token is stored. */
  refreshable?: boolean;
  error?: string;
}

/** The sign-in state, read from disk only: for `book auth status` and `book doctor`. */
export function chatGptSigninStatus(path: string = chatGptSigninPath()): ChatGptSigninStatus {
  try {
    const account = readChatGptSignin(path)?.account;
    if (!account?.tokens) return { path, state: 'signed-out', clientId: account?.clientId };
    return {
      path,
      state: 'signed-in',
      ...(account.email ? { email: account.email } : {}),
      clientId: account.clientId,
      expiresAt: account.tokens.expiresAt,
      planUsage: account.tokens.scopes.includes(CHATGPT_PLAN_SCOPE),
      refreshable: Boolean(account.tokens.refreshToken),
    };
  } catch (error) {
    return {
      path,
      state: 'unreadable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
