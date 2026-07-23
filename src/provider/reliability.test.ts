import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import {
  classifyHttpStatus,
  fetchWithRetry,
  formatApiError,
  isContextOverflowError,
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
});
