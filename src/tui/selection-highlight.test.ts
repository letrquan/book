import { describe, expect, it } from 'vitest';
import { paintSelectionSpans, restoreSelectionSpans } from './selection-highlight.js';
import type { SelectionSpan } from './text-selection.js';

const frame = ['row one text', 'row two text', 'row three text'];

function capture(): { write: (data: string) => void; output: () => string } {
  const chunks: string[] = [];
  return { write: (data: string) => void chunks.push(data), output: () => chunks.join('') };
}

describe('paintSelectionSpans', () => {
  it('inverts only the selected columns', () => {
    const spans: SelectionSpan[] = [{ row: 2, startColumn: 5, endColumn: 8 }];
    const sink = capture();
    paintSelectionSpans(sink.write, frame, spans);
    // Positioned at the span's start, not the row's, and carrying only its text.
    expect(sink.output()).toContain('\x1b[2;5H\x1b[7mtwo\x1b[27m');
    expect(sink.output()).not.toContain('row one');
  });

  it('parks the cursor at the end of the frame when it is done', () => {
    // Ink's incremental renderer erases relative to the current cursor row, so a
    // cursor left mid-frame makes the next shorter frame blank rows in the
    // middle of the transcript and never repaint them.
    const sink = capture();
    paintSelectionSpans(sink.write, frame, [{ row: 1, startColumn: 1, endColumn: 4 }]);
    expect(sink.output().endsWith(`\x1b[${frame.length};1H\x1b[?25l`)).toBe(true);
  });

  it('skips spans that cover no text but still parks the cursor', () => {
    const sink = capture();
    paintSelectionSpans(sink.write, frame, [{ row: 2, startColumn: 3, endColumn: 3 }]);
    expect(sink.output()).toBe(`\x1b[${frame.length};1H\x1b[?25l`);
  });

  it('writes nothing for an empty frame', () => {
    const sink = capture();
    paintSelectionSpans(sink.write, [], [{ row: 1, startColumn: 1, endColumn: 4 }]);
    expect(sink.output()).toBe('');
  });
});

describe('restoreSelectionSpans', () => {
  it('repaints each covered row once, with its original styling', () => {
    const sink = capture();
    restoreSelectionSpans(
      sink.write,
      frame,
      [
        { row: 2, startColumn: 1, endColumn: 4 },
        { row: 2, startColumn: 6, endColumn: 9 },
      ],
      null,
    );
    const output = sink.output();
    expect(output.split('row two text')).toHaveLength(2);
    expect(output).toContain('\x1b[2;1Hrow two text\x1b[K');
  });

  it('hands the cursor back one row past Ink 0-based index', () => {
    // buildCursorSuffix moves up from the row after the last line, so a
    // cursorPosition of y=0 is absolute row 1.
    const sink = capture();
    restoreSelectionSpans(sink.write, frame, [{ row: 1, startColumn: 1, endColumn: 4 }], {
      x: 4,
      y: 0,
    });
    expect(sink.output().endsWith('\x1b[1;5H\x1b[?25h')).toBe(true);
  });

  it('parks at the frame end when Ink has no cursor of its own', () => {
    const sink = capture();
    restoreSelectionSpans(sink.write, frame, [{ row: 1, startColumn: 1, endColumn: 4 }], null);
    expect(sink.output().endsWith(`\x1b[${frame.length};1H\x1b[?25l`)).toBe(true);
  });
});
