/**
 * The terminal's tab stops, shared by what lays text out ahead of the terminal (the transcript's
 * Markdown and tool output) and the frame clip that checks the rows it draws (`cli/ink-frame-clip`).
 * Both must put a tab on the same column, or a row laid out to fit the width comes out wider on
 * screen. No imports, so a TUI component can take it without the Ink loader the clip pulls in.
 */

/** Terminal cells a string takes: `string-width`'s answer, or `displayWidth`'s. A tab is no cells. */
export type StringWidth = (text: string) => number;

/** The terminal's tab stops: every eighth column. */
const TAB_STOP = 8;

/**
 * Replaces every tab with spaces up to the next tab stop, as the terminal would move the cursor,
 * counting visible columns from the start of the row, or from `startColumn` for text that is drawn
 * that many columns in. `measure` skips ANSI escapes.
 */
export function expandTabs(row: string, measure: StringWidth, startColumn = 0): string {
  const parts = row.split('\t');
  let expanded = parts[0] ?? '';
  let column = startColumn + measure(expanded);
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index] ?? '';
    const pad = TAB_STOP - (column % TAB_STOP);
    expanded += ' '.repeat(pad) + part;
    column += pad + measure(part);
  }
  return expanded;
}
