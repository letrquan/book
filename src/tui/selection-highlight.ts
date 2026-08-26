import type { FrameCursorPosition } from './frame-buffer.js';
import { sliceDisplayRange, type SelectionSpan } from './text-selection.js';

const cursorTo = (row: number, column = 1): string =>
  `\x1b[${Math.max(1, Math.floor(row))};${Math.max(1, Math.floor(column))}H`;

/**
 * Paint a selection in inverse video, one partial row at a time.
 *
 * Only the selected columns are rewritten. Everything else on the row is left
 * exactly as Ink drew it, which keeps the transcript's colours intact while the
 * selection is up — repainting whole rows from the ANSI-stripped frame would
 * blank the syntax highlighting under the cursor on every drag event.
 */
export function paintSelectionSpans(
  write: (data: string) => unknown,
  frameLines: readonly string[],
  spans: readonly SelectionSpan[],
): void {
  for (const span of spans) {
    const text = sliceDisplayRange(frameLines[span.row - 1], span.startColumn, span.endColumn);
    if (!text) continue;
    write(cursorTo(span.row, span.startColumn) + '\x1b[7m' + text + '\x1b[27m');
  }
}

/**
 * Repaint the rows a selection covered and hand the cursor back to Ink.
 *
 * The frame line carries its original styling, so rewriting the whole row is
 * what restores the colour the inverse-video span replaced.
 */
export function restoreSelectionSpans(
  write: (data: string) => unknown,
  frameLines: readonly string[],
  spans: readonly SelectionSpan[],
  cursor: FrameCursorPosition | null,
): void {
  const rows = new Set(spans.map((span) => span.row));
  for (const row of rows) {
    write(cursorTo(row) + (frameLines[row - 1] ?? '') + '\x1b[K');
  }
  if (cursor) {
    write(`\x1b[${cursor.y};${cursor.x + 1}H\x1b[?25h`);
    return;
  }
  if (frameLines.length > 0) write(cursorTo(frameLines.length) + '\x1b[?25l');
}
