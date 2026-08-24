import { describe, expect, it } from 'vitest';
import { SHIMMER_STEPS, shimmerColor, shimmerPhase } from './shimmer.js';

const PAIR: [string, string] = ['#000000', '#ffffff'];

describe('shimmerPhase', () => {
  it('starts and ends a cycle at the same point', () => {
    expect(shimmerPhase(0)).toBe(0);
    expect(shimmerPhase(SHIMMER_STEPS)).toBeCloseTo(0, 10);
  });

  it('reaches the far end at the midpoint', () => {
    expect(shimmerPhase(SHIMMER_STEPS / 2)).toBeCloseTo(1, 10);
  });

  it('stays within bounds for every frame, including negatives', () => {
    for (let tick = -50; tick <= 50; tick++) {
      const phase = shimmerPhase(tick);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThanOrEqual(1);
    }
  });

  it('eases rather than jumping between frames', () => {
    // The old spinner swapped colours every frame: a full-range step each tick.
    let largestStep = 0;
    for (let tick = 0; tick < SHIMMER_STEPS * 2; tick++) {
      largestStep = Math.max(largestStep, Math.abs(shimmerPhase(tick + 1) - shimmerPhase(tick)));
    }
    expect(largestStep).toBeLessThan(0.35);
  });
});

describe('shimmerColor', () => {
  it('blends across the pair over a cycle', () => {
    expect(shimmerColor(PAIR, 0)).toBe('#000000');
    expect(shimmerColor(PAIR, SHIMMER_STEPS / 2)).toBe('#ffffff');
  });

  it('produces intermediate colours rather than only the endpoints', () => {
    const seen = new Set(
      Array.from({ length: SHIMMER_STEPS }, (_, tick) => shimmerColor(PAIR, tick)),
    );
    expect(seen.size).toBeGreaterThan(2);
  });

  it('always returns a renderable hex colour', () => {
    for (let tick = 0; tick < 40; tick++) {
      expect(shimmerColor(['#AFC19D', '#C4D3B5'], tick)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('falls back to the first colour for a non-hex pair', () => {
    // Custom themes may use Ink named or ansi256 colours.
    expect(shimmerColor(['cyan', 'blue'], 3)).toBe('cyan');
    expect(shimmerColor(['ansi256:120', '#C4D3B5'], 3)).toBe('ansi256:120');
  });
});
