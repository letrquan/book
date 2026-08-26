import { displayWidth, stripAnsi } from './components/word-wrap.js';

/** 1-based terminal cell coordinates as reported by SGR mouse events. */
export interface SelectionCell {
  x: number;
  y: number;
}

/**
 * One row's selected columns.
 *
 * `startColumn` is 1-based and inclusive, `endColumn` is 1-based and exclusive,
 * both measured in display columns rather than code points so a wide glyph is
 * one indivisible cell.
 */
export interface SelectionSpan {
  row: number;
  startColumn: number;
  endColumn: number;
}

/** How a press expands into a selection, matching terminal click conventions. */
export type SelectionGranularity = 'character' | 'word' | 'line';

/** Characters a terminal treats as part of a word when you double-click one. */
const WORD_CHARACTER = /[\p{L}\p{N}_\-./\\:@~+]/u;

/**
 * Cells of a rendered line, one entry per display column.
 *
 * Zero-width code points — combining marks, variation selectors, ZWJ — occupy
 * no column of their own, so they are folded into the cell they modify rather
 * than skipped. Dropping them would copy text that differs from what was
 * highlighted: `café` would come back as `cafe`, and a ZWJ emoji sequence
 * would come back as its separate parts.
 */
function toColumns(line: string): string[] {
  const columns: string[] = [];
  let owner = -1;
  let pending = '';
  for (const character of stripAnsi(line)) {
    const width = displayWidth(character);
    if (width <= 0) {
      // Attach to the glyph that owns the cell, not to its continuation.
      if (owner >= 0) columns[owner] += character;
      else pending += character;
      continue;
    }
    columns.push(pending + character);
    pending = '';
    owner = columns.length - 1;
    // A wide glyph owns a trailing cell that belongs to no separate character.
    for (let extra = 1; extra < width; extra++) columns.push('');
  }
  if (pending && columns.length === 0) columns.push(pending);
  return columns;
}

/** Display width of a rendered line, ignoring styling. */
export function lineDisplayWidth(line: string | undefined): number {
  return displayWidth(stripAnsi(line ?? ''));
}

/**
 * Extract a 1-based, half-open display-column range from a rendered line.
 *
 * Slicing by column rather than by code point keeps CJK and emoji intact: a
 * range that would cut a wide glyph in half yields the whole glyph rather than
 * a broken cell.
 */
export function sliceDisplayRange(
  line: string | undefined,
  startColumn: number,
  endColumn: number,
): string {
  const columns = toColumns(line ?? '');
  const from = Math.max(1, Math.floor(startColumn));
  const to = Math.min(columns.length + 1, Math.floor(endColumn));
  if (to <= from) return '';
  return columns.slice(from - 1, to - 1).join('');
}

/**
 * Grow a single cell into the word under it.
 *
 * Terminals treat a double-click as "select the token I am pointing at", which
 * is the gesture people actually use to copy an identifier or a path out of a
 * line. Clicking whitespace selects the run of whitespace, exactly as xterm and
 * iTerm2 do, so the gesture always has an answer.
 */
export function expandToWord(line: string | undefined, column: number): SelectionSpan | null {
  const columns = toColumns(line ?? '');
  if (columns.length === 0) return null;
  const index = Math.min(Math.max(1, Math.floor(column)), columns.length) - 1;

  // A wide glyph's trailing cell is empty; walk back to the glyph that owns it.
  let anchor = index;
  while (anchor > 0 && columns[anchor] === '') anchor--;

  const isWord = WORD_CHARACTER.test(columns[anchor]);
  // A continuation cell is part of its owner, so it belongs to whichever run
  // the owning glyph belongs to — never to both.
  const matchesAt = (cell: number) => {
    let owner = cell;
    while (owner > 0 && columns[owner] === '') owner--;
    return WORD_CHARACTER.test(columns[owner]) === isWord;
  };

  let start = anchor;
  while (start > 0 && matchesAt(start - 1)) start--;
  let end = anchor + 1;
  while (end < columns.length && matchesAt(end)) end++;

  return { row: 0, startColumn: start + 1, endColumn: end + 1 };
}

/**
 * Resolve an anchor/focus pair into the rows and columns it covers.
 *
 * This is flow selection, not a rectangular block: the first row runs from the
 * anchor to the end of its text, whole rows in between are taken entirely, and
 * the last row runs from its start to the focus. That is what a terminal — and
 * every text surface — does, and it is the difference between copying a
 * sentence that spans two lines and copying two truncated fragments.
 */
export function resolveSelectionSpans(
  frameLines: readonly string[],
  anchor: SelectionCell,
  focus: SelectionCell,
  granularity: SelectionGranularity = 'character',
): SelectionSpan[] {
  if (frameLines.length === 0) return [];

  const clampRow = (row: number) => Math.min(Math.max(1, Math.floor(row)), frameLines.length);
  let start = { x: Math.max(1, Math.floor(anchor.x)), y: clampRow(anchor.y) };
  let end = { x: Math.max(1, Math.floor(focus.x)), y: clampRow(focus.y) };
  if (end.y < start.y || (end.y === start.y && end.x < start.x)) {
    [start, end] = [end, start];
  }

  if (granularity === 'line') {
    const spans: SelectionSpan[] = [];
    for (let row = start.y; row <= end.y; row++) {
      spans.push({ row, startColumn: 1, endColumn: lineDisplayWidth(frameLines[row - 1]) + 1 });
    }
    return spans.filter((span) => span.endColumn > span.startColumn);
  }

  if (granularity === 'word') {
    // Anchor and focus each grow to their own word, and the selection covers
    // everything between the outer edges — dragging after a double-click keeps
    // extending by whole words, as it does natively.
    const first = expandToWord(frameLines[start.y - 1], start.x);
    const last = expandToWord(frameLines[end.y - 1], end.x);
    if (first) start = { x: first.startColumn, y: start.y };
    if (last) end = { x: last.endColumn - 1, y: end.y };
  }

  const spans: SelectionSpan[] = [];
  for (let row = start.y; row <= end.y; row++) {
    const width = lineDisplayWidth(frameLines[row - 1]);
    const startColumn = row === start.y ? Math.min(start.x, width + 1) : 1;
    // The focused cell is part of the selection, so the exclusive end is one past it.
    const endColumn = row === end.y ? Math.min(end.x + 1, width + 1) : width + 1;
    // Empty rows are kept, not dropped: a blank line between two paragraphs is
    // part of what was selected, and discarding its span would paste the
    // paragraphs glued together.
    spans.push({ row, startColumn, endColumn: Math.max(startColumn, endColumn) });
  }
  return spans;
}

/**
 * The text a selection copies.
 *
 * Each row contributes only its selected columns. Trailing whitespace is
 * dropped only where the span ran to the end of the row, because that padding
 * is an artifact of the rendered frame rather than something anyone pointed at;
 * a span that stops mid-row keeps exactly the cells it covered, spaces included.
 */
export function extractSelectedText(
  frameLines: readonly string[],
  spans: readonly SelectionSpan[],
): string {
  if (spans.length === 0) return '';
  const lines = spans.map((span) => {
    const line = frameLines[span.row - 1];
    const text = sliceDisplayRange(line, span.startColumn, span.endColumn);
    return span.endColumn > lineDisplayWidth(line) ? text.trimEnd() : text;
  });
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
