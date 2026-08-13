import { describe, expect, it } from 'vitest';
import { extractSelectedText, normalizeSelectionRange } from './text-selection.js';

describe('normalizeSelectionRange', () => {
  it('orders anchor and focus into top and bottom rows', () => {
    expect(normalizeSelectionRange({ x: 1, y: 2 }, { x: 9, y: 7 })).toEqual({
      topRow: 2,
      bottomRow: 7,
    });
    expect(normalizeSelectionRange({ x: 1, y: 7 }, { x: 9, y: 2 })).toEqual({
      topRow: 2,
      bottomRow: 7,
    });
  });

  it('collapses same-row selections and floors at row 1', () => {
    expect(normalizeSelectionRange({ x: 3, y: 4 }, { x: 8, y: 4 })).toEqual({
      topRow: 4,
      bottomRow: 4,
    });
    expect(normalizeSelectionRange({ x: 3, y: 0 }, { x: 8, y: -2 })).toEqual({
      topRow: 1,
      bottomRow: 1,
    });
  });
});

describe('extractSelectedText', () => {
  const frame = [
    'first line',
    '\x1b[32mgreen\x1b[0m and \x1b[1mbold\x1b[0m',
    '日本語テキスト',
    'trailing spaces   ',
    '',
  ];

  it('joins selected rows with newlines and strips ANSI', () => {
    const range = normalizeSelectionRange({ x: 1, y: 1 }, { x: 1, y: 2 });
    expect(extractSelectedText(frame, range)).toBe('first line\ngreen and bold');
  });

  it('keeps wide characters intact', () => {
    const range = normalizeSelectionRange({ x: 1, y: 3 }, { x: 1, y: 3 });
    expect(extractSelectedText(frame, range)).toBe('日本語テキスト');
  });

  it('trims trailing blanks per line and drops trailing blank lines', () => {
    const range = normalizeSelectionRange({ x: 1, y: 4 }, { x: 1, y: 5 });
    expect(extractSelectedText(frame, range)).toBe('trailing spaces');
  });

  it('clamps the range to the frame bounds', () => {
    expect(extractSelectedText(frame, { topRow: 4, bottomRow: 99 })).toBe('trailing spaces');
    expect(extractSelectedText(frame, { topRow: 9, bottomRow: 12 })).toBe('');
  });

  it('returns an empty string for an empty frame', () => {
    expect(extractSelectedText([], { topRow: 1, bottomRow: 2 })).toBe('');
  });
});
