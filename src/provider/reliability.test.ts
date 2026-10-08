import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings.js';
import { defaultConfig } from '../test/fixtures.js';
import { createTerminalOutcome, terminalRecovery } from '../types/terminal.js';
import {
  classifyApiError,
  classifyHttpStatus,
  ERROR_BODY_READ_TIMEOUT_MS,
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

  it('retries a quoted capacity 404 after the cooldown its 503 states (#383)', async () => {
    vi.useFakeTimers();
    const capacityBody =
      '503 [commandcode/stealth/x] [404]: [CommandCode error: No endpoints found for stealth/x.] (reset after 5s)';
    // The accounts wording is the other form the outage takes.
    const accountsBody =
      '503 [commandcode/stealth/x] [404]: [CommandCode error: No accounts found for stealth/x.] (reset after 5s)';
    expect(quotedUpstreamStatus(capacityBody)).toBeUndefined();
    expect(quotedUpstreamStatus(accountsBody)).toBeUndefined();
    expect(classifyApiError(503, capacityBody)).toBe('server_error');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(capacityBody, { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const retryEvents: Array<[number, number, number]> = [];

    const pending = fetchWithRetry(
      'https://example.test',
      {},
      {
        ...defaultConfig().retry,
        maxAttempts: 1,
        // Above the stated cooldown, so the test observes the stated delay uncapped.
        maxDelayMs: 60_000,
        totalBudgetMs: 10_000,
        requestTimeoutMs: 0,
      },
      undefined,
      (attempt, max, delay) => retryEvents.push([attempt, max, delay]),
    );
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(retryEvents).toEqual([[1, 1, 5_000]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads a capacity 404 with an embedded JSON 403 as no quote at all (#383)', () => {
    // The outage body embeds the router's own JSON error, whose 403 code is one
    // of Book's second patterns. The capacity recognition must end the read:
    // returning undefined beats falling through to a pattern that turns a
    // transient outage into a rejected credential.
    const body =
      '503 [commandcode/stealth/x] [404]: [CommandCode error: No endpoints found for stealth/x.] (reset after 5s) {"error":{"code":403}}';
    expect(quotedUpstreamStatus(body)).toBeUndefined();
  });

  it('ends the run on a capacity-shaped 404 that states no cooldown (#383)', () => {
    // "No endpoints found" for a model that does not exist on any route never
    // gets better while waiting, and there is no cooldown to honour anyway: the
    // exemption is for the cooldown-carrying outage only.
    const body =
      '503 [commandcode/unknown-model/x] [404]: [CommandCode error: No endpoints found for unknown-model/x.]';
    expect(quotedUpstreamStatus(body)).toBe(404);
    expect(classifyApiError(503, body)).toBe('not_found');
  });

  it('returns at once on a quoted 400 whose body states a cooldown (#383)', async () => {
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

  it('ends the run on a quoted 404 that names no capacity outage (#383)', async () => {
    const modelMissingBody =
      'API Error: 503 [commandcode/stealth/x] [404]: {"error":{"code":404,"message":"model not found"}} (reset after 5s)';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(modelMissingBody, { status: 503 }));
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
    // "model not found" says the model is gone, not that the key was refused (#387).
    expect(classifyApiError(503, modelMissingBody)).toBe('model_unavailable');
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

  describe('body cooldown (#383)', () => {
    // parseCooldownReset reads the duration a router states in its error body,
    // through fetchWithRetry's first retry delay (no Retry-After present).
    // `backoffMs` is not exported, so the delay the loop observes is the unit.
    async function firstRetryDelay(
      resetAfter: string,
      retry: Partial<{ maxDelayMs: number }>,
    ): Promise<number> {
      vi.useFakeTimers();
      const body = `429 rate limited (reset after ${resetAfter})`;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(body, { status: 429 }))
        .mockResolvedValue(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const retryEvents: Array<[number, number, number]> = [];
      const pending = fetchWithRetry(
        'https://example.test',
        {},
        {
          ...defaultConfig().retry,
          maxAttempts: 1,
          // Well above every stated duration, so the delay is read uncapped.
          maxDelayMs: 10_000_000,
          totalBudgetMs: 0,
          requestTimeoutMs: 0,
          ...retry,
        },
        undefined,
        (attempt, max, delay) => retryEvents.push([attempt, max, delay]),
      );
      // Far past any stated cooldown, so the sleep finishes and attempt two runs.
      await vi.advanceTimersByTimeAsync(10_000_000);
      await pending;
      expect(retryEvents.length).toBeGreaterThan(0);
      return retryEvents[0][2];
    }

    it('reads the duration forms the cooldowns arrive in', async () => {
      expect(await firstRetryDelay('5s', {})).toBe(5_000);
      expect(await firstRetryDelay('42s', {})).toBe(42_000);
      expect(await firstRetryDelay('1m26s', {})).toBe(86_000);
      expect(await firstRetryDelay('1 min 26 s', {})).toBe(86_000);
    });

    it('reads milliseconds as milliseconds, not minutes', async () => {
      expect(await firstRetryDelay('500ms', {})).toBe(500);
      expect(await firstRetryDelay('1s 200ms', {})).toBe(1_200);
      expect(await firstRetryDelay('2m', {})).toBe(120_000);
    });
  });

  describe('retry delay precedence (#383)', () => {
    it('a Retry-After header wins over the cooldown the body states', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        // The header and the body disagree; the header is the one honoured.
        .mockResolvedValueOnce(
          new Response('rate limited (reset after 5s)', {
            status: 429,
            headers: { 'retry-after': '2' },
          }),
        )
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const retryEvents: Array<[number, number, number]> = [];

      const pending = fetchWithRetry(
        'https://example.test',
        {},
        {
          ...defaultConfig().retry,
          maxAttempts: 1,
          maxDelayMs: 60_000,
          totalBudgetMs: 10_000,
          requestTimeoutMs: 0,
        },
        undefined,
        (attempt, max, delay) => retryEvents.push([attempt, max, delay]),
      );
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toMatchObject({ status: 200 });
      expect(retryEvents).toEqual([[1, 1, 2_000]]);
    });

    it('caps the cooldown the body states at retry.maxDelayMs', async () => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('rate limited (reset after 5s)', { status: 429 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const retryEvents: Array<[number, number, number]> = [];

      const pending = fetchWithRetry(
        'https://example.test',
        {},
        {
          ...defaultConfig().retry,
          maxAttempts: 1,
          maxDelayMs: 1_000,
          totalBudgetMs: 10_000,
          requestTimeoutMs: 0,
        },
        undefined,
        (attempt, max, delay) => retryEvents.push([attempt, max, delay]),
      );
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toMatchObject({ status: 200 });
      expect(retryEvents).toEqual([[1, 1, 1_000]]);
    });
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

  it('does not read a fully cached answer as a zero-usage router envelope', () => {
    const text =
      '[Error] the migration failed at step 3, so I rolled it back.\nHere is what I changed:';
    expect(isUpstreamErrorEnvelope(text, { promptTokens: 0, completionTokens: 0 })).toBe(true);
    expect(
      isUpstreamErrorEnvelope(text, {
        promptTokens: 0,
        completionTokens: 0,
        cacheReadInputTokens: 9000,
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

describe('error body reads (#244)', () => {
  it('gives up on a retryable error body that stalls after its headers', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":{"message":"upstream bu'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(stalledBody, { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = defaultConfig();

    const pending = fetchWithRetry(
      'https://example.test',
      {},
      {
        ...config.retry,
        maxAttempts: 1,
        baseDelayMs: 1,
        maxDelayMs: 1,
        totalBudgetMs: 0,
        // No request timeout: without the bound, nothing would end the read.
        requestTimeoutMs: 0,
      },
    );
    await vi.advanceTimersByTimeAsync(ERROR_BODY_READ_TIMEOUT_MS + 10);

    // Checked before awaiting `pending`: a read that waits for the whole body
    // never reaches the second attempt.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancelled).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: 200 });
  });

  it('decides on what a stalled error body sent before the bound', async () => {
    vi.useFakeTimers();
    const partial =
      '{"error":{"message":"[antigravity/gemini-3.8-flash-high] [400]: INVALID_ARGUMENT';
    const stalledBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(partial));
      },
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(stalledBody, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = defaultConfig();

    const pending = fetchWithRetry(
      'https://example.test',
      {},
      {
        ...config.retry,
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
        totalBudgetMs: 0,
        requestTimeoutMs: 0,
      },
    );
    const settled = vi.fn();
    pending.then(settled, settled);
    await vi.advanceTimersByTimeAsync(ERROR_BODY_READ_TIMEOUT_MS + 10);

    expect(settled).toHaveBeenCalledOnce();
    const response = await pending;
    // The partial body quotes an upstream 400, so the retries stop there.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(partial);
  });

  it('reads at most 64 KB of a retryable error body', async () => {
    let pulls = 0;
    const chunk = new TextEncoder().encode('x'.repeat(16_384));
    // 1 MB in 16 KB chunks, produced only as they are pulled.
    const largeBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
        if (pulls === 64) controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(largeBody, { status: 503 })));
    const config = defaultConfig();

    const response = await fetchWithRetry(
      'https://example.test',
      {},
      { ...config.retry, maxAttempts: 0, totalBudgetMs: 0, requestTimeoutMs: 0 },
    );

    expect(await response.text()).toHaveLength(65_536);
    // Four chunks fill the cap; the stream may queue one more ahead of the read.
    expect(pulls).toBeLessThanOrEqual(6);
  });
});

describe('upstream error envelope shapes (the contract, #244)', () => {
  // 9router's Responses-to-Chat translator writes an upstream `error` or
  // `response.failed` event as the whole answer, `[Error] ${message}` (or the
  // error object as JSON when it has no message), and ends the stream there.
  // These rows are the shapes read as "the router answered, the model did not".
  const openAiServerError =
    '[Error] An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID bef67f5c-a3e8-4c5e-9a88-ba86facfddfa in your message.';
  const zero = { promptTokens: 0, completionTokens: 0 };
  const billed = { promptTokens: 1_200, completionTokens: 40 };
  const explained = `${openAiServerError}\n\nThat is what the API returned; it is a transient server error, so retry the request.`;
  const rows: Array<{
    name: string;
    text: string;
    usage?: { promptTokens: number; completionTokens: number };
    envelope: boolean;
  }> = [
    {
      name: 'OpenAI server error, 0/0 usage',
      text: openAiServerError,
      usage: zero,
      envelope: true,
    },
    { name: 'OpenAI server error, no usage block', text: openAiServerError, envelope: true },
    {
      name: 'OpenAI server error, usage billed upstream',
      text: openAiServerError,
      usage: billed,
      envelope: true,
    },
    {
      name: 'OpenAI server error with surrounding whitespace',
      text: `\n  ${openAiServerError}\n`,
      envelope: true,
    },
    {
      name: 'server error that names its request id',
      text: '[Error] The server had an error while processing your request. Please include the request ID 7f3c2a91 in your email.',
      envelope: true,
    },
    {
      name: 'any one-line [Error] with 0/0 usage',
      text: '[Error] upstream connection reset',
      usage: zero,
      envelope: true,
    },
    {
      name: 'JSON-rendered upstream error with 0/0 usage',
      text: '[Error] {"type":"server_error","code":"internal_error"}',
      usage: zero,
      envelope: true,
    },
    {
      name: 'one-line [Error] with billed usage and no router wording',
      text: '[Error] the build failed',
      usage: billed,
      envelope: false,
    },
    {
      name: 'one-line [Error] with no usage block and no router wording',
      text: '[Error] the build failed',
      envelope: false,
    },
    { name: 'answer that quotes the envelope as its first line', text: explained, envelope: false },
    {
      name: 'the same answer with 0/0 usage, which no model wrote',
      text: explained,
      usage: zero,
      envelope: true,
    },
    {
      name: 'answer that opens with an [Error] log line naming a request id',
      text: '[Error] request id 42 not found\n    at lookup (src/api.ts:10)\n\nThe lookup fails because the cache is cold.',
      envelope: false,
    },
    {
      name: 'answer that does not start with [Error]',
      text: 'Here is the explanation for the issue.',
      usage: zero,
      envelope: false,
    },
    {
      name: 'envelope quoted mid-answer',
      text: `The router answered:\n${openAiServerError}`,
      usage: zero,
      envelope: false,
    },
    {
      name: 'one line far longer than any envelope',
      text: `[Error] ${'x'.repeat(3_000)} request id 1`,
      envelope: false,
    },
    {
      name: 'multi-line [Error] with a request id, 0/0 usage',
      text: '[Error] Upstream failed\nrequest id abc',
      usage: zero,
      envelope: true,
    },
    {
      name: 'multi-line [Error] with a request id, no usage block',
      text: '[Error] Upstream failed\nrequest id abc',
      envelope: false,
    },
    {
      name: 'multi-line [Error] with a request id, usage billed',
      text: '[Error] Upstream failed\nrequest id abc',
      usage: billed,
      envelope: false,
    },
    {
      name: 'JSON-rendered upstream error longer than 2,000 characters, 0/0 usage',
      text: `[Error] ${JSON.stringify({ code: 'server_error', message: 'x'.repeat(2_100) })}`,
      usage: zero,
      envelope: true,
    },
  ];

  it.each(rows)('$name', ({ text, usage, envelope }) => {
    expect(isUpstreamErrorEnvelope(text, usage)).toBe(envelope);
  });
});

describe('stream-level recovery of provider errors (#244)', () => {
  // Which non-retryable 4xx a turn may be re-sent after. A 400, 404 or 422 is a
  // verdict on the request; every other 4xx stays re-sendable. 9router's
  // antigravity route turns the third 409 within 60 s into an account switch, and
  // a 423, 425 or 499 is transient by definition.
  const rows: Array<[number, 'none' | 'reissue']> = [
    [400, 'none'],
    [404, 'none'],
    [422, 'none'],
    [409, 'reissue'],
    [423, 'reissue'],
    [425, 'reissue'],
    [499, 'reissue'],
  ];

  it.each(rows)('after a %i the recovery is %s', (status, recovery) => {
    const { code } = classifyHttpStatus(status);
    const outcome = createTerminalOutcome('failed', 'provider_error', {
      partialOutput: false,
      providerCode: code,
    });
    expect(terminalRecovery(outcome)).toBe(recovery);
  });

  it('names a 422 on its own', () => {
    expect(classifyHttpStatus(422)).toEqual({ code: 'unprocessable', retryable: false });
    expect(classifyHttpStatus(409)).toEqual({ code: 'unknown', retryable: false });
  });
});

describe('stated context overflow (#244)', () => {
  // A 400 whose body mentions 413 somewhere other than a status. Reading either as
  // a stated overflow compacted the run and lowered the learned window for good.
  const fieldPathBody = JSON.stringify({
    error: {
      message: 'Request contains an invalid argument.',
      code: 400,
      status: 'INVALID_ARGUMENT',
      details: [{ fieldViolations: [{ field: 'contents[413].parts[0]', description: 'bad' }] }],
    },
  });
  const requestIdBody = JSON.stringify({
    error: {
      message: 'Invalid value',
      type: 'invalid_request_error',
      param: 'messages',
      request_id: 'req-413-x',
    },
  });
  const pathInMessageBody = JSON.stringify({
    error: {
      code: 400,
      message: "Invalid value at 'contents[413].parts[0].text'",
      status: 'INVALID_ARGUMENT',
    },
  });

  it('never reads a number elsewhere in a 400 as a stated overflow', () => {
    for (const body of [fieldPathBody, requestIdBody, pathInMessageBody]) {
      expect(classifyApiError(400, body), body).toBe('bad_request');
      expect(isContextOverflowError(formatApiError(400, body)), body).toBe(false);
    }
  });

  it('reads a stated overflow from a 413, the error code or type, or the message', () => {
    const statedBodies = [
      JSON.stringify({
        error: {
          message: "This model's maximum context length is 128000 tokens.",
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      }),
      '{"error":{"code":"context_length_exceeded"}}',
      JSON.stringify({
        type: 'error',
        error: { type: 'request_too_large', message: 'Request exceeds the maximum size' },
      }),
      JSON.stringify({
        error: {
          message: 'prompt is too long: 250000 tokens > 200000 maximum',
          type: 'invalid_request_error',
        },
      }),
      JSON.stringify({
        object: 'error',
        message: "This model's maximum context length is 4096 tokens.",
        type: 'BadRequestError',
        code: 400,
      }),
      'maximum context length exceeded',
    ];
    for (const body of statedBodies) {
      expect(classifyApiError(400, body), body).toBe('context_overflow');
    }
    expect(
      classifyApiError(
        503,
        'API Error: 503 [antigravity/...] [400]: maximum context length exceeded',
      ),
    ).toBe('context_overflow');
    expect(classifyApiError(413, 'anything')).toBe('context_overflow');
  });

  // Overflow bodies as the providers send them. Each row is part of the contract.
  const geminiOverflow = {
    error: {
      code: 400,
      message:
        'The input token count (1196266) exceeds the maximum number of tokens allowed (1048576).',
      status: 'INVALID_ARGUMENT',
    },
  };
  const providerOverflows: Array<[string, number, string]> = [
    ['Gemini', 400, JSON.stringify(geminiOverflow)],
    ['Gemini through its OpenAI-compatible endpoint', 400, JSON.stringify([geminiOverflow])],
    [
      '9router wrapping Gemini in a 503',
      503,
      JSON.stringify({
        error: {
          message: `[antigravity/gemini-3.8-flash-high] [400]: ${JSON.stringify(geminiOverflow)} (reset after 29s)`,
        },
      }),
    ],
    [
      'llama.cpp',
      400,
      JSON.stringify({
        error: {
          code: 400,
          message: 'the request exceeds the available context size, try increasing it',
          type: 'exceed_context_size_error',
          n_prompt_tokens: 40000,
          n_ctx: 32768,
        },
      }),
    ],
    [
      'OpenRouter forwarding Anthropic in metadata.raw',
      400,
      JSON.stringify({
        error: {
          message: 'Provider returned error',
          code: 400,
          metadata: {
            raw: JSON.stringify({
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: 'prompt is too long: 250000 tokens > 200000 maximum',
              },
            }),
            provider_name: 'Anthropic',
          },
        },
      }),
    ],
  ];

  it.each(providerOverflows)('reads the overflow %s sends', (_name, status, body) => {
    expect(classifyApiError(status, body)).toBe('context_overflow');
  });

  it('reads 413 only where it is named as a status', () => {
    for (const text of [
      'API Error: 413 request entity too large',
      'HTTP 413',
      'Error code: 413 - {}',
      'upstream returned status 413',
    ]) {
      expect(isContextOverflowError(text), text).toBe(true);
    }
    for (const text of ['contents[413].parts[0]', 'req-413-x', 'chunk 413 of 900']) {
      expect(isContextOverflowError(text), text).toBe(false);
    }
    // Kept from before: OpenAI's per-minute cap on a single request that can never
    // fit under it reads as an overflow, and compaction is what lets it through.
    expect(
      isContextOverflowError(
        'API Error: 429 Request too large for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Requested 45000.',
      ),
    ).toBe(true);
  });
});

describe('a model that is gone is not a credentials problem (#387)', () => {
  // The reproduced bodies. 9router wraps the upstream 403 as its own 503 and
  // quotes the real status in the message; OpenAI answers 404 as itself.
  const retiredRouterBody = JSON.stringify({
    error: {
      message:
        '[commandcode/stealth/space-bunny-alpha] [403]: Space Bunny Alpha is no longer available. The free stealth preview has ended. Please select another model by running /model or -m to keep going.\nhttps://commandcode.ai/models (reset after 1m 43s)',
    },
  });
  const unknownModelBody = JSON.stringify({
    error: {
      message: 'The model `gpt-9` does not exist or you do not have access to it.',
      type: 'invalid_request_error',
      code: 'model_not_found',
    },
  });

  it('classifies a router 503 quoting a 403 that retires the model as model_unavailable', () => {
    expect(classifyApiError(503, retiredRouterBody)).toBe('model_unavailable');
  });

  it('classifies a plain 404 model_not_found body as model_unavailable', () => {
    expect(classifyApiError(404, unknownModelBody)).toBe('model_unavailable');
  });

  it('classifies a plain 403 that retires the model as model_unavailable', () => {
    expect(
      classifyApiError(
        403,
        JSON.stringify({
          error: {
            message: 'Space Bunny Alpha is no longer available. Please select another model.',
          },
        }),
      ),
    ).toBe('model_unavailable');
  });

  it('classifies a quoted 403 that says the model is not supported as model_unavailable', () => {
    expect(
      classifyApiError(
        503,
        JSON.stringify({
          error: {
            message:
              "[openai/gpt-5.6-sol] [403]: The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
          },
        }),
      ),
    ).toBe('model_unavailable');
  });

  it('reads the model-gone wording OpenRouter forwards in metadata.raw', () => {
    // OpenRouter answers its provider's 403 with its own retryable status and
    // forwards the upstream body; the quoted 403 is what opens the read, and
    // the forwarded message is where the retirement is stated.
    expect(
      classifyApiError(
        503,
        JSON.stringify({
          error: {
            code: 403,
            message: 'Provider returned error',
            metadata: {
              raw: JSON.stringify({
                error: {
                  message: 'Space Bunny Alpha is no longer available. Please select another model.',
                },
              }),
            },
          },
        }),
      ),
    ).toBe('model_unavailable');
  });

  it('keeps a 401 an auth error even when the body reads like a retirement', () => {
    // A 401 is always about the credential; its body is never read for this.
    expect(
      classifyApiError(
        401,
        JSON.stringify({
          error: { message: 'This model is no longer available. Please select another model.' },
        }),
      ),
    ).toBe('auth');
  });

  it('keeps a plain 403 without retirement wording an auth error', () => {
    expect(
      classifyApiError(403, JSON.stringify({ error: { message: 'Invalid API key provided' } })),
    ).toBe('auth');
    expect(classifyApiError(403, '')).toBe('auth');
  });

  it('keeps a plain 404 Not Found a not_found', () => {
    expect(classifyApiError(404, 'Not Found')).toBe('not_found');
  });

  it('keeps the #383 capacity outage a retryable server_error', () => {
    const capacityBody =
      '503 [commandcode/stealth/x] [404]: [CommandCode error: No endpoints found for stealth/x.] (reset after 5s)';
    expect(classifyApiError(503, capacityBody)).toBe('server_error');
  });

  it('keeps a capacity-shaped 404 without a cooldown a not_found', () => {
    const body =
      '503 [commandcode/unknown-model/x] [404]: [CommandCode error: No endpoints found for unknown-model/x.]';
    expect(classifyApiError(503, body)).toBe('not_found');
  });

  it('does not read a model word far from any retirement wording, or across sentences', () => {
    const farBody = JSON.stringify({
      error: {
        message: `Access denied for this key.${'x'.repeat(200)}see the model list`,
      },
    });
    expect(classifyApiError(403, farBody)).toBe('auth');
    // A model word and a gone-phrase in different sentences say nothing about
    // the model: the phrase has to name the model in its own sentence.
    const acrossSentences = JSON.stringify({
      error: {
        message:
          'Access denied for this key. The model is healthy. This endpoint is not available today.',
      },
    });
    expect(classifyApiError(403, acrossSentences)).toBe('auth');
  });

  it('formats the retirement with model-choice advice and no credential advice', () => {
    const message = formatApiError(503, retiredRouterBody);
    expect(message).toContain('--model');
    expect(message).toContain('/model');
    expect(message).not.toContain('BOOK_API_KEY');
    expect(message).toContain('no longer available');
  });

  it('does not split sentences on dotted model ids or colon prefixes (#399)', () => {
    const quotedDotted = '503 [openai/gpt-4.1] [403]: Model gpt-4.1 is no longer available.';
    expect(classifyApiError(503, quotedDotted)).toBe('model_unavailable');

    const plainDotted = JSON.stringify({
      error: { message: 'The model gemini-2.5-pro is no longer available.' },
    });
    expect(classifyApiError(404, plainDotted)).toBe('model_unavailable');
  });

  it('matches models plural in model words (#399)', () => {
    const googleUnknownModel = JSON.stringify({
      error: {
        message:
          'models/gemini-1.0-pro is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.',
        status: 'NOT_FOUND',
      },
    });
    expect(classifyApiError(404, googleUnknownModel)).toBe('model_unavailable');
  });

  it('never treats credential errors naming a key or token as model_unavailable (#399)', () => {
    const keyNotFound = JSON.stringify({
      error: { message: 'API key not found for this model provider' },
    });
    expect(classifyApiError(403, keyNotFound)).toBe('auth');

    const selectModelProvider = JSON.stringify({
      error: {
        message: 'Access denied. Please select another model provider or check your key.',
      },
    });
    expect(classifyApiError(403, selectModelProvider)).toBe('auth');
  });

  it('classifies Anthropic 404 for a retired or unknown model as model_unavailable (#399)', () => {
    const anthropicNotFound = JSON.stringify({
      type: 'error',
      error: {
        type: 'not_found_error',
        message: 'model: claude-3-opus-20240229',
      },
    });
    expect(classifyApiError(404, anthropicNotFound)).toBe('model_unavailable');
  });

  it('joins detail and advice with a period and includes OpenRouter raw message (#399)', () => {
    const formatted9router = formatApiError(503, retiredRouterBody);
    expect(formatted9router).toContain('(reset after 1m 43s). This model');

    const openRouterRaw = JSON.stringify({
      error: {
        code: 403,
        message: 'Provider returned error',
        metadata: {
          raw: JSON.stringify({
            error: {
              message: 'Space Bunny Alpha is no longer available. Please select another model.',
            },
          }),
        },
      },
    });
    const formattedOpenRouter = formatApiError(503, openRouterRaw);
    expect(formattedOpenRouter).toContain(
      'Space Bunny Alpha is no longer available. Please select another model.',
    );
  });
});

describe('error bodies read one way (#244 review)', () => {
  it('reads an overflow stated in an OpenRouter metadata.raw object', () => {
    // OpenRouter usually forwards the upstream body as a JSON string, but it can
    // also send it as an object; both are the upstream's own words.
    const body = JSON.stringify({
      error: {
        message: 'Provider returned error',
        code: 400,
        metadata: {
          raw: { error: { message: "This model's maximum context length is 128000 tokens." } },
          provider_name: 'Upstream',
        },
      },
    });
    expect(classifyApiError(400, body)).toBe('context_overflow');
  });

  it('shows the message the classifier reads, wherever the body puts it', () => {
    const padding = 'p'.repeat(300);
    expect(
      formatApiError(400, JSON.stringify({ request_id: padding, message: 'top-level problem' })),
    ).toContain('top-level problem');
    expect(
      formatApiError(400, JSON.stringify({ request_id: padding, error: 'plain string problem' })),
    ).toContain('plain string problem');
    expect(
      formatApiError(400, JSON.stringify({ request_id: padding, detail: 'detail problem' })),
    ).toContain('detail problem');
    // A body with no message of its own still shows its first characters.
    expect(
      formatApiError(400, JSON.stringify({ error: { error: { message: 'nested problem' } } })),
    ).toContain('nested problem');
  });
});

describe('error bodies, review round 1 (#244)', () => {
  it('reads only the message of a JSON body cut at the read cap', () => {
    // A 400 that echoes the request can pass 64 KB; the cut body no longer parses,
    // and its echoed text must not be read as the provider stating an overflow.
    const full = JSON.stringify({
      error: {
        message: 'Invalid parameter: tools[3].function.name',
        type: 'invalid_request_error',
      },
      echo: 'the maximum context length of this model '.repeat(3_000),
    });
    const cut = full.slice(0, 65_536);
    expect(classifyApiError(400, cut)).toBe('bad_request');
    expect(formatApiError(400, cut)).toContain('Invalid parameter: tools[3].function.name');
  });

  it('does not retry a 429 that states the request can never fit', async () => {
    const tpm = JSON.stringify({
      error: {
        message:
          'Request too large for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Requested 45000.',
        type: 'tokens',
        code: 'rate_limit_exceeded',
      },
    });
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response(tpm, { status: 429 });
      }),
    );
    try {
      const response = await fetchWithRetry('http://x/v1', {}, defaultConfig().retry);
      expect(response.status).toBe(429);
      expect(calls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('error bodies, review round 2 (#244)', () => {
  const retryPolicy = { ...defaultConfig().retry, maxAttempts: 3 };

  async function callsFor(body: string): Promise<number> {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response(body, { status: 429 });
      }),
    );
    try {
      await fetchWithRetry('http://x/v1', {}, retryPolicy);
    } finally {
      vi.unstubAllGlobals();
    }
    return calls;
  }

  it('retries a transient per-minute limit that only mentions too many tokens', async () => {
    const body = JSON.stringify({
      error: { message: 'Rate limit reached: too many tokens per minute, retry in 20s' },
    });
    expect(await callsFor(body)).toBe(4);
  });

  it('retries a 429 whose oversize statement the loop cannot read', async () => {
    // OpenRouter's own message is generic; the TPM statement sits in metadata.raw,
    // which the formatted error the loop reads does not carry, so it cannot recover it.
    const body = JSON.stringify({
      error: {
        message: 'Provider returned error',
        code: 429,
        metadata: {
          raw: '{"error":{"message":"Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 45000."}}',
        },
      },
    });
    expect(await callsFor(body)).toBe(4);
  });

  it('does not call an oversized TPM request a temporary capacity issue', () => {
    const body = JSON.stringify({
      error: {
        message:
          'Request too large for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Requested 45000.',
        code: 'rate_limit_exceeded',
      },
    });
    const text = formatApiError(429, body);
    expect(text).toContain('Request too large');
    expect(text).not.toContain('temporary');
  });

  it('reads the code of a JSON body cut at the read cap', () => {
    const full = JSON.stringify({
      error: { code: 'context_length_exceeded', message: 'Bad request' },
      echo: 'filler text '.repeat(10_000),
    });
    expect(classifyApiError(400, full.slice(0, 65_536))).toBe('context_overflow');
  });

  it('reads a plain-text router body that starts with a bracket', () => {
    expect(
      classifyApiError(400, '[antigravity/gemini-x] [400]: maximum context length exceeded'),
    ).toBe('context_overflow');
  });
});

describe('error bodies, review round 3 (#244)', () => {
  it('reads a short malformed brace body whole, as before the read cap', () => {
    expect(
      classifyApiError(
        400,
        `{'error': {'message': "This model's maximum context length is 8192 tokens"}}`,
      ),
    ).toBe('context_overflow');
  });

  it('reads a string error in a JSON body cut at the read cap', () => {
    const full = JSON.stringify({
      error: "This model's maximum context length is 128000 tokens.",
      echo: 'x'.repeat(100_000),
    });
    expect(classifyApiError(400, full.slice(0, 65_536))).toBe('context_overflow');
  });

  it('does not retry an oversized TPM refusal a router wrapped in a 503', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response(
          '[openai/gpt-4o] [429]: Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 45000.',
          { status: 503 },
        );
      }),
    );
    try {
      await fetchWithRetry('http://x/v1', {}, { ...defaultConfig().retry, maxAttempts: 3 });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls).toBe(1);
  });
});

describe('spent usage limit (#400)', () => {
  const issueBody = JSON.stringify({
    error: {
      message:
        "[commandcode/z-ai/glm-5.3-flash] [429]: You've reached your weekly usage limit for your plan. Your limit resets at 2026-10-10T03:40:20.972Z. Please wait for the window to reset or upgrade your plan to continue. (reset after 4m)",
    },
  });

  it('classifies the issue body and equivalent plain 429 as quota', () => {
    expect(classifyApiError(503, issueBody)).toBe('quota');
    expect(classifyApiError(429, issueBody)).toBe('quota');
  });

  it('keeps short per-minute rate limits as rate_limited', () => {
    const rpmBody =
      '{"error":{"message":"Rate limit reached for requests per min (RPM): Limit 3, Used 3, Requested 1."}}';
    expect(classifyApiError(429, rpmBody)).toBe('rate_limited');

    const geminiBody =
      '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10. Please retry in 41.6s.","status":"RESOURCE_EXHAUSTED"}}';
    expect(classifyApiError(429, geminiBody)).toBe('rate_limited');

    expect(
      classifyApiError(429, 'You have exceeded the usage limit of 60 requests per minute.'),
    ).toBe('rate_limited');
  });

  it('classifies long-window limits and insufficient_quota as quota', () => {
    expect(
      classifyApiError(
        429,
        '{"error":{"code":"insufficient_quota","message":"Billing limit reached"}}',
      ),
    ).toBe('quota');
    expect(classifyApiError(429, 'Your daily quota is exhausted.')).toBe('quota');
    expect(classifyApiError(429, "You've hit your 5-hour usage limit.")).toBe('quota');
  });

  it('answers the issue body with exactly one request and no retry', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return new Response(issueBody, { status: 503 });
      }),
    );
    try {
      const response = await fetchWithRetry('http://x/v1', {}, defaultConfig().retry);
      expect(response.status).toBe(503);
      expect(calls).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stops retrying when an absolute reset is beyond the retry budget but retries when near', async () => {
    const reset2hIso = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const body2h = `Too many requests. Your limit resets at ${reset2hIso}.`;
    let calls2h = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls2h++;
        return new Response(body2h, { status: 429 });
      }),
    );
    try {
      const response = await fetchWithRetry('http://x/v1', {}, DEFAULT_SETTINGS.retry);
      expect(response.status).toBe(429);
      expect(calls2h).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }

    vi.useFakeTimers();
    try {
      const reset1sIso = new Date(Date.now() + 1000).toISOString();
      const body1s = `Too many requests. Your limit resets at ${reset1sIso}.`;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(body1s, { status: 429 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const pending = fetchWithRetry('http://x/v1', {}, DEFAULT_SETTINGS.retry);
      await vi.advanceTimersByTimeAsync(5_000);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('waits up to maxDelayMs for an absolute reset within budget on retry', async () => {
    vi.useFakeTimers();
    try {
      const reset4mIso = new Date(Date.now() + 4 * 60 * 1000).toISOString();
      const body4m = `Too many requests. Your limit resets at ${reset4mIso}.`;
      let firstRetryDelay: number | undefined;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(body4m, { status: 429 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const pending = fetchWithRetry(
        'http://x/v1',
        {},
        DEFAULT_SETTINGS.retry,
        undefined,
        (attempt, _max, delayMs) => {
          if (attempt === 1) firstRetryDelay = delayMs;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(firstRetryDelay).toBe(DEFAULT_SETTINGS.retry.maxDelayMs);
      await vi.advanceTimersByTimeAsync(DEFAULT_SETTINGS.retry.maxDelayMs);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('requires reached or spent wording for quota classification', () => {
    expect(
      classifyApiError(
        429,
        'Too many concurrent requests, slow down. Your daily quota is 10000 requests and resets every 24 hours.',
      ),
    ).toBe('rate_limited');
  });

  it('treats message with a short window anywhere as a rate limit', () => {
    expect(
      classifyApiError(429, 'Daily quota exceeded: limit 60 requests per minute, retry in 10s'),
    ).toBe('rate_limited');
  });

  it('retries spent-limit 429 under watchdog', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(issueBody, { status: 503 }))
        .mockResolvedValueOnce(new Response(issueBody, { status: 503 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const pending = fetchWithRetry(
        'http://x/v1',
        {},
        { ...DEFAULT_SETTINGS.retry, watchdog: true },
      );
      await vi.advanceTimersByTimeAsync(100_000);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('formats insufficient_quota and 402 with credit advice without reset wording', () => {
    const insufficientQuotaBody = JSON.stringify({
      error: {
        code: 'insufficient_quota',
        message: 'You exceeded your current quota, please check your plan and billing details.',
      },
    });
    expect(classifyApiError(429, insufficientQuotaBody)).toBe('quota');
    const msg429 = formatApiError(429, insufficientQuotaBody);
    expect(msg429).toContain('Check your usage/credits.');
    expect(msg429).not.toContain('Wait for the reset');

    const msg402 = formatApiError(402, 'Monthly usage limit exceeded.');
    expect(msg402).toContain('Check your usage/credits.');
    expect(msg402).not.toContain('Wait for the reset');
  });

  it('ignores absolute reset found only in non-message json fields', async () => {
    const echoBody = JSON.stringify({
      error: { message: 'Too many requests' },
      echo: 'resets at 2099-01-01T00:00:00Z',
    });
    const formatted = formatApiError(429, echoBody);
    expect(formatted).toContain('Try again in a moment');
    expect(formatted).not.toContain('2099-01-01');

    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(echoBody, { status: 429 }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const pending = fetchWithRetry('http://x/v1', {}, DEFAULT_SETTINGS.retry);
      await vi.advanceTimersByTimeAsync(10_000);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('formats error with reset time and remedy without temporary capacity wording', () => {
    const message = formatApiError(503, issueBody);
    expect(message).toContain('2026-10-10T03:40:20.972Z');
    expect(message).toContain('--model');
    expect(message).not.toContain('Try again in a moment');
    expect(message).not.toContain('temporary capacity');

    const quotaNoReset = formatApiError(429, 'Your daily quota is exhausted.');
    expect(quotaNoReset).toContain(
      'The usage limit for this plan is spent. Wait for the reset, or choose another model with --model or /model.',
    );
    expect(quotaNoReset).not.toContain('it resets at');

    const plain402 = formatApiError(402, 'Payment required');
    expect(plain402).toContain('Check your usage/credits.');
  });

  it('keeps temporary capacity wording for plain rate limits', () => {
    const plainMsg = formatApiError(429, 'Rate limit reached for requests per min');
    expect(plainMsg).toContain('Try again in a moment');

    const futureIso = new Date(Date.now() + 600_000).toISOString();
    const rateLimitWithFutureReset = formatApiError(
      429,
      `Too many requests. Limit resets at ${futureIso}.`,
    );
    expect(rateLimitWithFutureReset).toContain(`It resets at ${futureIso}.`);
    expect(rateLimitWithFutureReset).not.toContain('Try again in a moment');
    expect(rateLimitWithFutureReset).not.toContain('temporary capacity');
  });
});
