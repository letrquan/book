import { sliceDisplayWidth } from './components/word-wrap.js';
import type { FrameCursorPosition } from './frame-buffer.js';
import type { SelectionRowRange } from './text-selection.js';

const cursorTo = (row: number): string => `\x1b[${Math.max(1, Math.floor(row))};1H`;

/**
 * Paint selected rows in inverse video using raw writes. The frame is
 * anchored at terminal row 1, so selection rows map 1:1 to screen rows.
 */
export function paintSelectionRows(
  write: (data: string) => unknown,
  frameLines: readonly string[],
  range: SelectionRowRange,
  columns: number,
): void {
  for (let row = range.topRow; row <= range.bottomRow; row++) {
    const plain = sliceDisplayWidth(frameLines[row - 1] ?? '', columns);
    write(cursorTo(row) + '\x1b[7m' + plain + '\x1b[0m\x1b[K');
  }
}

/**
 * Repaint previously highlighted rows from the raw frame, then restore the
 * cursor invariant Ink's log-update relies on (cursor on the frame bottom
 * row, or at the last explicitly requested position).
 */
export function restoreSelectionRows(
  write: (data: string) => unknown,
  frameLines: readonly string[],
  range: SelectionRowRange,
  cursor: FrameCursorPosition | null,
): void {
  for (let row = range.topRow; row <= range.bottomRow; row++) {
    write(cursorTo(row) + (frameLines[row - 1] ?? '') + '\x1b[K');
  }
  if (cursor) {
    write(`\x1b[${cursor.y};${cursor.x + 1}H\x1b[?25h`);
    return;
  }
  if (frameLines.length > 0) write(cursorTo(frameLines.length) + '\x1b[?25l');
}
