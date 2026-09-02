import { describe, expect, it, vi, afterEach } from 'vitest';
import { createTestClock, systemClock } from './clock.js';

afterEach(() => vi.useRealTimers());

describe('systemClock', () => {
  it('does not follow the wall clock', () => {
    // The property the whole module exists for. `toFake: ['Date']` is required:
    // vitest's default fake timers fake `performance` too, and then the
    // monotonic clock moves with the wall clock and proves nothing.
    vi.useFakeTimers({ toFake: ['Date'] });
    const wall = systemClock.wallNowMs();
    const monotonic = systemClock.monotonicNowMs();

    vi.setSystemTime(new Date(wall - 86_400_000));

    expect(systemClock.wallNowMs()).toBeLessThan(wall);
    // A day of wall-clock correction moves the monotonic clock by the real time
    // these few statements took, which is under a second.
    expect(systemClock.monotonicNowMs() - monotonic).toBeLessThan(1_000);
    expect(systemClock.monotonicNowMs()).toBeGreaterThanOrEqual(monotonic);
  });

  it('reports the wall clock for stamps', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1_700_000_000_000));
    expect(systemClock.wallNowMs()).toBe(1_700_000_000_000);
  });
});

describe('createTestClock', () => {
  it('moves each hand only when told', () => {
    const clock = createTestClock({ monotonicMs: 100, wallMs: 5_000 });
    expect(clock.monotonicNowMs()).toBe(100);
    expect(clock.wallNowMs()).toBe(5_000);

    clock.advanceMonotonic(50);
    expect(clock.monotonicNowMs()).toBe(150);
    expect(clock.wallNowMs()).toBe(5_000);

    clock.setWall(1);
    expect(clock.wallNowMs()).toBe(1);
    expect(clock.monotonicNowMs()).toBe(150);
  });

  it('refuses to rewind monotonic time', () => {
    // A test that rewinds this is asserting something the production clock
    // cannot do, so the double should not let it.
    expect(() => createTestClock().advanceMonotonic(-1)).toThrow(/backwards/);
  });
});
