import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedirectFixtures } from '../test/redirect-servers.js';
import { defaultConfig } from '../test/fixtures.js';
import {
  classifyProviderError,
  fetchWithRetry,
  ProviderRedirectError,
  sanitizeRedirectTarget,
} from './reliability.js';

const fixtures = createRedirectFixtures();
afterEach(async () => {
  vi.unstubAllGlobals();
  await fixtures.closeAll();
});

const retry = {
  ...defaultConfig().retry,
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 2,
  requestTimeoutMs: 5_000,
  totalBudgetMs: 0,
};

const init = {
  method: 'POST',
  headers: { 'x-api-key': 'sk-ant-SECRET' },
  body: '{"prompt":"hi"}',
};

describe('fetchWithRetry refuses redirects (#445)', () => {
  it.each([301, 302, 303, 307, 308])(
    'rejects a %i without retrying or following it',
    async (status) => {
      const fx = await fixtures.start({ status });

      const error = await fetchWithRetry(fx.urlA, init, retry).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ProviderRedirectError);
      expect((error as ProviderRedirectError).status).toBe(status);
      expect((error as Error).message).toContain(String(status));
      expect((error as Error).message).toContain(`http://127.0.0.1:${fx.portB}/steal`);
      expect(fx.requestsB()).toBe(0);
      expect(fx.requestsA()).toBe(1);
    },
  );

  it('settles after one request under retry.watchdog', { timeout: 5_000 }, async () => {
    const fx = await fixtures.start({ status: 307 });

    await expect(
      fetchWithRetry(fx.urlA, init, { ...retry, watchdog: true }),
    ).rejects.toBeInstanceOf(ProviderRedirectError);

    expect(fx.requestsA()).toBe(1);
    expect(fx.requestsB()).toBe(0);
  });

  it('keeps userinfo, query and fragment out of the message', async () => {
    const fx = await fixtures.start({
      location: (port) => `http://user:pw@127.0.0.1:${port}/steal?key=q#frag`,
    });

    const error = (await fetchWithRetry(fx.urlA, init, retry).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ProviderRedirectError);
    expect(error.message).toContain(`http://127.0.0.1:${fx.portB}/steal`);
    for (const secret of ['user', 'pw', 'key=', 'frag']) {
      expect(error.message).not.toContain(secret);
    }
    expect((error as ProviderRedirectError).target).toBe(`http://127.0.0.1:${fx.portB}/steal`);
  });

  it('resolves a relative Location against the request URL', async () => {
    const fx = await fixtures.start({ status: 302, location: () => '/v2/moved' });

    const error = (await fetchWithRetry(fx.urlA, init, retry).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ProviderRedirectError);
    expect(error.message).toContain(`http://127.0.0.1:${fx.portA}/v2/moved`);
    expect(fx.requestsA()).toBe(1);
  });

  it.each([302, 304])(
    'rejects a %i with no Location as having no readable target',
    async (status) => {
      const fx = await fixtures.start({ status, location: () => undefined });

      const error = (await fetchWithRetry(fx.urlA, init, retry).catch((e: unknown) => e)) as Error;

      expect(error).toBeInstanceOf(ProviderRedirectError);
      expect((error as ProviderRedirectError).target).toBeUndefined();
      expect(error.message).toContain(
        `answered HTTP ${status} with no redirect target Book could read`,
      );
      expect(error.message).not.toContain('redirect to');
      expect(fx.requestsA()).toBe(1);
    },
  );

  it('refuses an opaqueredirect response without quoting HTTP 0', async () => {
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, 'type', { value: 'opaqueredirect' });
    Object.defineProperty(opaque, 'status', { value: 0 });
    const fetchMock = vi.fn(async () => opaque);
    vi.stubGlobal('fetch', fetchMock);

    const error = (await fetchWithRetry('http://h.test/v1/messages', init, retry).catch(
      (e: unknown) => e,
    )) as Error;

    expect(error).toBeInstanceOf(ProviderRedirectError);
    expect(error.message).toContain('answered with a redirect');
    expect(error.message).not.toContain('HTTP 0');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns redirect following off whatever the caller passes', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithRetry('http://h.test/', { redirect: 'follow' }, retry);

    expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('advises a base URL without the endpoint path, in two sentences', () => {
    const message = new ProviderRedirectError(307, 'https://gw.example/v1/chat/completions')
      .message;

    expect(message).toContain(
      'answered HTTP 307 with a redirect to https://gw.example/v1/chat/completions',
    );
    expect(message).toContain('without the endpoint path Book adds');
    expect(message).toContain(
      'https://gw.example/v1/chat/completions becomes https://gw.example/v1',
    );
    expect(message.match(/\. /g)).toHaveLength(1);
  });

  it('classifies a redirect as its own non-retryable code', () => {
    expect(classifyProviderError(new ProviderRedirectError(307, 'http://h/p'))).toBe('redirect');
  });
});

describe('the redirect fixture', () => {
  it('lets a plain fetch that follows redirects reach server B, so a leak would be caught', async () => {
    const fx = await fixtures.start({ status: 307 });

    const response = await fetch(fx.urlA, { ...init, redirect: 'follow' });

    expect(response.status).toBe(200);
    expect(fx.requestsA()).toBe(1);
    expect(fx.requestsB()).toBe(1);
  });
});

describe('sanitizeRedirectTarget', () => {
  it('keeps only scheme, host with port, and path', () => {
    expect(sanitizeRedirectTarget('https://u:p@example.test:8443/a/b?x=1#y', 'http://h/')).toBe(
      'https://example.test:8443/a/b',
    );
  });

  it('returns undefined for a missing or unparsable Location', () => {
    expect(sanitizeRedirectTarget(null, 'http://h/')).toBeUndefined();
    expect(sanitizeRedirectTarget('http://', 'http://h/')).toBeUndefined();
    expect(sanitizeRedirectTarget('/x', 'not a url')).toBeUndefined();
  });
});
