/**
 * Time that measures, separated from time that labels.
 *
 * `Date.now()` is the settable wall clock. NTP steps it, a VM resumes with it
 * wrong and then corrects, an operator fixes a drifted host, DST changes the
 * offset. None of that matters over a five-minute chat, and all of it is
 * near-certain over the multi-day runs Book is built for — which is why every
 * *duration* decision here reads a monotonic source instead.
 *
 * What the two are for:
 *
 * - **`monotonicNowMs()`** — "how long has this been going?" Retry budgets,
 *   flush deadlines, kill timeouts, elapsed run time. It only ever moves
 *   forward, at a rate nothing can adjust, and its origin is arbitrary, so a
 *   reading is meaningless on its own and comparable only to another reading
 *   *from the same process*.
 * - **`wallNowMs()`** — "when did this happen?" Anything written to a file, put
 *   on screen, or compared against a stamp another process wrote. Still
 *   `Date.now()`; the name exists so the choice is visible at the call site
 *   rather than implied by its absence.
 *
 * **The origin is per-process, and that is the whole limit.** Two processes'
 * monotonic clocks share no zero, so a monotonic reading cannot be persisted,
 * sent, or compared across a process boundary. Cross-process liveness — the
 * background-shell heartbeat, the run-status file `book status` reads, the
 * retention sweeps — therefore stays on the wall clock by necessity, not by
 * oversight. A backwards step there reads as "unexpectedly fresh" and a forward
 * step can declare a live run stale; fixing that needs a sequence counter in the
 * file, not a better clock. See `MILESTONES.md`.
 *
 * Injected rather than imported directly at the decision sites, per the
 * module-level-mutable-state rule: a caller that needs to control time passes a
 * `Clock`, and tests do exactly that instead of reaching for fake timers.
 *
 * One trap worth knowing when writing those tests: vitest's default
 * `vi.useFakeTimers()` fakes `performance` too, so the monotonic clock stops
 * with the fake wall clock and a test cannot tell the two apart. Use
 * `vi.useFakeTimers({ toFake: ['Date'] })` to move the wall clock while the
 * monotonic one keeps its own time — that divergence is the thing under test.
 */

/** A monotonic reading, in milliseconds. Only comparable within one process. */
export type MonotonicMs = number;

export interface Clock {
  /** Milliseconds since an arbitrary fixed origin. Never goes backwards. */
  monotonicNowMs(): MonotonicMs;
  /** Milliseconds since the Unix epoch. Settable; use only for labels. */
  wallNowMs(): number;
}

/**
 * `performance.now()` is monotonic in Node — it reads `uv_hrtime`, which is
 * unaffected by `settimeofday` — and is millisecond-resolution floating point,
 * which is finer than any deadline here needs.
 */
export const systemClock: Clock = {
  monotonicNowMs: () => performance.now(),
  wallNowMs: () => Date.now(),
};

/**
 * A clock a test drives by hand. Both hands start at the given values and move
 * only when told, so a test can advance one without the other — which is the
 * only way to show a duration decision is immune to a wall-clock step.
 */
export function createTestClock(options?: { monotonicMs?: number; wallMs?: number }): Clock & {
  advanceMonotonic(ms: number): void;
  setWall(ms: number): void;
} {
  let monotonic = options?.monotonicMs ?? 0;
  let wall = options?.wallMs ?? 1_700_000_000_000;
  return {
    monotonicNowMs: () => monotonic,
    wallNowMs: () => wall,
    advanceMonotonic(ms: number) {
      // Guard the invariant the production clock has for free: a test that
      // rewinds this is testing something that cannot happen.
      if (ms < 0) throw new Error('monotonic time cannot move backwards');
      monotonic += ms;
    },
    setWall(ms: number) {
      wall = ms;
    },
  };
}
