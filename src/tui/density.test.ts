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
});
