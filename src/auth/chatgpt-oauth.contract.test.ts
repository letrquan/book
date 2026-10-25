/**
 * Contract: Sign in with ChatGPT end to end against a local fixture issuer. It covers dynamic
 * registration, the authorize redirect to the loopback callback, the PKCE code exchange, ID-token
 * validation, a plan-billed Responses request through the `chatgpt` provider, refresh on a 401,
 * and sign-out with revocation. Each refusal case checks that nothing is saved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderStreamEvent } from '../types/providers.js';
import { defaultConfig } from '../test/fixtures.js';
import {
  completeInBrowser,
  createChatGptOAuthFixture,
  type ChatGptOAuthFixture,
  type ChatGptOAuthFixtureOptions,
} from '../test/chatgpt-oauth-fixture.js';
import { createProvider } from '../provider/port.js';
import {
  CHATGPT_API_BASE_ENV,
  CHATGPT_ISSUER_ENV,
  ChatGptSignInRequiredError,
  chatGptAccessToken,
  chatGptSigninStatus,
  refreshChatGptTokens,
  signInWithChatGpt,
  signOutOfChatGpt,
} from './chatgpt-oauth.js';
import { chatGptSigninPath, readChatGptSignin } from './chatgpt-store.js';
import { recordChatGptProvider } from './chatgpt-setup.js';

let home: string;
let fixture: ChatGptOAuthFixture | undefined;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'book-chatgpt-contract-'));
  for (const key of ['BOOK_HOME', CHATGPT_ISSUER_ENV, CHATGPT_API_BASE_ENV]) {
    saved[key] = process.env[key];
  }
  process.env.BOOK_HOME = home;
});

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

async function start(options: ChatGptOAuthFixtureOptions = {}): Promise<ChatGptOAuthFixture> {
  fixture = await createChatGptOAuthFixture(options);
  process.env[CHATGPT_ISSUER_ENV] = fixture.issuer;
  process.env[CHATGPT_API_BASE_ENV] = fixture.apiBase;
  return fixture;
}

/** Sign in, with a stand-in browser that follows the redirect. */
async function login(extra: Parameters<typeof signInWithChatGpt>[0] = {}) {
  const urls: string[] = [];
  const result = await signInWithChatGpt({
    path: chatGptSigninPath(home),
    onAuthorizeUrl: (url) => urls.push(url),
    openBrowser: (url) => completeInBrowser(url),
    timeoutMs: 10_000,
    ...extra,
  });
  return { result, url: new URL(urls[0]) };
}

async function ask(): Promise<ProviderStreamEvent[]> {
  const config = defaultConfig({
    baseUrl: fixture!.apiBase,
    apiKey: '',
    model: 'gpt-fixture',
    provider: 'openai',
    providerApi: 'responses',
    providerAuth: 'chatgpt',
  });
  const provider = createProvider(config);
  expect(provider.id).toBe('chatgpt');
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.stream(config, [{ role: 'user', content: 'hi' }], [])) {
    events.push(event);
  }
  return events;
}

describe('Sign in with ChatGPT (fixture issuer)', () => {
  it('registers, signs in, sends plan requests, refreshes on a 401, and signs out', async () => {
    const server = await start();
    const { result, url } = await login();

    // The authorize request OpenAI documents for a first sign-in.
    expect(url.origin + url.pathname).toBe(`${server.issuer}/api/accounts/authorize`);
    const params = url.searchParams;
    expect(params.get('client_id')).toBe('dynamic_agent_client');
    expect(params.get('agent_name_hint')).toBe('Book');
    expect(params.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('scope')).toBe(
      'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    );
    expect(params.get('resource')).toBe(server.apiBase);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(params.get('state')).toBeTruthy();
    expect(params.get('nonce')).toBeTruthy();
    expect(params.has('id_token_hint')).toBe(false);

    // The code exchange: PKCE, the same redirect URI, the issued client, no secret.
    const exchange = server.log.token[0];
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('client_id')).toBe('oaiapp_fixture');
    expect(exchange.get('redirect_uri')).toBe(params.get('redirect_uri'));
    expect(exchange.get('code_verifier')).toBeTruthy();
    expect(exchange.has('client_secret')).toBe(false);

    expect(result).toMatchObject({
      clientId: 'oaiapp_fixture',
      subject: 'user-fixture-1',
      email: 'user@example.com',
      firstSignIn: true,
      newRegistration: true,
    });
    const path = chatGptSigninPath(home);
    const record = readChatGptSignin(path)!;
    expect(record.hostId).toBe(params.get('ext_agent_host_id'));
    expect(record.account?.tokens?.accessToken).toBe('fixture-access-1');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    // A plan request carries the access token as a bearer token, not an API key.
    expect((await ask()).at(-1)).toMatchObject({ type: 'done', finishReasons: ['stop'] });
    expect(server.log.responses[0].authorization).toBe('Bearer fixture-access-1');
    expect(server.log.responses[0].body).toMatchObject({ store: false, stream: true });

    // A 401 refreshes once (the rotated pair is saved) and retries once.
    server.refuse.add('fixture-access-1');
    const retried = await ask();
    expect(retried.filter((e) => e.type === 'text').map((e) => e.content)).toEqual(['PLAN-OK']);
    expect(server.log.token.at(-1)?.get('grant_type')).toBe('refresh_token');
    expect(server.log.token.at(-1)?.get('refresh_token')).toBe('fixture-refresh-1');
    expect(server.log.token.at(-1)?.get('client_id')).toBe('oaiapp_fixture');
    expect(server.log.responses.at(-1)?.authorization).toBe('Bearer fixture-access-2');
    expect(readChatGptSignin(path)?.account?.tokens?.refreshToken).toBe('fixture-refresh-2');

    // Sign-out revokes the refresh token, clears the tokens, keeps the registration.
    expect(await signOutOfChatGpt({ path })).toEqual({ signedIn: true, revoked: true });
    expect(server.log.revoke[0].get('token')).toBe('fixture-refresh-2');
    expect(server.log.revoke[0].get('token_type_hint')).toBe('refresh_token');
    expect(server.log.revoke[0].get('client_id')).toBe('oaiapp_fixture');
    const after = readChatGptSignin(path)!;
    expect(after.account?.tokens).toBeUndefined();
    expect(after.account?.clientId).toBe('oaiapp_fixture');
    expect(after.hostId).toBe(record.hostId);
    expect(chatGptSigninStatus(path).state).toBe('signed-out');
    const refused = await ask();
    expect(refused).toEqual([
      expect.objectContaining({
        type: 'error',
        errorCode: 'auth',
        error: expect.stringContaining('book auth login'),
      }),
    ]);

    // The next sign-in reuses the issued client: no registration, no name hint.
    const again = await login();
    expect(again.url.searchParams.get('client_id')).toBe('oaiapp_fixture');
    expect(again.url.searchParams.has('agent_name_hint')).toBe(false);
    expect(again.result).toMatchObject({ firstSignIn: false, newRegistration: false });
  });

  it("records the plan's listed models as a user-file chatgpt provider, never touching model", async () => {
    await start();
    await login();
    const settingsPath = join(home, 'settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: 'anthropic/claude-opus-5-5',
        provider: {
          chatgpt: { type: 'chatgpt', models: { 'gpt-fixture': { contextWindow: 1000 } } },
        },
      }),
    );
    const setup = await recordChatGptProvider(home);
    expect(setup).toMatchObject({ providerId: 'chatgpt', path: settingsPath });
    const written = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(written.model).toBe('anthropic/claude-opus-5-5');
    expect(written.provider).toEqual({
      chatgpt: {
        type: 'chatgpt',
        // Only `visibility: "list"` models; the user's own override on one is kept.
        models: { 'gpt-fixture': { contextWindow: 1000, label: 'GPT Fixture' } },
      },
    });

    // An id the user already uses for another provider is left alone.
    writeFileSync(settingsPath, JSON.stringify({ provider: { chatgpt: { type: 'openai' } } }));
    const refused = await recordChatGptProvider(home);
    expect(refused.providerId).toBeUndefined();
    expect(refused.note).toMatch(/another provider/);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      provider: { chatgpt: { type: 'openai' } },
    });
  });

  it('refreshes an access token near its expiry before the request', async () => {
    const server = await start({ expiresIn: 60 });
    await login();
    expect(await chatGptAccessToken({ path: chatGptSigninPath(home) })).toBe('fixture-access-2');
    expect(server.log.token.map((form) => form.get('grant_type'))).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
  });

  it('clears the tokens, but keeps the registration, on a terminal refresh error', async () => {
    await start({ refreshError: 'refresh_token_expired' });
    await login();
    const path = chatGptSigninPath(home);
    await expect(
      refreshChatGptTokens({ path, staleAccessToken: 'fixture-access-1' }),
    ).rejects.toThrow(ChatGptSignInRequiredError);
    expect(readChatGptSignin(path)?.account?.tokens).toBeUndefined();
    expect(readChatGptSignin(path)?.account?.clientId).toBe('oaiapp_fixture');
  });

  it('keeps the tokens when a refresh fails for a reason that may pass', async () => {
    await start({ refreshError: 'temporarily_unavailable' });
    await login();
    const path = chatGptSigninPath(home);
    await expect(
      refreshChatGptTokens({ path, staleAccessToken: 'fixture-access-1' }),
    ).rejects.toThrow(/Could not refresh/);
    expect(readChatGptSignin(path)?.account?.tokens?.accessToken).toBe('fixture-access-1');
  });

  describe('refuses, saving no tokens', () => {
    const cases: Array<[string, ChatGptOAuthFixtureOptions, RegExp]> = [
      [
        'a callback for another attempt (state)',
        { tamperCallback: (p) => p.set('state', 'forged') },
        /state mismatch/,
      ],
      ['a declined consent', { deny: true }, /declined/],
      [
        'a registration with no issued client id',
        { tamperCallback: (p) => p.delete('client_id') },
        /no client id/,
      ],
      ['an ID token with another nonce', { tamperIdToken: (c) => (c.nonce = 'other') }, /nonce/],
      [
        'an ID token for another client',
        { tamperIdToken: (c) => (c.aud = 'oaiapp_other') },
        /different client/,
      ],
      [
        'an ID token from another issuer',
        { tamperIdToken: (c) => (c.iss = 'https://evil.example') },
        /issued by/,
      ],
      ['an expired ID token', { tamperIdToken: (c) => (c.exp = 1) }, /expired/],
      [
        'a grant without the plan scope',
        { scope: 'openid profile email offline_access' },
        /plan usage was not granted/,
      ],
    ];
    for (const [name, options, message] of cases) {
      it(name, async () => {
        await start(options);
        await expect(login()).rejects.toThrow(message);
        expect(readChatGptSignin(chatGptSigninPath(home))?.account).toBeUndefined();
      });
    }

    it('a reauthorization that returns another client id', async () => {
      await start();
      await login();
      await fixture!.close();
      await start({ tamperCallback: (p) => p.set('client_id', 'oaiapp_other') });
      await expect(login()).rejects.toThrow(/different client/);
      expect(readChatGptSignin(chatGptSigninPath(home))?.account?.clientId).toBe('oaiapp_fixture');
    });

    it('a reauthorization as a different ChatGPT account', async () => {
      await start();
      await login();
      const before = readFileSync(chatGptSigninPath(home), 'utf8');
      await fixture!.close();
      await start({ subject: 'someone-else' });
      await expect(login()).rejects.toThrow(/different ChatGPT account/);
      expect(readFileSync(chatGptSigninPath(home), 'utf8')).toBe(before);
    });
  });

  it('never sends a plan request without a sign-in, and opens nothing', async () => {
    const server = await start();
    expect(existsSync(chatGptSigninPath(home))).toBe(false);
    const events = await ask();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'error',
        errorCode: 'auth',
        error: expect.stringContaining('book auth login'),
      }),
    ]);
    expect(server.log.responses).toHaveLength(0);
  });
});
