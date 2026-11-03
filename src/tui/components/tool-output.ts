import { expandTabs as expandToTabStops } from '../../tab-stops.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';

export interface ToolOutputDisplayOptions {
  maxLines: number;
  maxLineWidth: number;
  /** Optional hint appended to the footer when output is hidden. */
  hint?: string;
  /**
   * Select initial lines, final lines, or a balanced initial/final preview. A `wrap` display
   * shows the head or the tail of the output; it reads `head-tail` as `head`.
   */
  strategy?: 'head' | 'tail' | 'head-tail';
  /** What becomes of a line wider than `maxLineWidth`; see {@link LongLineMode}. Default `cut`. */
  longLines?: LongLineMode;
}

/**
 * What a display does with a line wider than `maxLineWidth`:
 * - `cut`: shorten it to the width (the row counts as a shortened line); `maxLines` bounds lines.
 * - `wrap`: continue it on the rows after it, so no line is shortened; `maxLines` then bounds the
 *   rows, and a line the bound cuts into keeps its rows beside the lines already shown (its first
 *   rows for the head, its last for the tail) and counts as shortened, not hidden.
 * - `whole`: leave it as it is, for a caller that wraps the text itself (Markdown).
 */
export type LongLineMode = 'cut' | 'wrap' | 'whole';

/** Where one row of a `wrap` display came from: columns `start` to `end` of a source line. */
export interface WrappedRowSource {
  /** Index into {@link ToolOutputDisplay.sourceLines}. */
  line: number;
  /** UTF-16 offsets into that line, tabs expanded. */
  start: number;
  end: number;
}

export interface ToolOutputDisplay {
  lines: string[];
  totalLines: number;
  totalChars: number;
  hiddenLines: number;
  truncatedLines: number;
  truncated: boolean;
  footer?: string;
  /**
   * `wrap` mode only: the tab-expanded lines the rows were cut from, whole, and for each row where
   * it came from, so a caller can style the whole line (a highlighter needs it) and slice it.
   */
  sourceLines?: string[];
  rowSources?: WrappedRowSource[];
}

/**
 * Where the lines of `output` end: before the newlines it ends in. Those are no lines of the output
 * but what its last newline (real output ends in one) and any blank lines after its last text leave
 * behind, so a block draws nothing for them and a count does not name them.
 */
function outputLinesEnd(output: string): number {
  let end = output.length;
  while (end > 0 && output.charCodeAt(end - 1) === 10) end--;
  return end;
}

/**
 * `line` with each tab replaced by spaces up to the next 8-column tab stop, counted in display
 * columns from the start of the line: a wide character takes two columns, an ANSI escape none.
 * A line without a tab comes back as it is.
 *
 * `string-width`, and so Ink's layout, measures a tab as no cells while the terminal moves to the
 * next tab stop, so a row holding one is wider on screen than the width it was cut to (#537). The
 * algorithm and its stops are the frame clip's own (`expandTabs` in `tab-stops.ts`), here measured
 * with {@link displayWidth}, so the two cannot drift. Eight-column stops, not the fixed
 * four spaces a user message's tab gets, keep the columns of `make`, `ls`, TSV and `column` output
 * aligned the way the command's own terminal shows them.
 */
export function expandTabs(line: string): string {
  return line.indexOf('\t') === -1 ? line : expandToTabStops(line, displayWidth);
}

/**
 * THE definition of a tool output's lines, and the only one: the pieces between newlines, with
 * every empty line the output ends in dropped. The empty lines inside it stay (a blank line between
 * two paragraphs is a row), and so does a line of whitespace, which is not empty. Only a newline
 * splits: the `\r` of a CRLF stays at the end of its line. A header's line count, the block's rows,
 * its `… +N lines` footers and the hint that counts a command's hidden stdout all read it, so they
 * cannot disagree: {@link countOutputLines} counts these lines without making them.
 */
function splitOutputLines(output: string): string[] {
  const end = outputLinesEnd(output);
  return end === 0 ? [] : output.slice(0, end).split('\n');
}

/**
 * How many lines {@link splitOutputLines} makes of `output` (the `totalLines` of its display), found
 * by scanning for newlines: a large output costs one pass and no allocation per line.
 */
export function countOutputLines(output: string): number {
  const end = outputLinesEnd(output);
  if (end === 0) return 0;
  let lines = 1;
  for (let at = output.indexOf('\n'); at !== -1 && at < end; at = output.indexOf('\n', at + 1)) {
    lines++;
  }
  return lines;
}

/**
 * Prepare tool output for terminal display without mutating the underlying result.
 * Counts the original output, then returns a bounded, display-width-aware preview. `lines` are the
 * rows to draw, each one a row even when empty. A row is measured and cut with its tabs expanded to
 * the terminal's stops ({@link expandTabs}), the width it takes on screen; only the visible lines
 * are expanded, so a long output pays for the rows it shows.
 */
export function prepareToolOutputDisplay(
  output: string,
  { maxLines, maxLineWidth, hint, strategy = 'head', longLines = 'cut' }: ToolOutputDisplayOptions,
): ToolOutputDisplay {
  if (longLines === 'wrap') {
    return wrappedToolOutputDisplay(output, maxLines, maxLineWidth, hint, strategy === 'tail');
  }
  const rawLines = splitOutputLines(output);
  const lineLimit = Math.max(0, Math.floor(maxLines));
  const widthLimit =
    longLines === 'whole' ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.floor(maxLineWidth));
  const visibleIndices = selectVisibleLineIndices(rawLines.length, lineLimit, strategy);
  const visibleRawLines = visibleIndices.map((index) => rawLines[index] ?? '');
  let truncatedLines = 0;
  const lines = visibleRawLines.map((rawLine) => {
    // Shortened means cut from the row as the screen shows it, so compare with the expanded line.
    const line = expandTabs(rawLine);
    const next = truncateDisplay(line, widthLimit);
    if (displayWidth(next) < displayWidth(line) || next !== line) truncatedLines++;
    return next;
  });
  const hiddenLines = Math.max(0, rawLines.length - visibleRawLines.length);
  const truncated = hiddenLines > 0 || truncatedLines > 0;
  const footer = truncated
    ? formatToolOutputFooter({ hiddenLines, truncatedLines, hint })
    : undefined;

  return {
    lines,
    totalLines: rawLines.length,
    totalChars: output.length,
    hiddenLines,
    truncatedLines,
    truncated,
    footer,
  };
}

const SGR = /\u001b\[[0-9;]*m/y;

/** One row of a wrapped line: its text, and the offsets in the line it was cut from. */
interface WrappedRow {
  text: string;
  start: number;
  end: number;
}

/**
 * Hands `onRow` the rows of `line` wrapped at display width `width`, first to last, until it
 * returns false. An ANSI SGR sequence stays whole and takes no width.
 */
function eachWrapRow(line: string, width: number, onRow: (row: WrappedRow) => boolean): void {
  let current = '';
  let currentWidth = 0;
  let start = 0;
  for (let i = 0; i < line.length;) {
    SGR.lastIndex = i;
    const sgr = SGR.exec(line);
    if (sgr) {
      current += sgr[0];
      i += sgr[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const chWidth = displayWidth(ch);
    if (currentWidth > 0 && currentWidth + chWidth > width) {
      if (!onRow({ text: current, start, end: i })) return;
      current = '';
      currentWidth = 0;
      start = i;
    }
    i += ch.length;
    current += ch;
    currentWidth += chWidth;
  }
  onRow({ text: current, start, end: line.length });
}

/**
 * The first `room` rows of `line` wrapped at display width `width`, and whether the line has more
 * (it stops once it has them, so a huge line costs only the rows kept).
 */
function firstWrapRows(
  line: string,
  width: number,
  room: number,
): { rows: WrappedRow[]; cut: boolean } {
  const rows: WrappedRow[] = [];
  eachWrapRow(line, width, (row) => {
    rows.push(row);
    return rows.length <= room;
  });
  return rows.length > room ? { rows: rows.slice(0, room), cut: true } : { rows, cut: false };
}

/**
 * The last `room` rows of `line` wrapped at display width `width`, and whether the line has rows
 * before them. Rows are cut from the start of a line, so the pass covers all of it, but only a
 * window of at most `2 * room` rows is held. A tool result is clipped to `TOOL_RESULT_MAX_BYTES`
 * before a row sees it, and the display is memoized, so the pass is bounded by that, as
 * `hardWrapLine` over the whole line was.
 */
function lastWrapRows(
  line: string,
  width: number,
  room: number,
): { rows: WrappedRow[]; cut: boolean } {
  const rows: WrappedRow[] = [];
  let cut = false;
  eachWrapRow(line, width, (row) => {
    rows.push(row);
    if (rows.length > 2 * room) {
      rows.splice(0, rows.length - room);
      cut = true;
    }
    return true;
  });
  if (rows.length > room) {
    rows.splice(0, rows.length - room);
    cut = true;
  }
  return { rows, cut };
}

/**
 * The head of `output` (the tail, with `fromEnd`) with each line wrapped at display width
 * `maxLineWidth`, at most `maxLines` rows. Nothing is shortened except by the row bound: a line it
 * cuts into keeps its first rows (its last, for the tail), counts as shortened (some of it is on
 * screen), and is not counted as hidden; only the lines beyond it are. Reading from the end shows
 * the rows a head display shows when the bound cuts nothing.
 */
function wrappedToolOutputDisplay(
  output: string,
  maxLines: number,
  maxLineWidth: number,
  hint: string | undefined,
  fromEnd: boolean,
): ToolOutputDisplay {
  const rawLines = splitOutputLines(output);
  const rowLimit = Math.max(0, Math.floor(maxLines));
  const width = Math.max(1, Math.floor(maxLineWidth));
  // The lines taken, each with the rows kept of it, in the order they were read: the first line
  // first for the head, the last line first for the tail.
  const taken: { line: string; rows: WrappedRow[] }[] = [];
  let rowCount = 0;
  let truncatedLines = 0;
  for (let step = 0; step < rawLines.length && rowCount < rowLimit; step++) {
    const line = expandTabs(rawLines[fromEnd ? rawLines.length - 1 - step : step]!);
    const room = rowLimit - rowCount;
    const { rows, cut } = fromEnd
      ? lastWrapRows(line, width, room)
      : firstWrapRows(line, width, room);
    taken.push({ line, rows });
    rowCount += rows.length;
    if (cut) {
      truncatedLines = 1;
      break;
    }
  }
  if (fromEnd) taken.reverse();
  const lines: string[] = [];
  const sourceLines: string[] = [];
  const rowSources: WrappedRowSource[] = [];
  for (const { line, rows } of taken) {
    for (const row of rows) {
      lines.push(row.text);
      rowSources.push({ line: sourceLines.length, start: row.start, end: row.end });
    }
    sourceLines.push(line);
  }
  const hiddenLines = rawLines.length - taken.length;
  const truncated = hiddenLines > 0 || truncatedLines > 0;
  const footer = truncated
    ? formatToolOutputFooter({ hiddenLines, truncatedLines, hint })
    : undefined;
  return {
    lines,
    totalLines: rawLines.length,
    totalChars: output.length,
    hiddenLines,
    truncatedLines,
    truncated,
    footer,
    sourceLines,
    rowSources,
  };
}

function selectVisibleLineIndices(
  totalLines: number,
  maxLines: number,
  strategy: NonNullable<ToolOutputDisplayOptions['strategy']>,
): number[] {
  if (maxLines <= 0 || totalLines <= 0) return [];
  if (totalLines <= maxLines) return Array.from({ length: totalLines }, (_, index) => index);
  if (strategy === 'tail') {
    return Array.from({ length: maxLines }, (_, index) => totalLines - maxLines + index);
  }
  if (strategy === 'head-tail' && maxLines > 1) {
    const headLines = Math.ceil(maxLines / 2);
    const tailLines = maxLines - headLines;
    return [
      ...Array.from({ length: headLines }, (_, index) => index),
      ...Array.from({ length: tailLines }, (_, index) => totalLines - tailLines + index),
    ];
  }
  return Array.from({ length: maxLines }, (_, index) => index);
}

const lineNoun = (count: number): string => (count === 1 ? 'line' : 'lines');

/**
 * `… +N lines, M long lines shortened, +K lines of output (hint)`; each part appears only when it
 * applies.
 */
export function formatToolOutputFooter({
  hiddenLines,
  truncatedLines,
  hint,
  outputLines = 0,
}: {
  hiddenLines: number;
  truncatedLines: number;
  hint?: string;
  /**
   * Lines of a command's stdout that the rows above leave out, counted apart from `hiddenLines`,
   * which are lines of those rows: `… +2 lines, +1 line of output`.
   */
  outputLines?: number;
}): string {
  const parts: string[] = [];
  if (hiddenLines > 0) parts.push(`+${hiddenLines} ${lineNoun(hiddenLines)}`);
  if (truncatedLines > 0)
    parts.push(`${truncatedLines} long ${lineNoun(truncatedLines)} shortened`);
  if (outputLines > 0) parts.push(`+${outputLines} ${lineNoun(outputLines)} of output`);
  return `… ${parts.join(', ')}${hint ? ` (${hint})` : ''}`;
}
