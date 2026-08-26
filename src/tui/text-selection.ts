import { displayWidth, stripAnsi } from './components/word-wrap.js';

/** 1-based terminal cell coordinates as reported by SGR mouse events. */
export interface SelectionCell {
  x: number;
  y: number;
}

export interface SelectionRange {
  start: SelectionCell;
  end: SelectionCell;
}

export interface SelectionRowSegment {
  row: number;
  startColumn: number;
  endColumn: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const normalizeCell = ({ x, y }: SelectionCell): SelectionCell => ({
  x: Math.max(1, Math.floor(x)),
  y: Math.max(1, Math.floor(y)),
});

const compareCells = (left: SelectionCell, right: SelectionCell): number =>
  left.y === right.y ? left.x - right.x : left.y - right.y;

/** Normalize anchor/focus into ordered, inclusive terminal-cell endpoints. */
export function normalizeSelectionRange(
  anchor: SelectionCell,
  focus: SelectionCell,
): SelectionRange {
  const normalizedAnchor = normalizeCell(anchor);
  const normalizedFocus = normalizeCell(focus);
  return compareCells(normalizedAnchor, normalizedFocus) <= 0
    ? { start: normalizedAnchor, end: normalizedFocus }
    : { start: normalizedFocus, end: normalizedAnchor };
}

/** Return the selected inclusive columns for one rendered row. */
export function getSelectionRowSegment(
  range: SelectionRange,
  row: number,
  lineWidth: number,
): SelectionRowSegment | null {
  const normalizedRow = Math.max(1, Math.floor(row));
  const normalizedWidth = Math.max(0, Math.floor(lineWidth));
  if (normalizedWidth === 0 || normalizedRow < range.start.y || normalizedRow > range.end.y) {
    return null;
  }

  const startColumn = normalizedRow === range.start.y ? range.start.x : 1;
  const requestedEnd = normalizedRow === range.end.y ? range.end.x : normalizedWidth;
  const endColumn = Math.min(normalizedWidth, requestedEnd);
  if (startColumn > normalizedWidth || endColumn < startColumn) return null;
  return { row: normalizedRow, startColumn, endColumn };
}

/** Slice plain text by an inclusive terminal-column range without splitting wide glyphs. */
export function sliceDisplayColumns(text: string, startColumn: number, endColumn: number): string {
  const plain = stripAnsi(text);
  const start = Math.max(1, Math.floor(startColumn));
  const end = Math.max(0, Math.floor(endColumn));
  if (!plain || end < start) return '';

  let column = 1;
  let selected = '';
  for (const { segment } of graphemeSegmenter.segment(plain)) {
    const width = displayWidth(segment);
    if (width === 0) {
      if (selected) selected += segment;
      continue;
    }

    const segmentEnd = column + width - 1;
    if (segmentEnd >= start && column <= end) selected += segment;
    column = segmentEnd + 1;
    if (column > end) break;
  }
  return selected;
}

/** Extract selected visible cells, removing terminal styling and layout padding. */
export function extractSelectedText(frameLines: readonly string[], range: SelectionRange): string {
  if (frameLines.length === 0) return '';
  const top = Math.max(1, range.start.y);
  const bottom = Math.min(frameLines.length, range.end.y);
  if (bottom < top) return '';

  const lines: string[] = [];
  for (let row = top; row <= bottom; row++) {
    const plain = stripAnsi(frameLines[row - 1] ?? '');
    const segment = getSelectionRowSegment(range, row, displayWidth(plain));
    lines.push(
      segment ? sliceDisplayColumns(plain, segment.startColumn, segment.endColumn).trimEnd() : '',
    );
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
