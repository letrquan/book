import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrameThrottle } from './ink-frame-throttle.js';

describe('createFrameThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function throttleDraws(intervalMs = 14) {
    const draws: number[] = [];
    const throttle = createFrameThrottle(
      () => draws.push(Date.now()),
      intervalMs,
      () => Date.now(),
    );
    return { throttle, draws };
  }

  /** Move the clock to `at`, firing any timer due on the way. */
  const moveTo = (at: number) => vi.advanceTimersByTime(at - Date.now());

  it('draws at once when idle, and once more at the last draw plus the interval', () => {
    const { throttle, draws } = throttleDraws();
    throttle();
    expect(draws).toEqual([0]);

    // Commits inside the window do not push the draw later: it stays at 0 + 14.
    for (const at of [5, 10, 13]) {
      moveTo(at);
      throttle();
    }
    moveTo(40);
    expect(draws).toEqual([0, 14]);
  });

  it('keeps its rate under a steady stream of commits', () => {
    const { throttle, draws } = throttleDraws();
    // A commit every 5 ms for 100 ms: Ink's own throttle drew about every 25–31 ms here.
    for (let at = 0; at <= 100; at += 5) {
      moveTo(at);
      throttle();
    }
    moveTo(130);
    for (let index = 1; index < draws.length; index++) {
      expect(draws[index]! - draws[index - 1]!).toBe(14);
    }
    expect(draws.length).toBeGreaterThanOrEqual(8);
  });

  it('draws a held frame on flush and drops it on cancel', () => {
    const { throttle, draws } = throttleDraws();
    throttle();
    moveTo(3);
    throttle();
    throttle.flush();
    expect(draws).toEqual([0, 3]);

    moveTo(6);
    throttle();
    throttle.cancel();
    moveTo(60);
    expect(draws).toEqual([0, 3]);
  });
});
