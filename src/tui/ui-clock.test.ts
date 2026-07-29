import { afterEach, describe, expect, it, vi } from 'vitest';
import { markTranscriptScrollActivity } from './scroll-activity.js';
import { subscribeUiClock } from './ui-clock.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('shared UI clock', () => {
  it('uses one timer for every subscriber at the same rate', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeUiClock('fast', first);
    const unsubscribeSecond = subscribeUiClock('fast', second);

    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(100);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    expect(vi.getTimerCount()).toBe(1);
    unsubscribeSecond();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pauses fast animation ticks while transcript scrolling is active', () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const unsubscribe = subscribeUiClock('fast', listener);

    markTranscriptScrollActivity(Date.now());
    vi.advanceTimersByTime(100);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
