import { describe, expect, it } from 'vitest';
import {
  extractSelectedText,
  getSelectionRowSegment,
  normalizeSelectionRange,
  sliceDisplayColumns,
} from './text-selection.js';

describe('normalizeSelectionRange', () => {
  it('orders cell endpoints by row and column and floors coordinates at one', () => {
    expect(normalizeSelectionRange({ x: 1, y: 7 }, { x: 9, y: 2 })).toEqual({
      start: { x: 9, y: 2 },
      end: { x: 1, y: 7 },
    });
    expect(normalizeSelectionRange({ x: 3, y: 0 }, { x: 8, y: -2 })).toEqual({
      start: { x: 3, y: 1 },
      end: { x: 8, y: 1 },
    });
  });
});

describe('getSelectionRowSegment', () => {
  it('uses exact endpoints on the edge rows and full interior rows', () => {
    const range = normalizeSelectionRange({ x: 7, y: 2 }, { x: 4, y: 4 });
    expect(getSelectionRowSegment(range, 2, 20)).toEqual({
      row: 2,
      startColumn: 7,
      endColumn: 20,
    });
    expect(getSelectionRowSegment(range, 3, 20)).toEqual({
      row: 3,
      startColumn: 1,
      endColumn: 20,
    });
    expect(getSelectionRowSegment(range, 4, 20)).toEqual({
      row: 4,
      startColumn: 1,
      endColumn: 4,
    });
  });
});

describe('sliceDisplayColumns', () => {
  it('selects terminal columns without splitting wide glyphs', () => {
    expect(sliceDisplayColumns('A日本B', 3, 4)).toBe('日本');
    expect(sliceDisplayColumns('\x1b[32mabcdef\x1b[0m', 2, 4)).toBe('bcd');
  });
});

describe('extractSelectedText', () => {
  const frame = [
    'first line',
    '\x1b[32mgreen\x1b[0m and \x1b[1mbold\x1b[0m',
    '\u65e5\u672c\u8a9e\u30c6\u30ad\u30b9\u30c8',
    'trailing spaces   ',
    '',
  ];

  it('copies exact first and last row columns while keeping wide characters intact', () => {
    const range = normalizeSelectionRange({ x: 7, y: 2 }, { x: 4, y: 3 });
    expect(extractSelectedText(frame, range)).toBe('and bold\n\u65e5\u672c');
  });

  it('trims trailing blanks and clamps the range to the frame', () => {
    expect(
      extractSelectedText(frame, normalizeSelectionRange({ x: 1, y: 4 }, { x: 99, y: 99 })),
    ).toBe('trailing spaces');
    expect(
      extractSelectedText(frame, normalizeSelectionRange({ x: 1, y: 9 }, { x: 12, y: 12 })),
    ).toBe('');
  });
});
