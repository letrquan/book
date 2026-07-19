import { describe, expect, it } from 'vitest';
import { floatingFrameMetrics } from './chrome.js';

describe('floatingFrameMetrics', () => {
  it('insets normal composer and menu frames by one column', () => {
    expect(floatingFrameMetrics(80)).toEqual({ width: 78, marginX: 1 });
    expect(floatingFrameMetrics(36)).toEqual({ width: 34, marginX: 1 });
  });

  it('uses the full width on tiny terminals', () => {
    expect(floatingFrameMetrics(28)).toEqual({ width: 28, marginX: 0 });
    expect(floatingFrameMetrics(12)).toEqual({ width: 20, marginX: 0 });
  });
});
