import type { FrameCursorPosition } from './frame-buffer.js';
import { sliceDisplayRange, type SelectionSpan } from './text-selection.js';

const cursorTo = (row: number, column = 1): string =>
  `\x1b[${Math.max(1, Math.floor(row))};${Math.max(1, Math.floor(column))}H`;

/**
 * Park the cursor where Ink's renderer assumes it is: the bottom of the frame.
 *
 * Every out-of-band write here has to end this way. Ink's incremental renderer
 * erases and moves *relative to the current cursor row* — a shorter next frame
 * emits `eraseLines(...)` from wherever the cursor happens to be — so leaving it
 * parked mid-frame makes the next render blank rows in the middle of the
 * transcript and never repaint them, because Ink still believes they are
 * unchanged. Renders land mid-drag routinely: the elapsed-time clock alone
 * guarantees it.
 */
function parkCursorAtFrameEnd(
  write: (data: string) => unknown,
  frameLines: readonly string[],
): void {
  if (frameLines.length > 0) write(cursorTo(frameLines.length) + '\x1b[?25l');
}

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
  parkCursorAtFrameEnd(write, frameLines);
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
    // Ink's cursorPosition is a 0-based line index within the frame — its own
    // buildCursorSuffix moves up from the row after the last line — so the
    // absolute row is one past it, matching the 1-based column already used.
    write(`\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h`);
    return;
  }
  parkCursorAtFrameEnd(write, frameLines);
}
