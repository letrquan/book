import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import {
  classifyApiError,
  classifyHttpStatus,
  fetchWithRetry,
  formatApiError,
  isContextOverflowError,
  isUpstreamErrorEnvelope,
  quotedUpstreamStatus,
} from './reliability.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('provider reliability transport', () => {
  it('shares Retry-After handling across adapters', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const retryEvents: Array<[number, number, number]> = [];
    const config = defaultConfig();

    const pending = fetchWithRetry(
      'https://example.test',
      {},
      { ...config.retry, maxAttempts: 1, maxDelayMs: 5_000, totalBudgetMs: 10_000 },
      undefined,
      (attempt, max, delay) => retryEvents.push([attempt, max, delay]),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(retryEvents).toEqual([[1, 1, 1_000]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds untrusted provider error details', () => {
    const message = formatApiError(400, 'x'.repeat(500));

    expect(message).toContain('x'.repeat(200));
    expect(message).not.toContain('x'.repeat(201));
  });

  it('classifies HTTP 413 and common provider messages as context overflow', () => {
    expect(classifyHttpStatus(413)).toEqual({ code: 'context_overflow', retryable: false });
    expect(isContextOverflowError('API Error: 413 request entity too large')).toBe(true);
    expect(isContextOverflowError('API Error: 400 context_length_exceeded')).toBe(true);
    expect(isContextOverflowError('Your input exceeds the context window of this model.')).toBe(
      true,
    );
    expect(isContextOverflowError('request entity too large')).toBe(true);
    expect(isContextOverflowError('payload too large')).toBe(true);
    expect(isContextOverflowError('request too large')).toBe(true);
    expect(isContextOverflowError('API Error: 400 invalid tool arguments')).toBe(false);
    expect(isContextOverflowError('request id 14130 failed')).toBe(false);
    expect(formatApiError(413, 'request too large')).toContain('Reduce the conversation');
    expect(formatApiError(400, '{"error":{"code":"context_length_exceeded"}}')).toContain(
      'Reduce the conversation',
    );
  });

  it('extracts quoted upstream HTTP status codes from error bodies', () => {
    const nineRouterBody =
      'API Error: 503 [antigravity/...] [400]: {"error":{"code":400,"status":"INVALID_ARGUMENT",...}} (reset after 29s)';
    expect(quotedUpstreamStatus(nineRouterBody)).toBe(400);
    expect(quotedUpstreamStatus('{"error":{"code":429,"message":"rate"}}')).toBe(429);
    expect(quotedUpstreamStatus('{"error":{"code":500}}')).toBeUndefined();
    expect(quotedUpstreamStatus('')).toBeUndefined();
  });

  it('classifies retryable errors using quoted upstream status', () => {
    const nineRouterBody =
      'API Error: 503 [antigravity/...] [400]: {"error":{"code":400,"status":"INVALID_ARGUMENT",...}} (reset after 29s)';
    expect(classifyApiError(503, nineRouterBody)).toBe('bad_request');
    expect(
      classifyApiError(
        503,
        'API Error: 503 [antigravity/...] [400]: maximum context length exceeded',
      ),
    ).toBe('context_overflow');
    expect(classifyApiError(503, 'API Error: 503 [antigravity/...] [429]: rate limited')).toBe(
      'rate_limited',
    );
  });

  it('avoids retrying when upstream error quotes a non-retryable 4xx code', async () => {
    const nineRouterBody =
      'API Error: 503 [antigravity/...] [400]: {"error":{"code":400,"status":"INVALID_ARGUMENT",...}} (reset after 29s)';
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(nineRouterBody, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = defaultConfig();

    const response = await fetchWithRetry(
      'https://example.test',
      {},
      {
        ...config.retry,
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(nineRouterBody);
  });

  it('retries when upstream error quotes a retryable 429 code', async () => {
    const rateLimitedBody = 'API Error: 503 [antigravity/...] [429]: rate limited';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(rateLimitedBody, { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = defaultConfig();

    const response = await fetchWithRetry(
      'https://example.test',
      {},
      {
        ...config.retry,
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('retries plain 503 and preserves response body after retry exhaustion', async () => {
    const busyBody = '{"error":{"message":"busy"}}';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(busyBody, { status: 503 }))
      .mockResolvedValueOnce(new Response(busyBody, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = defaultConfig();

    const response = await fetchWithRetry(
      'https://example.test',
      {},
      {
        ...config.retry,
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 2,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(busyBody);
  });

  it('detects upstream error envelopes rendered as assistant content', () => {
    const errorEnvelope =
      '[Error] An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID bef67f5c-a3e8-4c5e-9a88-ba86facfddfa in your message.';
    expect(isUpstreamErrorEnvelope(errorEnvelope, { promptTokens: 0, completionTokens: 0 })).toBe(
      true,
    );
    expect(isUpstreamErrorEnvelope(errorEnvelope, undefined)).toBe(true);
    expect(
      isUpstreamErrorEnvelope('[Error] the build failed', {
        promptTokens: 10,
        completionTokens: 5,
      }),
    ).toBe(false);
    expect(
      isUpstreamErrorEnvelope('Here is the explanation for the issue.', {
        promptTokens: 0,
        completionTokens: 0,
      }),
    ).toBe(false);
  });

  it('reads a quoted status only from the router prefix or a JSON code field', () => {
    // 9router's own JSON error: its message carries `[<route>] [400]:` and the
    // upstream body with its quotes escaped (#194, #221).
    const escapedNineRouterBody = JSON.stringify({
      error: {
        message:
          '[antigravity/gemini-3.8-flash-high] [400]: {\n  "error": {\n    "code": 400,\n    "status": "INVALID_ARGUMENT"\n  }\n} (reset after 29s)',
      },
    });
    expect(quotedUpstreamStatus(escapedNineRouterBody)).toBe(400);
    expect(classifyApiError(503, escapedNineRouterBody)).toBe('bad_request');

    // A number that only starts like a 4xx, or a 4xx mentioned in prose, is not a quote.
    const outageBodies = [
      '{"error":{"code":4001,"message":"upstream busy"}}',
      '{"error":{"code":"40003","message":"upstream busy"}}',
      '{"error":{"message":"service unavailable: upstream sent HTTP 403 while refreshing"}}',
      '{"error":{"message":"upstream sent HTTP 403 Forbidden"}}',
      'stream reset after chunk [404] of the upstream response',
    ];
    for (const body of outageBodies) {
      expect(quotedUpstreamStatus(body)).toBeUndefined();
      expect(classifyApiError(503, body)).toBe('server_error');
    }
  });

  it('keeps retrying a 503 whose body only mentions a 4xx-looking number', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":{"code":4001,"message":"upstream busy"}}', { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"upstream sent HTTP 403 while refreshing"}}', {
          status: 503,
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = defaultConfig();

    const response = await fetchWithRetry(
      'https://example.test',
      {},
      {
        ...config.retry,
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 2,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(response.status).toBe(200);
  });
});
