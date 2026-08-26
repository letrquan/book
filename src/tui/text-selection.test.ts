import { describe, expect, it } from 'vitest';
import {
  expandToWord,
  extractSelectedText,
  lineDisplayWidth,
  resolveSelectionSpans,
  sliceDisplayRange,
} from './text-selection.js';

const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

describe('sliceDisplayRange', () => {
  it('takes a half-open display-column range', () => {
    expect(sliceDisplayRange('hello world', 1, 6)).toBe('hello');
    expect(sliceDisplayRange('hello world', 7, 12)).toBe('world');
  });

  it('ignores styling when counting columns', () => {
    // The frame carries ANSI; the columns a user sees are the plain ones.
    expect(sliceDisplayRange(`${BOLD}hello${RESET} world`, 1, 6)).toBe('hello');
  });

  it('keeps a wide glyph whole rather than cutting it in half', () => {
    // 日 and 本 occupy two columns each, so column 3 is 本's first cell.
    expect(sliceDisplayRange('日本語', 3, 5)).toBe('本');
  });

  it('keeps zero-width marks with the cell they modify', () => {
    // Combining marks, variation selectors and ZWJ occupy no column of their
    // own. Skipping them would copy text that differs from what was on screen.
    const combining = 'café au lait';
    expect(sliceDisplayRange(combining, 1, 5)).toBe('café');
    const warning = '⚠️ done';
    expect(sliceDisplayRange(warning, 1, 2)).toBe('⚠️');
  });

  it('clamps to the line and returns empty for an inverted range', () => {
    expect(sliceDisplayRange('abc', 1, 99)).toBe('abc');
    expect(sliceDisplayRange('abc', 3, 2)).toBe('');
    expect(sliceDisplayRange(undefined, 1, 4)).toBe('');
  });
});

describe('lineDisplayWidth', () => {
  it('measures visible columns, not code points', () => {
    expect(lineDisplayWidth(`${BOLD}abc${RESET}`)).toBe(3);
    expect(lineDisplayWidth('日本語')).toBe(6);
    expect(lineDisplayWidth(undefined)).toBe(0);
  });
});

describe('resolveSelectionSpans', () => {
  const frame = ['first line here', 'second line', 'third line of text'];

  it('selects only the dragged columns on one row', () => {
    // Columns 7..11 inclusive — the focused cell is part of the selection.
    const spans = resolveSelectionSpans(frame, { x: 7, y: 1 }, { x: 10, y: 1 });
    expect(spans).toEqual([{ row: 1, startColumn: 7, endColumn: 11 }]);
    expect(extractSelectedText(frame, spans)).toBe('line');
  });

  it('normalizes a right-to-left drag', () => {
    const forward = resolveSelectionSpans(frame, { x: 7, y: 1 }, { x: 10, y: 1 });
    const backward = resolveSelectionSpans(frame, { x: 10, y: 1 }, { x: 7, y: 1 });
    expect(backward).toEqual(forward);
  });

  it('flows across rows instead of selecting a rectangle', () => {
    // First row runs to its end, middle rows are whole, the last stops at focus.
    const spans = resolveSelectionSpans(frame, { x: 7, y: 1 }, { x: 6, y: 3 });
    expect(spans).toEqual([
      { row: 1, startColumn: 7, endColumn: 16 },
      { row: 2, startColumn: 1, endColumn: 12 },
      { row: 3, startColumn: 1, endColumn: 7 },
    ]);
    expect(extractSelectedText(frame, spans)).toBe('line here\nsecond line\nthird ');
  });

  it('never selects past the end of a row', () => {
    const spans = resolveSelectionSpans(frame, { x: 1, y: 2 }, { x: 400, y: 2 });
    expect(spans).toEqual([{ row: 2, startColumn: 1, endColumn: 12 }]);
  });

  it('clamps rows to the frame', () => {
    const spans = resolveSelectionSpans(frame, { x: 1, y: 0 }, { x: 3, y: 99 });
    expect(spans[0].row).toBe(1);
    expect(spans[spans.length - 1].row).toBe(3);
  });

  it('keeps a blank row inside a multi-row selection', () => {
    // Two paragraphs separated by a blank line must not paste glued together.
    const paragraphs = ['first para', '', 'second para'];
    const spans = resolveSelectionSpans(paragraphs, { x: 1, y: 1 }, { x: 40, y: 3 });
    expect(spans).toHaveLength(3);
    expect(extractSelectedText(paragraphs, spans)).toBe(
      ['first para', '', 'second para'].join(String.fromCharCode(10)),
    );
  });

  it('returns nothing for an empty frame', () => {
    expect(resolveSelectionSpans([], { x: 1, y: 1 }, { x: 5, y: 1 })).toEqual([]);
  });

  it('takes whole rows at line granularity', () => {
    const spans = resolveSelectionSpans(frame, { x: 4, y: 1 }, { x: 2, y: 2 }, 'line');
    expect(spans).toEqual([
      { row: 1, startColumn: 1, endColumn: 16 },
      { row: 2, startColumn: 1, endColumn: 12 },
    ]);
  });

  it('grows both ends to whole words at word granularity', () => {
    // Pressing mid-"line" and dragging into "here" selects both entire words.
    const spans = resolveSelectionSpans(frame, { x: 8, y: 1 }, { x: 13, y: 1 }, 'word');
    expect(extractSelectedText(frame, spans)).toBe('line here');
  });
});

describe('expandToWord', () => {
  it('selects the identifier under the cell', () => {
    const line = 'call runAgentLoop() now';
    const span = expandToWord(line, 8);
    expect(span).not.toBeNull();
    expect(sliceDisplayRange(line, span!.startColumn, span!.endColumn)).toBe('runAgentLoop');
  });

  it('keeps a path together', () => {
    // Paths are what people double-click most in a coding transcript.
    const line = 'edited src/tui/app.tsx cleanly';
    const span = expandToWord(line, 10);
    expect(sliceDisplayRange(line, span!.startColumn, span!.endColumn)).toBe('src/tui/app.tsx');
  });

  it('selects a run of whitespace when pointed at a gap', () => {
    const line = 'a    b';
    const span = expandToWord(line, 3);
    expect(sliceDisplayRange(line, span!.startColumn, span!.endColumn)).toBe('    ');
  });

  it('stops at punctuation that is not part of a token', () => {
    const line = 'foo(bar)';
    const span = expandToWord(line, 5);
    expect(sliceDisplayRange(line, span!.startColumn, span!.endColumn)).toBe('bar');
  });

  it('resolves a wide glyph from either of its cells', () => {
    const line = '日本語';
    const fromFirst = expandToWord(line, 1);
    const fromSecond = expandToWord(line, 2);
    expect(fromSecond).toEqual(fromFirst);
  });

  it('does not let a whitespace run swallow half of a wide glyph', () => {
    // The continuation cell belongs to its owner, never to the run beside it.
    const line = '漢 next';
    const span = expandToWord(line, 3);
    expect(sliceDisplayRange(line, span!.startColumn, span!.endColumn)).toBe(' ');
  });

  it('returns null for an empty line', () => {
    expect(expandToWord('', 1)).toBeNull();
    expect(expandToWord(undefined, 1)).toBeNull();
  });
});

describe('extractSelectedText', () => {
  it('drops frame padding when a row was selected to its end', () => {
    const frame = ['padded text     ', '', ''];
    const spans = resolveSelectionSpans(frame, { x: 1, y: 1 }, { x: 40, y: 3 });
    expect(extractSelectedText(frame, spans)).toBe('padded text');
  });

  it('keeps whitespace a mid-row selection deliberately covered', () => {
    // Stopping the drag two cells past the word is a choice, not padding.
    const frame = ['alpha   beta'];
    const spans = resolveSelectionSpans(frame, { x: 1, y: 1 }, { x: 7, y: 1 });
    expect(extractSelectedText(frame, spans)).toBe('alpha  ');
  });

  it('strips styling from the copied text', () => {
    const frame = [`${BOLD}bold${RESET} plain`];
    const spans = resolveSelectionSpans(frame, { x: 1, y: 1 }, { x: 40, y: 1 });
    expect(extractSelectedText(frame, spans)).toBe('bold plain');
  });

  it('returns empty for no spans', () => {
    expect(extractSelectedText(['abc'], [])).toBe('');
  });
});
