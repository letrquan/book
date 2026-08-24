import { describe, expect, it } from 'vitest';
import { densityMetrics, resolveTuiDensity } from './density.js';

describe('TUI density', () => {
  it('uses compact rhythm for normal terminals', () => {
    expect(resolveTuiDensity(18)).toBe('compact');
    expect(resolveTuiDensity(24)).toBe('compact');
  });

  it('uses tight rhythm for short terminals', () => {
    expect(resolveTuiDensity(17)).toBe('tight');
    expect(resolveTuiDensity(12)).toBe('tight');
  });

  it('preserves semantic paragraph separation in both profiles', () => {
    expect(densityMetrics('compact').paragraphGap).toBe(1);
    expect(densityMetrics('tight').paragraphGap).toBe(1);
  });

  it('runs consecutive action rows together so they read as one column', () => {
    // A blank row between every tool row broke the column the aligned grid
    // exists to create; the breathing room belongs before the block, not
    // inside it.
    expect(densityMetrics('compact').toolRowGap).toBe(0);
    expect(densityMetrics('tight').toolRowGap).toBe(0);
  });

  it('separates the action block from the prose above it, except when tight', () => {
    expect(densityMetrics('compact').toolBlockGap).toBe(1);
    expect(densityMetrics('tight').toolBlockGap).toBe(0);
  });
});
