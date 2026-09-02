import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { createTestClock } from '../clock.js';
import { fetchWithRetry } from './reliability.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * The retry budget bounds how long Book keeps trying a provider that is failing.
 * It is a *duration*, and on a run measured in days the wall clock is not one:
 * NTP steps it, a resumed VM corrects it, an operator fixes a drifted host.
 *
 * `toFake: ['Date']` is load-bearing. Vitest's default `useFakeTimers()` fakes
 * `performance` too, so the monotonic clock would stop alongside the fake wall
 * clock and these tests could not tell the two apart.
 */
describe('retry budget under a wall-clock adjustment', () => {
  function alwaysFailing() {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('still gives up when the wall clock jumps backwards mid-storm', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const wallStart = Date.now();
    const fetchMock = alwaysFailing();
    const clock = createTestClock({ wallMs: wallStart });
    const config = defaultConfig();

    const pending = fetchWithRetry(
      'https://example.test',
      {},
      { ...config.retry, maxAttempts: 50, baseDelayMs: 1, maxDelayMs: 1, totalBudgetMs: 5_000 },
      undefined,
      undefined,
      undefined,
      clock,
    ).catch((error: unknown) => error);

    // An hour of real retrying, while an NTP correction drags the wall clock
    // back an hour. Wall-clock elapsed now reads as *negative*: on `Date.now()`
    // the budget can never be exhausted and the storm runs until maxAttempts.
    await vi.advanceTimersByTimeAsync(0);
    clock.advanceMonotonic(3_600_000);
    vi.setSystemTime(new Date(wallStart - 3_600_000));

    for (let i = 0; i < 60; i++) await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toBeInstanceOf(Error);
    // The budget is 5s and monotonic time advanced an hour, so it gave up long
    // before its 50 attempts.
    expect(fetchMock.mock.calls.length).toBeLessThan(10);
  });

  it('does not expire early when the wall clock jumps forwards', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const wallStart = Date.now();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const clock = createTestClock({ wallMs: wallStart });
    const config = defaultConfig();

    const pending = fetchWithRetry(
      'https://example.test',
      {},
      { ...config.retry, maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, totalBudgetMs: 5_000 },
      undefined,
      undefined,
      undefined,
      clock,
    );

    // A day of wall clock arrives between the failure and the retry. Monotonic
    // time has barely moved, so the budget is untouched and the retry happens.
    vi.setSystemTime(new Date(wallStart + 86_400_000));
    clock.advanceMonotonic(2);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
