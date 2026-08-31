/**
 * The transports' authentication headers, asserted at the wire.
 *
 * Two things have to stay true: an API-key run must send byte-identical headers
 * to what it sent before subscription auth existed, and an OAuth run must send
 * the bearer token *instead of* the key, never alongside it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeCredential } from '../auth/store.js';
import { resetRefreshState } from '../auth/resolve.js';
import { defaultConfig } from '../test/fixtures.js';
import { chatCompletionStream as anthropicStream } from './anthropic.js';
import { chatCompletionStream as openaiStream } from './openai-compatible.js';

let home: string;
const previousEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'book-provider-auth-'));
  // Snapshot rather than delete: a developer with BOOK_HOME exported would
  // otherwise have every later test in this worker read their real ~/.book.
  for (const key of ['BOOK_HOME', 'BOOK_AUTH_CLIENT_ID_ANTHROPIC']) {
    previousEnv[key] = process.env[key];
  }
  process.env.BOOK_HOME = home;
  process.env.BOOK_AUTH_CLIENT_ID_ANTHROPIC = 'client-123';
  resetRefreshState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

/** Capture the headers of the first request, answering with a terminal error. */
function captureHeaders(): { calls: Array<Record<string, string>> } {
  const calls: Array<Record<string, string>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ ...((init?.headers ?? {}) as Record<string, string>) });
      return new Response('{}', { status: 400 });
    }),
  );
  return { calls };
}

async function drain(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('API-key requests are unchanged', () => {
  it('anthropic sends x-api-key and no Authorization header', async () => {
    const { calls } = captureHeaders();
    await drain(
      anthropicStream(
        defaultConfig({
          apiKey: 'sk-key',
          baseUrl: 'https://api.anthropic.com',
          provider: 'anthropic',
        }),
        [],
        [],
      ),
    );
    expect(calls[0]).toMatchObject({ 'x-api-key': 'sk-key', 'anthropic-version': '2023-06-01' });
    expect(calls[0]).not.toHaveProperty('Authorization');
  });

  it('openai-compatible sends the bearer key', async () => {
    const { calls } = captureHeaders();
    await drain(openaiStream(defaultConfig({ apiKey: 'sk-key', provider: 'openai' }), [], []));
    expect(calls[0].Authorization).toBe('Bearer sk-key');
  });
});

describe('the credential is bound to its own origin', () => {
  /**
   * `BOOK_BASE_URL`, a repository-shipped legacy `.bookrc.json`, or a provider
   * entry can all retarget a request after the profile was selected. The
   * transport must refuse rather than post an account-wide bearer token to
   * whatever host ended up in the config.
   */
  it('refuses to send a subscription token to a retargeted host', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'oauth-at', expiresAt: Date.now() + 3_600_000 } },
      { home },
    );
    const { calls } = captureHeaders();

    const events = (await drain(
      anthropicStream(
        defaultConfig({
          apiKey: '',
          baseUrl: 'https://collector.evil.example/v1',
          provider: 'anthropic',
          authProfile: 'anthropic',
        }),
        [],
        [],
      ),
    )) as Array<{ type: string; error?: string; errorCode?: string }>;

    expect(events[0]).toMatchObject({ type: 'error', errorCode: 'auth' });
    expect(events[0].error).toMatch(/Refusing to send/);
    // Nothing left the machine.
    expect(calls).toEqual([]);
  });
});

describe('subscription requests', () => {
  it('replaces x-api-key with the bearer token and the profile headers', async () => {
    writeCredential(
      'anthropic',
      { kind: 'oauth', tokens: { accessToken: 'oauth-at', expiresAt: Date.now() + 3_600_000 } },
      { home },
    );
    const { calls } = captureHeaders();
    await drain(
      anthropicStream(
        defaultConfig({
          apiKey: 'sk-leftover-key',
          baseUrl: 'https://api.anthropic.com',
          provider: 'anthropic',
          authProfile: 'anthropic',
        }),
        [],
        [],
      ),
    );
    expect(calls[0]).toMatchObject({
      Authorization: 'Bearer oauth-at',
      'anthropic-beta': 'oauth-2025-04-20',
      'anthropic-version': '2023-06-01',
    });
    // Anthropic rejects a request carrying both credentials.
    expect(calls[0]).not.toHaveProperty('x-api-key');
  });

  it('sends the bearer token on the openai-compatible transport', async () => {
    writeCredential(
      'codex',
      { kind: 'oauth', tokens: { accessToken: 'codex-at', expiresAt: Date.now() + 3_600_000 } },
      { home },
    );
    const { calls } = captureHeaders();
    await drain(
      openaiStream(
        defaultConfig({
          apiKey: 'sk-leftover-key',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          provider: 'openai',
          authProfile: 'codex',
        }),
        [],
        [],
      ),
    );
    expect(calls[0].Authorization).toBe('Bearer codex-at');
  });

  /**
   * A credential problem has to reach the user as a stream error naming the fix,
   * not as an unhandled rejection or a bare 401 from the vendor.
   */
  it('yields an auth error event when nothing is logged in, without calling the API', async () => {
    const { calls } = captureHeaders();
    const events = (await drain(
      anthropicStream(
        defaultConfig({
          apiKey: '',
          baseUrl: 'https://api.anthropic.com',
          provider: 'anthropic',
          authProfile: 'anthropic',
        }),
        [],
        [],
      ),
    )) as Array<{ type: string; error?: string; errorCode?: string }>;

    expect(events[0]).toMatchObject({ type: 'error', errorCode: 'auth' });
    expect(events[0].error).toMatch(/book auth login anthropic/);
    // The request is abandoned before it reaches the vendor.
    expect(calls).toEqual([]);
  });

  /**
   * Both transports must behave identically on a credential failure: the
   * `errorCode` is what downstream retry classification keys off, so a
   * divergence would show up as "expired token retries forever on one provider".
   */
  it('yields an auth error event on the openai transport too', async () => {
    const events = (await drain(
      openaiStream(
        defaultConfig({
          apiKey: '',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          provider: 'openai',
          authProfile: 'codex',
        }),
        [],
        [],
      ),
    )) as Array<{ type: string; errorCode?: string }>;
    expect(events[0]).toMatchObject({ type: 'error', errorCode: 'auth' });
  });
});
