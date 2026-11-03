import { describe, expect, it } from 'vitest';
import { RACY_MARGIN_MS, statStamp, statVouches } from './stat-freshness.js';

describe('stat freshness (#647)', () => {
  const facts = { size: 4, mtimeMs: 1_000, ctimeMs: 2_000 };

  it('vouches only for facts that have not moved and were a margin older than the judgment', () => {
    const safe = statStamp(facts, 2_000 + RACY_MARGIN_MS);

    expect(statVouches(safe, facts)).toBe(true);
    // Judged inside the margin of the last change: a write in that tick would look the same.
    expect(statVouches(statStamp(facts, 2_000 + RACY_MARGIN_MS - 1), facts)).toBe(false);
    // A write, a rename into place, an mtime put back (which moves the ctime).
    expect(statVouches(safe, { ...facts, size: 5 })).toBe(false);
    expect(statVouches(safe, { ...facts, mtimeMs: 999 })).toBe(false);
    expect(statVouches(safe, { ...facts, ctimeMs: 2_001 })).toBe(false);
  });

  it('measures the margin from the later of the two times', () => {
    // Stamped ahead of the clock, as an archive from a timezone ahead is: not trusted early.
    const future = { size: 4, mtimeMs: 10_000, ctimeMs: 2_000 };

    expect(statVouches(statStamp(future, 9_000), future)).toBe(false);
    expect(statVouches(statStamp(future, 10_000 + RACY_MARGIN_MS), future)).toBe(true);
  });
});
