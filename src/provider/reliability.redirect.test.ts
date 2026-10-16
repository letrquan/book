import { afterEach, describe, expect, it } from 'vitest';
import { createRedirectFixtures } from '../test/redirect-servers.js';
import { defaultConfig } from '../test/fixtures.js';
import {
  classifyProviderError,
  fetchWithRetry,
  ProviderRedirectError,
  sanitizeRedirectTarget,
} from './reliability.js';

const fixtures = createRedirectFixtures();
afterEach(() => fixtures.closeAll());

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
      expect((error as Error).message).toContain(`http://localhost:${fx.portB}/steal`);
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
      location: (port) => `http://user:pw@localhost:${port}/steal?key=q#frag`,
    });

    const error = (await fetchWithRetry(fx.urlA, init, retry).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ProviderRedirectError);
    expect(error.message).toContain(`http://localhost:${fx.portB}/steal`);
    for (const secret of ['user', 'pw', 'key=', 'frag']) {
      expect(error.message).not.toContain(secret);
    }
    expect((error as ProviderRedirectError).target).toBe(`http://localhost:${fx.portB}/steal`);
  });

  it('resolves a relative Location against the request URL', async () => {
    const fx = await fixtures.start({ status: 302, location: () => '/v2/moved' });

    const error = (await fetchWithRetry(fx.urlA, init, retry).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ProviderRedirectError);
    expect(error.message).toContain(`http://127.0.0.1:${fx.portA}/v2/moved`);
    expect(fx.requestsA()).toBe(1);
  });

  it('rejects a redirect with no Location, saying it gave no usable target', async () => {
    const fx = await fixtures.start({ status: 302, location: () => undefined });

    const error = (await fetchWithRetry(fx.urlA, init, retry).catch((e: unknown) => e)) as Error;

    expect(error).toBeInstanceOf(ProviderRedirectError);
    expect((error as ProviderRedirectError).target).toBeUndefined();
    expect(error.message).toMatch(/no usable target/);
    expect(error.message).toContain('302');
    expect(fx.requestsA()).toBe(1);
  });

  it('classifies a redirect as a non-retryable endpoint verdict', () => {
    expect(classifyProviderError(new ProviderRedirectError(307, 'http://h/p'))).toBe('not_found');
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
