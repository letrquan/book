import { describe, expect, it } from 'vitest';
import {
  createTranscriptScrollState,
  createWheelMotion,
  getMaxScrollTop,
  getTranscriptHalfPageRows,
  getTranscriptPageRows,
  pagerChordsAvailable,
  reconcileTranscriptScroll,
  scrollTranscriptBy,
  scrollTranscriptToEnd,
  scrollTranscriptToStart,
  wheelEaseStep,
  wheelRows,
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

describe('wheel motion', () => {
  /** Rows each of `count` reports `gapMs` apart moves, all in one direction. */
  function run(gapMs: number, count: number, direction: -1 | 1 = 1): number[] {
    let motion = createWheelMotion();
    const rows: number[] = [];
    for (let index = 0; index < count; index++) {
      const next = wheelRows(motion, direction, 1_000 + index * gapMs);
      motion = next.motion;
      rows.push(next.rows);
    }
    return rows;
  }
  const total = (rows: number[]) => rows.reduce((sum, value) => sum + value, 0);

  it('moves the distance Claude Code moves for the same reports', () => {
    // Measured on Windows by sending Claude Code these reports and tracking the transcript:
    // [gap between reports in ms, reports, rows the transcript moved in all].
    const measured: Array<[number, number, number]> = [
      [200, 2, 6],
      [100, 2, 6],
      [50, 2, 10],
      [25, 2, 11],
      [12, 2, 12],
      [60, 10, 160],
      [16, 10, 96],
      [8, 10, 82],
      [4, 10, 34],
    ];
    for (const [gapMs, count, rows] of measured) {
      const moved = total(run(gapMs, count));
      const label = `${count} reports ${gapMs} ms apart`;
      expect(moved, label).toBeGreaterThanOrEqual(rows * 0.7);
      expect(moved, label).toBeLessThanOrEqual(rows * 1.3);
    }
    expect(run(1_000, 1)).toEqual([3]);
  });

  it('starts a run over after a pause or a change of direction', () => {
    let motion = createWheelMotion();
    ({ motion } = wheelRows(motion, 1, 0));
    const quick = wheelRows(motion, 1, 30);
    expect(quick.rows).toBeGreaterThan(3);

    expect(wheelRows(quick.motion, -1, 60).rows).toBe(-3);
    expect(wheelRows(quick.motion, 1, 200).rows).toBe(3);
  });

  it('eases a move in over frames in whole rows, never past the target', () => {
    expect(wheelEaseStep(3)).toBe(3);
    expect(wheelEaseStep(-3)).toBe(-3);
    expect(wheelEaseStep(0.9)).toBe(0);
    expect(wheelEaseStep(1.5)).toBe(1);

    const steps: number[] = [];
    let left = 20;
    for (let step = wheelEaseStep(left); step !== 0; step = wheelEaseStep(left)) {
      steps.push(step);
      left -= step;
    }
    expect(steps).toEqual([15, 4, 1]);
  });
});

describe('pagerChordsAvailable', () => {
  // The whole rule, in the four cases it has. An editor that holds the chord
  // spends it; one that has nothing to edit hands it back as a scroll request.
  // So the transcript's own branch may act only in the last row.
  it('pages directly only when no editor on screen is taking the keys', () => {
    expect(pagerChordsAvailable({ composerAcceptsInput: false, sheetEditorFocused: false })).toBe(
      true,
    );
    expect(pagerChordsAvailable({ composerAcceptsInput: true, sheetEditorFocused: false })).toBe(
      false,
    );
    expect(pagerChordsAvailable({ composerAcceptsInput: false, sheetEditorFocused: true })).toBe(
      false,
    );
    expect(pagerChordsAvailable({ composerAcceptsInput: true, sheetEditorFocused: true })).toBe(
      false,
    );
  });

  it('is not the composer-free question read the other way round', () => {
    // The regression this exists to prevent: reading the flag as "the composer
    // is free to page" and negating only the composer. With a live composer and
    // no sheet editor that is `true`, and a draft-clearing Ctrl+U then scrolls
    // the transcript as well — issue #296, back again.
    const draft = { composerAcceptsInput: true, sheetEditorFocused: false };
    const inverted = draft.composerAcceptsInput && !draft.sheetEditorFocused;
    expect(inverted).toBe(true);
    expect(pagerChordsAvailable(draft)).toBe(false);
  });
});
