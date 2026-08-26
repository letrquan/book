import { displayWidth, stripAnsi } from './components/word-wrap.js';
import type { FrameCursorPosition } from './frame-buffer.js';
import { getSelectionRowSegment, type SelectionRange } from './text-selection.js';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const cursorTo = (row: number, column = 1): string =>
  `\x1b[${Math.max(1, Math.floor(row))};${Math.max(1, Math.floor(column))}H`;

export interface SelectionHighlightSpan {
  startColumn: number;
  text: string;
}

function restoreCursorSequence(cursor: FrameCursorPosition | null, frameRows: number): string {
  if (cursor) {
    return `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h`;
  }
  return frameRows > 0 ? cursorTo(frameRows) + '\x1b[?25l' : '';
}

/** Resolve the exact cells to repaint for one selected frame row. */
export function getSelectionHighlightSpan(
  frameLine: string,
  range: SelectionRange,
  row: number,
  columns: number,
): SelectionHighlightSpan | null {
  const limit = Math.max(1, Math.floor(columns));
  const requested = getSelectionRowSegment(range, row, limit);
  if (!requested) return null;

  const plain = stripAnsi(frameLine);
  let startColumn = requested.startColumn;
  let endColumn = requested.endColumn;
  let column = 1;
  let text = '';

  for (const { segment: grapheme } of graphemeSegmenter.segment(plain)) {
    const width = displayWidth(grapheme);
    if (width === 0) {
      if (text) text += grapheme;
      continue;
    }

    const graphemeEnd = column + width - 1;
    if (graphemeEnd >= requested.startColumn && column <= requested.endColumn) {
      if (!text) startColumn = Math.min(startColumn, column);
      endColumn = Math.max(endColumn, graphemeEnd);
      text += grapheme;
    }
    column = graphemeEnd + 1;
    if (column > requested.endColumn && text) break;
  }

  const padding = Math.max(0, endColumn - startColumn + 1 - displayWidth(text));
  return { startColumn, text: text + ' '.repeat(padding) };
}

/** Paint a character-level selection and return the cursor to Ink's anchor. */
export function paintSelection(
  write: (data: string) => unknown,
  frameLines: readonly string[],
  range: SelectionRange,
  columns: number,
  cursor: FrameCursorPosition | null,
): void {
  const top = Math.max(1, range.start.y);
  const bottom = Math.min(frameLines.length, range.end.y);
  let output = '';
  for (let row = top; row <= bottom; row++) {
    const highlighted = getSelectionHighlightSpan(frameLines[row - 1] ?? '', range, row, columns);
    if (highlighted !== null) {
      output += cursorTo(row, highlighted.startColumn) + '\x1b[7m' + highlighted.text + '\x1b[0m';
    }
  }
  if (output) write(output + restoreCursorSequence(cursor, frameLines.length));
}

/** Restore the frame rows under a selection and return the cursor to Ink's anchor. */
export function restoreSelection(
  write: (data: string) => unknown,
  frameLines: readonly string[],
  range: SelectionRange,
  cursor: FrameCursorPosition | null,
): void {
  const top = Math.max(1, range.start.y);
  const bottom = Math.min(frameLines.length, range.end.y);
  let output = '';
  for (let row = top; row <= bottom; row++) {
    output += cursorTo(row) + (frameLines[row - 1] ?? '') + '\x1b[K';
  }
  if (output) write(output + restoreCursorSequence(cursor, frameLines.length));
}
