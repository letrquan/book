import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { createRedirectFixtures } from '../test/redirect-servers.js';
import {
  discoverModels,
  ModelDiscoveryError,
  normalizeProviderBaseUrl,
} from './model-discovery.js';

const retry = {
  ...defaultConfig().retry,
  maxAttempts: 0,
  requestTimeoutMs: 100,
};

describe('normalizeProviderBaseUrl', () => {
  it('normalizes trailing slashes without changing provider request bases', () => {
    expect(normalizeProviderBaseUrl('openai', 'https://example.test/v1/')).toBe(
      'https://example.test/v1',
    );
    expect(normalizeProviderBaseUrl('anthropic', 'https://example.test/v1/')).toBe(
      'https://example.test/v1',
    );
  });

  it('rejects non-HTTP protocols and embedded credentials', () => {
    expect(() => normalizeProviderBaseUrl('openai', 'file:///tmp/api')).toThrow(/HTTP or HTTPS/);
    expect(() => normalizeProviderBaseUrl('openai', 'https://user:pass@example.test/v1')).toThrow(
      /embedded credentials/,
    );
  });
});

describe('discoverModels', () => {
  it('discovers, labels, deduplicates, and sorts OpenAI-compatible models', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer secret-key' });
      return new Response(
        JSON.stringify({
          data: [{ id: 'z-model' }, { id: 'a-model', name: 'A Model' }, { id: 'a-model' }],
        }),
        { status: 200 },
      );
    });

    await expect(
      discoverModels({
        type: 'openai',
        baseUrl: 'https://gateway.test/v1/',
        apiKey: 'secret-key',
        retry,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual([{ id: 'a-model', label: 'A Model' }, { id: 'z-model' }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gateway.test/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('discovers all Anthropic pages with safe URL and headers', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ id: 'claude-b', display_name: 'Claude B' }],
            has_more: true,
            last_id: 'claude-b',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: 'claude-a', display_name: 'Claude A' }] }), {
          status: 200,
        }),
      );

    await expect(
      discoverModels({
        type: 'anthropic',
        baseUrl: 'https://proxy.test/v1',
        apiKey: 'anthropic-key',
        retry,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual([
      { id: 'claude-a', label: 'Claude A' },
      { id: 'claude-b', label: 'Claude B' },
    ]);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://proxy.test/v1/models?limit=100');
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({
      'x-api-key': 'anthropic-key',
      'anthropic-version': '2023-06-01',
    });
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://proxy.test/v1/models?limit=100&after_id=claude-b',
    );
  });

  it('records the exact Anthropic input limit as reportedContextWindow, and never the output limit', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'claude-sonnet-5-5',
                display_name: 'Claude Sonnet 5.5',
                max_input_tokens: 1_000_000,
                max_tokens: 128_000,
              },
              { id: 'claude-sonnet-4-5-20250929', max_input_tokens: 200_000, max_tokens: 64_000 },
              { id: 'zero', max_input_tokens: 0, max_tokens: 10 },
              { id: 'negative', max_input_tokens: -5 },
              { id: 'float', max_input_tokens: 1.5 },
              { id: 'string', max_input_tokens: '1000000' },
              { id: 'unsafe', max_input_tokens: 2 ** 60 },
              { id: 'missing' },
            ],
          }),
          { status: 200 },
        ),
    );

    const models = await discoverModels({
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'key',
      retry,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const byId = Object.fromEntries(models.map((model) => [model.id, model]));
    expect(byId['claude-sonnet-5-5'].reportedContextWindow).toBe(1_000_000);
    expect(byId['claude-sonnet-4-5-20250929'].reportedContextWindow).toBe(200_000);
    for (const id of ['zero', 'negative', 'float', 'string', 'unsafe', 'missing']) {
      expect(Object.hasOwn(byId[id], 'reportedContextWindow')).toBe(false);
    }
    // The user's own field and the output limit are never written by discovery.
    for (const model of models) {
      expect(Object.hasOwn(model, 'contextWindow')).toBe(false);
      expect(Object.hasOwn(model, 'maxOutputTokens')).toBe(false);
    }
  });

  it('merges duplicate ids field by field, so a label and a limit from different entries both survive', async () => {
    const page = (data: unknown[]) =>
      vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));
    const run = (data: unknown[]) =>
      discoverModels({
        type: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'key',
        retry,
        fetchImpl: page(data) as typeof fetch,
      });
    await expect(
      run([
        { id: 'claude-x', max_input_tokens: 1_000_000 },
        { id: 'claude-x', display_name: 'X' },
      ]),
    ).resolves.toEqual([{ id: 'claude-x', label: 'X', reportedContextWindow: 1_000_000 }]);
    // First non-empty value wins per field.
    await expect(
      run([
        { id: 'claude-x', display_name: 'First', max_input_tokens: 200_000 },
        { id: 'claude-x', display_name: 'Second', max_input_tokens: 1_000_000 },
      ]),
    ).resolves.toEqual([{ id: 'claude-x', label: 'First', reportedContextWindow: 200_000 }]);
  });

  it('does not record an OpenAI-compatible router context figure', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'router/a', context_length: 128_000 },
              { id: 'router/b', context_window: 64_000, max_input_tokens: 32_000 },
            ],
          }),
          { status: 200 },
        ),
    );
    const models = await discoverModels({
      type: 'openai',
      baseUrl: 'https://gateway.test/v1',
      apiKey: 'key',
      retry,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(models).toHaveLength(2);
    for (const model of models) {
      expect(Object.hasOwn(model, 'reportedContextWindow')).toBe(false);
      expect(Object.hasOwn(model, 'contextWindow')).toBe(false);
    }
  });

  it.each([
    [401, 'auth', 'not authorized'],
    [404, 'unsupported', 'does not expose'],
  ])('returns a safe error for HTTP %i', async (status, code, text) => {
    const fetchImpl = vi.fn(async () => new Response('secret-key echoed by server', { status }));
    const error = await discoverModels({
      type: 'openai',
      baseUrl: 'https://gateway.test/v1',
      apiKey: 'secret-key',
      retry,
      fetchImpl: fetchImpl as typeof fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelDiscoveryError);
    expect((error as ModelDiscoveryError).code).toBe(code);
    expect((error as Error).message).toContain(text);
    expect((error as Error).message).not.toContain('secret-key');
  });

  it('rejects malformed and empty model lists', async () => {
    const malformed = vi.fn(async () => new Response(JSON.stringify({ models: [] })));
    await expect(
      discoverModels({
        type: 'openai',
        baseUrl: 'https://gateway.test/v1',
        apiKey: 'key',
        retry,
        fetchImpl: malformed as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });

    const empty = vi.fn(async () => new Response(JSON.stringify({ data: [] })));
    await expect(
      discoverModels({
        type: 'openai',
        baseUrl: 'https://gateway.test/v1',
        apiKey: 'key',
        retry,
        fetchImpl: empty as typeof fetch,
      }),
    ).rejects.toThrow(/any usable models/);
  });

  it('retries transient responses and supports cancellation', async () => {
    const onRetry = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'model' }] })));
    await expect(
      discoverModels({
        type: 'openai',
        baseUrl: 'https://gateway.test/v1',
        apiKey: 'key',
        retry: { ...retry, maxAttempts: 1, baseDelayMs: 0 },
        onRetry,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual([{ id: 'model' }]);
    expect(onRetry).toHaveBeenCalledOnce();

    const controller = new AbortController();
    controller.abort();
    await expect(
      discoverModels({
        type: 'openai',
        baseUrl: 'https://gateway.test/v1',
        apiKey: 'key',
        retry,
        signal: controller.signal,
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('discoverModels redirects (#445)', () => {
  const fixtures = createRedirectFixtures();
  afterEach(() => fixtures.closeAll());

  it.each(['openai', 'anthropic'] as const)(
    'refuses a redirect for %s without following or retrying it',
    async (type) => {
      const fx = await fixtures.start({ status: 307 });

      const error = await discoverModels({
        type,
        baseUrl: fx.urlA,
        apiKey: 'sk-ant-SECRET',
        retry: { ...retry, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ModelDiscoveryError);
      expect((error as ModelDiscoveryError).code).toBe('request');
      const { message } = error as Error;
      expect(message).toContain(`redirected to http://127.0.0.1:${fx.portB}/steal (HTTP 307)`);
      expect(message).toContain("Check the provider's base URL.");
      expect(message).not.toMatch(/prompt|API key/);
      expect(message.length).toBeLessThanOrEqual(200);
      expect(fx.requestsA()).toBe(1);
      expect(fx.requestsB()).toBe(0);
    },
  );

  it('passes redirect: manual to the injected fetch', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [{ id: 'm' }] })),
    );
    await discoverModels({
      type: 'openai',
      baseUrl: 'https://gateway.test/v1',
      apiKey: 'key',
      retry,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe('manual');
  });
});
