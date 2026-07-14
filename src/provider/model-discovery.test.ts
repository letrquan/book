import { describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
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
