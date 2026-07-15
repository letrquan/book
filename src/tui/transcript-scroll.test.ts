import { describe, expect, it } from 'vitest';
import {
  createTranscriptScrollState,
  getMaxScrollTop,
  getTranscriptHalfPageRows,
  getTranscriptPageRows,
  reconcileTranscriptScroll,
  scrollTranscriptBy,
  scrollTranscriptToEnd,
  scrollTranscriptToStart,
} from './transcript-scroll.js';

const metrics = { contentRows: 10, viewportRows: 4 };

describe('transcript scroll model', () => {
  it('starts in follow mode and reconciles to the tail', () => {
    expect(reconcileTranscriptScroll(createTranscriptScrollState(), metrics)).toEqual({
      scrollTop: 6,
      followBottom: true,
    });
  });

  it('scrolls upward into manual mode and clamps at the start', () => {
    const tail = scrollTranscriptToEnd(metrics);
    expect(scrollTranscriptBy(tail, metrics, -3)).toEqual({
      scrollTop: 3,
      followBottom: false,
    });
    expect(scrollTranscriptBy(tail, metrics, -99)).toEqual(scrollTranscriptToStart());
  });

  it('restores follow mode when downward navigation reaches the tail', () => {
    const manual = { scrollTop: 3, followBottom: false };
    expect(scrollTranscriptBy(manual, metrics, 2)).toEqual({
      scrollTop: 5,
      followBottom: false,
    });
    expect(scrollTranscriptBy(manual, metrics, 99)).toEqual({
      scrollTop: 6,
      followBottom: true,
    });
  });

  it('follows content growth only while pinned to the bottom', () => {
    const grown = { contentRows: 14, viewportRows: 4 };
    expect(reconcileTranscriptScroll(scrollTranscriptToEnd(metrics), grown)).toEqual({
      scrollTop: 10,
      followBottom: true,
    });
    expect(reconcileTranscriptScroll({ scrollTop: 3, followBottom: false }, grown)).toEqual({
      scrollTop: 3,
      followBottom: false,
    });
  });

  it('preserves manual mode while clamping content shrink and resize', () => {
    expect(
      reconcileTranscriptScroll(
        { scrollTop: 6, followBottom: false },
        { contentRows: 5, viewportRows: 4 },
      ),
    ).toEqual({ scrollTop: 1, followBottom: false });
    expect(
      reconcileTranscriptScroll(
        { scrollTop: 3, followBottom: false },
        { contentRows: 10, viewportRows: 8 },
      ),
    ).toEqual({ scrollTop: 2, followBottom: false });
  });

  it('handles empty and one-row viewports safely', () => {
    expect(getMaxScrollTop({ contentRows: 0, viewportRows: 0 })).toBe(0);
    expect(getMaxScrollTop({ contentRows: 3, viewportRows: 0 })).toBe(2);
    expect(
      reconcileTranscriptScroll(createTranscriptScrollState(), { contentRows: 0, viewportRows: 0 }),
    ).toEqual({
      scrollTop: 0,
      followBottom: true,
    });
  });

  it('uses overlapping page and half-page steps', () => {
    expect(getTranscriptPageRows(4)).toBe(2);
    expect(getTranscriptPageRows(1)).toBe(1);
    expect(getTranscriptHalfPageRows(5)).toBe(2);
    expect(getTranscriptHalfPageRows(1)).toBe(1);
  });
});
