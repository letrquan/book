import { afterEach, describe, expect, it, vi } from 'vitest';
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
      name: 'the same answer with 0/0 usage',
      text: explained,
      usage: zero,
      envelope: false,
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
  ];

  it.each(rows)('$name', ({ text, usage, envelope }) => {
    expect(isUpstreamErrorEnvelope(text, usage)).toBe(envelope);
  });
});

describe('stream-level recovery of provider errors (#244)', () => {
  it('never re-issues a 4xx that the fetch layer would not retry', () => {
    // The loop ends auth and quota as credentials_rejected and a 413 as
    // context_overflow; every other non-retryable 4xx reaches terminalRecovery as
    // provider_error carrying the classifier's code.
    for (let status = 400; status < 500; status++) {
      const { code, retryable } = classifyHttpStatus(status);
      if (retryable || code === 'auth' || code === 'quota' || code === 'context_overflow') continue;
      const outcome = createTerminalOutcome('failed', 'provider_error', {
        partialOutput: false,
        providerCode: code,
      });
      expect(terminalRecovery(outcome), `${status} ${code}`).toBe('none');
    }
  });
});
