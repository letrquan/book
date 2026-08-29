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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'book-provider-auth-'));
  process.env.BOOK_HOME = home;
  process.env.BOOK_AUTH_CLIENT_ID_ANTHROPIC = 'client-123';
  resetRefreshState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BOOK_HOME;
  delete process.env.BOOK_AUTH_CLIENT_ID_ANTHROPIC;
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
        defaultConfig({ apiKey: 'sk-leftover-key', provider: 'openai', authProfile: 'codex' }),
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

  it('yields an auth error event on the openai transport too', async () => {
    const events = (await drain(
      openaiStream(defaultConfig({ apiKey: '', provider: 'openai', authProfile: 'codex' }), [], []),
    )) as Array<{ type: string; errorCode?: string }>;
    expect(events[0]).toMatchObject({ type: 'error', errorCode: 'auth' });
  });
});
