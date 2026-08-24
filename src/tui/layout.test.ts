import { describe, expect, it } from 'vitest';
import {
  CONTENT_COLUMN,
  GUTTER_WIDTH,
  MAX_MEASURE,
  withLabelColumn,
  frameGrid,
  railContentWidth,
  transcriptGrid,
} from './layout.js';

describe('transcriptGrid', () => {
  it('leaves the final column empty so rows cannot shear', () => {
    for (const width of [40, 80, 100, 120]) {
      const grid = transcriptGrid(width);
      expect(CONTENT_COLUMN + grid.content).toBe(width - 1);
    }
  });

  it('caps the measure so a very wide terminal stays readable', () => {
    // Prose set to the full width of an ultrawide terminal is hard to read, and
    // right-aligned metadata that far from its row is not aligned with it.
    for (const width of [MAX_MEASURE, 160, 200, 400]) {
      const grid = transcriptGrid(width);
      expect(grid.width).toBe(MAX_MEASURE);
      expect(CONTENT_COLUMN + grid.content).toBe(MAX_MEASURE - 1);
    }
  });

  it('caps bordered surfaces to the same measure as the transcript', () => {
    expect(frameGrid(200).width).toBe(MAX_MEASURE - 1);
    expect(frameGrid(120).width).toBe(MAX_MEASURE - 1);
    expect(frameGrid(80).width).toBe(79);
  });

  it('collapses the label column on narrow terminals', () => {
    expect(transcriptGrid(120).label).toBe(10);
    expect(transcriptGrid(76).label).toBe(10);
    expect(transcriptGrid(75).label).toBe(0);
    expect(transcriptGrid(40).label).toBe(0);
  });

  it('keeps label, target and meta inside the content budget', () => {
    for (const width of [20, 32, 60, 76, 100, 240]) {
      const grid = transcriptGrid(width);
      // The target column takes a floor, so only over-allocation is a bug.
      expect(grid.label + grid.meta).toBeLessThanOrEqual(grid.content);
    }
  });

  it('never returns a negative or absurd budget at tiny widths', () => {
    const grid = transcriptGrid(1);
    expect(grid.width).toBe(20);
    expect(grid.content).toBeGreaterThanOrEqual(8);
    expect(grid.meta).toBeGreaterThanOrEqual(0);
  });
});

describe('railContentWidth', () => {
  it('subtracts one gutter per nesting level', () => {
    const grid = transcriptGrid(100);
    expect(railContentWidth(grid, 1)).toBe(grid.content - GUTTER_WIDTH);
    expect(railContentWidth(grid, 2)).toBe(grid.content - GUTTER_WIDTH * 2);
  });

  it('stays renderable when nesting exceeds the width', () => {
    expect(railContentWidth(transcriptGrid(20), 40)).toBe(8);
  });
});

describe('frameGrid', () => {
  it('sits flush so border + padding lands text on the content column', () => {
    expect(frameGrid(80)).toEqual({ width: 79, marginX: 0 });
    expect(frameGrid(100)).toEqual({ width: 99, marginX: 0 });
  });

  it('uses the full width when there is no room to inset', () => {
    expect(frameGrid(28)).toEqual({ width: 28, marginX: 0 });
    expect(frameGrid(12)).toEqual({ width: 20, marginX: 0 });
  });
});

describe('withLabelColumn', () => {
  it('narrows the column to what a run of rows needs', () => {
    const grid = transcriptGrid(120);
    const narrowed = withLabelColumn(grid, 4);

    expect(narrowed.label).toBe(4);
    // The columns the label gives up go to the target, not to dead space.
    expect(narrowed.target).toBeGreaterThan(grid.target);
    expect(narrowed.meta).toBe(grid.meta);
  });

  it('never widens past the column cap', () => {
    const grid = transcriptGrid(120);
    expect(withLabelColumn(grid, 99).label).toBe(grid.label);
  });

  it('leaves inline-label terminals alone', () => {
    const narrow = transcriptGrid(60);
    expect(narrow.label).toBe(0);
    expect(withLabelColumn(narrow, 4)).toEqual(narrow);
  });

  it('stays renderable at a nonsense width', () => {
    const grid = transcriptGrid(120);
    expect(withLabelColumn(grid, 0).label).toBe(1);
    expect(withLabelColumn(grid, -5).label).toBe(1);
  });
});
