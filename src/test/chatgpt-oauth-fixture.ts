/**
 * A local stand-in for OpenAI's Sign in with ChatGPT issuer and the Responses endpoint, for the
 * contract test and the TUI driver run. It implements the documented shape: OpenID discovery, a
 * JWKS, the authorize endpoint (redirecting to the loopback callback with the issued client id),
 * the token endpoint (authorization_code with PKCE, refresh_token with rotation), revocation, and
 * `POST /v1/responses`, which can be told to refuse a token with a 401.
 */

import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ChatGptOAuthFixtureOptions {
  subject?: string;
  email?: string;
  /** The scope granted; defaults to everything Book asks for. */
  scope?: string;
  issuedClientId?: string;
  /** Answer the authorize request with `error=access_denied`. */
  deny?: boolean;
  /** Rewrite the callback's query before redirecting (to send a wrong state or client id). */
  tamperCallback?: (params: URLSearchParams) => void;
  /** Rewrite the ID token's claims before signing. */
  tamperIdToken?: (claims: Record<string, unknown>) => void;
  /** Answer every refresh with this OAuth error code. */
  refreshError?: string;
  /** Access-token lifetime, in seconds. */
  expiresIn?: number;
}

export interface ChatGptOAuthFixture {
  issuer: string;
  apiBase: string;
  /** Requests the fixture saw, for assertions. */
  log: {
    authorize: URLSearchParams[];
    token: URLSearchParams[];
    revoke: URLSearchParams[];
    responses: Array<{ authorization?: string; body: Record<string, unknown> }>;
  };
  /** Access tokens `/v1/responses` refuses with a 401. */
  refuse: Set<string>;
  /** The current access and refresh tokens. */
  current(): { accessToken: string; refreshToken: string };
  close(): Promise<void>;
}

const ALL_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';

function signJwt(claims: Record<string, unknown>, key: KeyObject, kid: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += String(chunk);
  return raw;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

export async function createChatGptOAuthFixture(
  options: ChatGptOAuthFixtureOptions = {},
): Promise<ChatGptOAuthFixture> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'fixture-key';
  const subject = options.subject ?? 'user-fixture-1';
  const clientId = options.issuedClientId ?? 'oaiapp_fixture';
  const scope = options.scope ?? ALL_SCOPES;
  const codes = new Map<
    string,
    { challenge: string; nonce: string; clientId: string; redirectUri: string }
  >();
  const log: ChatGptOAuthFixture['log'] = { authorize: [], token: [], revoke: [], responses: [] };
  const refuse = new Set<string>();
  let generation = 0;
  let accessToken = '';
  let refreshToken = '';
  let issuer = '';

  const issueTokens = (audience: string, nonce?: string): Record<string, unknown> => {
    generation += 1;
    accessToken = `fixture-access-${generation}`;
    refreshToken = `fixture-refresh-${generation}`;
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: issuer,
      aud: audience,
      sub: subject,
      email: options.email ?? 'user@example.com',
      iat: now,
      exp: now + 3600,
      ...(nonce ? { nonce } : {}),
    };
    options.tamperIdToken?.(claims);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: signJwt(claims, privateKey, kid),
      token_type: 'Bearer',
      expires_in: options.expiresIn ?? 3600,
      scope,
    };
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer || 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/api/accounts/authorize`,
          token_endpoint: `${issuer}/api/accounts/oauth/token`,
          jwks_uri: `${issuer}/jwks`,
          revocation_endpoint: `${issuer}/oauth/revoke`,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/jwks') {
        json(res, 200, {
          keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }],
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/accounts/authorize') {
        const params = url.searchParams;
        log.authorize.push(params);
        const redirectUri = params.get('redirect_uri') ?? '';
        const back = new URL(redirectUri);
        const reply = new URLSearchParams();
        reply.set('state', params.get('state') ?? '');
        if (options.deny) {
          reply.set('error', 'access_denied');
        } else {
          const code = `fixture-code-${codes.size + 1}`;
          const requested = params.get('client_id') ?? '';
          const issued = requested === 'dynamic_agent_client' ? clientId : requested;
          codes.set(code, {
            challenge: params.get('code_challenge') ?? '',
            nonce: params.get('nonce') ?? '',
            clientId: issued,
            redirectUri,
          });
          reply.set('code', code);
          if (requested === 'dynamic_agent_client') reply.set('client_id', issued);
          reply.set('scope', scope);
        }
        options.tamperCallback?.(reply);
        back.search = reply.toString();
        res.writeHead(302, { Location: back.toString() }).end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts/oauth/token') {
        const form = new URLSearchParams(await readBody(req));
        log.token.push(form);
        if (form.get('grant_type') === 'authorization_code') {
          const pending = codes.get(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (
            !pending ||
            pending.challenge !== challenge ||
            pending.clientId !== form.get('client_id') ||
            pending.redirectUri !== form.get('redirect_uri')
          ) {
            json(res, 400, { error: 'invalid_grant' });
            return;
          }
          codes.delete(form.get('code') ?? '');
          json(res, 200, issueTokens(pending.clientId, pending.nonce));
          return;
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (options.refreshError) {
            json(res, 400, { error: options.refreshError });
            return;
          }
          if (form.get('refresh_token') !== refreshToken) {
            json(res, 400, { error: 'refresh_token_reused' });
            return;
          }
          json(res, 200, issueTokens(form.get('client_id') ?? ''));
          return;
        }
        json(res, 400, { error: 'unsupported_grant_type' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/oauth/revoke') {
        log.revoke.push(new URLSearchParams(await readBody(req)));
        res.writeHead(200).end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        if (req.headers.authorization !== `Bearer ${accessToken}`) {
          json(res, 401, { error: { code: 'invalid_api_key', message: 'Invalid token.' } });
          return;
        }
        json(res, 200, {
          models: [
            { slug: 'gpt-fixture', display_name: 'GPT Fixture', visibility: 'list' },
            { slug: 'gpt-fixture-hidden', display_name: 'Hidden', visibility: 'hide' },
          ],
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/responses') {
        const authorization = req.headers.authorization;
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        log.responses.push({ authorization, body });
        const token = authorization?.replace(/^Bearer /, '') ?? '';
        if (token !== accessToken || refuse.has(token)) {
          json(res, 401, {
            error: { code: 'subscription_sharing_invalid_user', message: 'Invalid token.' },
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const event of [
          { type: 'response.created', response: { id: 'resp_fixture', model: 'gpt-fixture' } },
          { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'PLAN-OK' },
          {
            type: 'response.completed',
            response: {
              id: 'resp_fixture',
              model: 'gpt-fixture',
              status: 'completed',
              usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
            },
          },
        ]) {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        res.end();
        return;
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    apiBase: `${issuer}/v1`,
    log,
    refuse,
    current: () => ({ accessToken, refreshToken }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** A stand-in browser: follow the authorize redirect to the loopback callback, as a browser would. */
export async function completeInBrowser(url: string): Promise<void> {
  const authorize = await fetch(url, { redirect: 'manual' });
  const location = authorize.headers.get('location');
  if (!location) throw new Error(`authorize answered ${authorize.status} without a redirect`);
  await fetch(location);
}
