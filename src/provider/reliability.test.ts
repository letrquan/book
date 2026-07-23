import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { fetchWithRetry, formatApiError, isContextOverflowError } from './reliability.js';

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

  it('recognizes provider context overflow responses without treating ordinary bad requests as recoverable', () => {
    expect(isContextOverflowError('API Error: 413 request entity too large')).toBe(true);
    expect(isContextOverflowError('API Error: 400 context_length_exceeded')).toBe(true);
    expect(isContextOverflowError('API Error: 400 invalid tool arguments')).toBe(false);
    expect(formatApiError(413, '{"error":{"message":"payload too large"}}')).toContain(
      'context limit',
    );
  });
});
