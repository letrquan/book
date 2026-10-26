import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHATGPT_SIGNIN_FILENAME,
  chatGptSigninPath,
  chatGptTokenSecrets,
  ensureChatGptSignin,
  readChatGptSignin,
  withChatGptSigninLock,
  writeChatGptSignin,
} from './chatgpt-store.js';
import { REMOVED_AUTH_STORE_FILENAME } from '../settings-removed.js';
import { CHATGPT_API_BASE, chatGptEndpoints } from './chatgpt-oauth.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'book-chatgpt-store-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the Sign in with ChatGPT record', () => {
  it('lives under BOOK_HOME, never in the 0.3 auth.json the removal notice reports', () => {
    expect(chatGptSigninPath(home)).toBe(join(home, CHATGPT_SIGNIN_FILENAME));
    expect(CHATGPT_SIGNIN_FILENAME).not.toBe(REMOVED_AUTH_STORE_FILENAME);
  });

  it('gets an opaque urn:uuid host id once, which later reads keep', () => {
    const path = chatGptSigninPath(home);
    const first = ensureChatGptSignin(path);
    expect(first.hostId).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(ensureChatGptSignin(path).hostId).toBe(first.hostId);
  });

  it.skipIf(process.platform === 'win32')('is written with mode 0600', () => {
    const path = chatGptSigninPath(home);
    writeChatGptSignin(path, { version: 1, hostId: 'urn:uuid:x' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('round-trips an account and its tokens, and lists the tokens for redaction', () => {
    const path = chatGptSigninPath(home);
    const tokens = {
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      idToken: 'id-token-value',
      expiresAt: 10,
      scopes: ['openid'],
      savedAt: 1,
    };
    writeChatGptSignin(path, {
      version: 1,
      hostId: 'urn:uuid:x',
      account: { clientId: 'oaiapp_1', subject: 's', tokens },
      welcomed: true,
    });
    expect(readChatGptSignin(path)).toEqual({
      version: 1,
      hostId: 'urn:uuid:x',
      account: { clientId: 'oaiapp_1', subject: 's', tokens },
      welcomed: true,
    });
    expect(chatGptTokenSecrets(path).sort()).toEqual([
      'access-token-value',
      'id-token-value',
      'refresh-token-value',
    ]);
  });

  it('reports a file that is not a record instead of replacing it', () => {
    const path = chatGptSigninPath(home);
    writeFileSync(path, '{broken');
    expect(() => readChatGptSignin(path)).toThrow(/not valid JSON/);
    expect(() => ensureChatGptSignin(path)).toThrow(/not valid JSON/);
    expect(readFileSync(path, 'utf8')).toBe('{broken');
    writeFileSync(path, '{"version":2}');
    expect(() => readChatGptSignin(path)).toThrow(/not a Sign in with ChatGPT record/);
  });

  it('serialises lock holders, and reclaims a lock its holder left behind', async () => {
    const path = chatGptSigninPath(home);
    const order: string[] = [];
    await Promise.all([
      withChatGptSigninLock(path, async () => {
        order.push('a-in');
        await new Promise((resolve) => setTimeout(resolve, 80));
        order.push('a-out');
      }),
      new Promise((resolve) => setTimeout(resolve, 10)).then(() =>
        withChatGptSigninLock(path, async () => {
          order.push('b-in');
        }),
      ),
    ]);
    expect(order).toEqual(['a-in', 'a-out', 'b-in']);
  });

  it('reclaims a lock its holder left behind, even an empty one, by its age', async () => {
    const path = chatGptSigninPath(home);
    const lock = `${path}.lock`;
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    await expect(withChatGptSigninLock(path, async () => 'ran')).resolves.toBe('ran');
    expect(existsSync(lock)).toBe(false);
  });

  it('never removes a lock another holder took over', async () => {
    const path = chatGptSigninPath(home);
    const lock = `${path}.lock`;
    await withChatGptSigninLock(path, async () => {
      // As if this holder's lock had been reclaimed as stale and taken by another process.
      writeFileSync(lock, '4242 someone-else\n');
    });
    expect(readFileSync(lock, 'utf8')).toBe('4242 someone-else\n');
  });
});

describe('chatGptEndpoints', () => {
  it("defaults to OpenAI's issuer and API", () => {
    expect(chatGptEndpoints({})).toEqual({
      issuer: 'https://auth.openai.com',
      authorize: 'https://auth.openai.com/api/accounts/authorize',
      token: 'https://auth.openai.com/api/accounts/oauth/token',
      apiBase: CHATGPT_API_BASE,
    });
  });

  it('honours the test overrides only for a loopback server', () => {
    expect(
      chatGptEndpoints({
        BOOK_CHATGPT_ISSUER: 'http://127.0.0.1:4000/',
        BOOK_CHATGPT_API_BASE: 'http://localhost:4001/v1',
      }),
    ).toMatchObject({ issuer: 'http://127.0.0.1:4000', apiBase: 'http://localhost:4001/v1' });
    expect(() => chatGptEndpoints({ BOOK_CHATGPT_ISSUER: 'https://evil.example' })).toThrow(
      /loopback/,
    );
    expect(() =>
      chatGptEndpoints({ BOOK_CHATGPT_API_BASE: 'http://127.0.0.1.evil.example/v1' }),
    ).toThrow(/loopback/);
    expect(() => chatGptEndpoints({ BOOK_CHATGPT_ISSUER: 'file:///etc' })).toThrow(/loopback/);
  });
});
