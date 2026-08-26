import { describe, expect, it } from 'vitest';
import {
  getSelectionHighlightSpan,
  paintSelection,
  restoreSelection,
} from './selection-highlight.js';
import { normalizeSelectionRange } from './text-selection.js';

describe('getSelectionHighlightSpan', () => {
  it('highlights only the selected cells on a single row', () => {
    const range = normalizeSelectionRange({ x: 3, y: 2 }, { x: 6, y: 2 });
    expect(getSelectionHighlightSpan('alpha beta', range, 2, 20)).toEqual({
      startColumn: 3,
      text: 'pha ',
    });
  });

  it('highlights partial edge rows and the full interior width', () => {
    const range = normalizeSelectionRange({ x: 4, y: 2 }, { x: 2, y: 4 });
    expect(getSelectionHighlightSpan('abcdefgh', range, 2, 8)).toEqual({
      startColumn: 4,
      text: 'defgh',
    });
    expect(getSelectionHighlightSpan('middle', range, 3, 8)).toEqual({
      startColumn: 1,
      text: 'middle  ',
    });
    expect(getSelectionHighlightSpan('ending', range, 4, 8)).toEqual({
      startColumn: 1,
      text: 'en',
    });
  });

  it('keeps wide glyphs intact when an endpoint lands inside one', () => {
    const range = normalizeSelectionRange({ x: 3, y: 1 }, { x: 4, y: 1 });
    expect(getSelectionHighlightSpan('A日本B', range, 1, 10)).toEqual({
      startColumn: 2,
      text: '日本',
    });
  });

  it('restores Ink cursor rows from zero-based to terminal coordinates', () => {
    const writes: string[] = [];
    const range = normalizeSelectionRange({ x: 1, y: 1 }, { x: 2, y: 1 });

    paintSelection((data) => writes.push(data), ['alpha'], range, 20, { x: 4, y: 0 });
    restoreSelection((data) => writes.push(data), ['alpha'], range, { x: 4, y: 0 });

    expect(writes).toHaveLength(2);
    expect(writes.every((output) => output.endsWith('\x1b[1;5H\x1b[?25h'))).toBe(true);
  });
});
