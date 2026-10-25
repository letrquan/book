import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderStreamEvent } from '../types/providers.js';
import { defaultConfig } from '../test/fixtures.js';
import { CHATGPT_USAGE_LIMIT_MESSAGE, chatGptStream } from './chatgpt.js';

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'book-chatgpt-provider-'));
  previousHome = process.env.BOOK_HOME;
  process.env.BOOK_HOME = home;
  writeFileSync(
    join(home, 'chatgpt-signin.json'),
    JSON.stringify({
      version: 1,
      hostId: 'urn:uuid:test',
      account: {
        clientId: 'oaiapp_1',
        subject: 's',
        tokens: {
          accessToken: 'plan-access-token',
          idToken: 'id',
          expiresAt: Date.now() + 3_600_000,
          scopes: ['chatgpt.tokens.use.direct'],
          savedAt: 0,
        },
      },
    }),
  );
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const config = defaultConfig({
  apiKey: '',
  baseUrl: 'http://127.0.0.1:9/v1',
  providerApi: 'responses',
  providerAuth: 'chatgpt',
});

async function collect(): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of chatGptStream(config, [{ role: 'user', content: 'hi' }], [])) {
    events.push(event);
  }
  return events;
}

describe('chatGptStream', () => {
  it('sends the stored access token for the request, leaving the session config keyless', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(String((init.headers as Record<string, string>).Authorization));
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: {} })}\n\n`,
          { status: 200 },
        );
      }),
    );
    expect((await collect()).at(-1)).toMatchObject({ type: 'done' });
    expect(seen).toEqual(['Bearer plan-access-token']);
    expect(config.apiKey).toBe('');
  });

  it("words a plan limit the way OpenAI asks, with ChatGPT's usage page", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }),
            { status: 429 },
          ),
      ),
    );
    expect(await collect()).toEqual([
      expect.objectContaining({
        type: 'error',
        errorCode: 'usage_limit',
        error: CHATGPT_USAGE_LIMIT_MESSAGE,
      }),
    ]);
    expect(CHATGPT_USAGE_LIMIT_MESSAGE).toContain('https://chatgpt.com/settings/usage');
  });

  it('reports a sign-in with no plan scope without sending anything', async () => {
    writeFileSync(
      join(home, 'chatgpt-signin.json'),
      JSON.stringify({
        version: 1,
        hostId: 'urn:uuid:test',
        account: {
          clientId: 'oaiapp_1',
          subject: 's',
          tokens: {
            accessToken: 'a',
            idToken: 'i',
            expiresAt: Date.now() + 3_600_000,
            scopes: ['openid'],
            savedAt: 0,
          },
        },
      }),
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect(await collect()).toEqual([
      expect.objectContaining({
        type: 'error',
        errorCode: 'auth',
        error: expect.stringMatching(/plan usage/),
      }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
