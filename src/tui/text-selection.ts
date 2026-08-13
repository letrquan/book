import { stripAnsi } from './components/word-wrap.js';

/** 1-based terminal cell coordinates as reported by SGR mouse events. */
export interface SelectionCell {
  x: number;
  y: number;
}

export interface SelectionRowRange {
  topRow: number;
  bottomRow: number;
}

/**
 * Normalize an anchor/focus pair into an ordered row range. Selection is
 * line-based: every row between (and including) the endpoints is selected.
 */
export function normalizeSelectionRange(
  anchor: SelectionCell,
  focus: SelectionCell,
): SelectionRowRange {
  const first = Math.min(anchor.y, focus.y);
  const last = Math.max(anchor.y, focus.y);
  return { topRow: Math.max(1, first), bottomRow: Math.max(1, last) };
}

/**
 * Extract the selected text from captured frame lines. Rows are clamped to
 * the frame, ANSI is stripped, trailing blanks are trimmed per line, and
 * trailing blank lines are dropped.
 */
export function extractSelectedText(
  frameLines: readonly string[],
  range: SelectionRowRange,
): string {
  if (frameLines.length === 0) return '';
  const top = Math.max(1, range.topRow);
  const bottom = Math.min(frameLines.length, range.bottomRow);
  if (bottom < top) return '';

  const lines: string[] = [];
  for (let row = top; row <= bottom; row++) {
    lines.push(stripAnsi(frameLines[row - 1] ?? '').trimEnd());
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
