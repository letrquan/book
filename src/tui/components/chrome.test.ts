import { describe, expect, it } from 'vitest';
import { floatingFrameMetrics } from './chrome.js';

describe('floatingFrameMetrics', () => {
  it('sits composer and menu frames flush against the left edge', () => {
    expect(floatingFrameMetrics(80)).toEqual({ width: 79, marginX: 0 });
    expect(floatingFrameMetrics(36)).toEqual({ width: 35, marginX: 0 });
  });

  it('uses the full width on tiny terminals', () => {
    expect(floatingFrameMetrics(28)).toEqual({ width: 28, marginX: 0 });
    expect(floatingFrameMetrics(12)).toEqual({ width: 20, marginX: 0 });
  });
});
