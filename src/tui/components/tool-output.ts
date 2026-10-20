import { expandTabs as expandToTabStops } from '../../cli/ink-frame-clip.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';

export interface ToolOutputDisplayOptions {
  maxLines: number;
  maxLineWidth: number;
  /** Optional hint appended to the footer when output is hidden. */
  hint?: string;
  /** Select initial lines, final lines, or a balanced initial/final preview. */
  strategy?: 'head' | 'tail' | 'head-tail';
  /**
   * Continue a line wider than `maxLineWidth` on the rows after it instead of cutting it, so no
   * line is shortened. `maxLines` then bounds the rows (a line the bound cuts into keeps its first
   * rows and counts as hidden).
   */
  wrap?: boolean;
}

export interface ToolOutputDisplay {
  lines: string[];
  totalLines: number;
  totalChars: number;
  hiddenLines: number;
  truncatedLines: number;
  truncated: boolean;
  footer?: string;
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
 * algorithm and its stops are the frame clip's own (`expandTabs` in `cli/ink-frame-clip.ts`), here
 * measured with {@link displayWidth}, so the two cannot drift. Eight-column stops, not the fixed
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
  { maxLines, maxLineWidth, hint, strategy = 'head', wrap = false }: ToolOutputDisplayOptions,
): ToolOutputDisplay {
  if (wrap) return wrappedToolOutputDisplay(output, maxLines, maxLineWidth, hint);
  const rawLines = splitOutputLines(output);
  const lineLimit = Math.max(0, Math.floor(maxLines));
  const widthLimit = Math.max(0, Math.floor(maxLineWidth));
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

/**
 * `line` wrapped at display width `width` into at most `maxRows` rows (it stops once it has them,
 * so a huge line costs only the rows kept). An ANSI SGR sequence stays whole and takes no width.
 */
function wrapRows(line: string, width: number, maxRows: number): string[] {
  const rows: string[] = [];
  let current = '';
  let currentWidth = 0;
  for (let i = 0; i < line.length && rows.length < maxRows;) {
    SGR.lastIndex = i;
    const sgr = SGR.exec(line);
    if (sgr) {
      current += sgr[0];
      i += sgr[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    i += ch.length;
    const chWidth = displayWidth(ch);
    if (currentWidth > 0 && currentWidth + chWidth > width) {
      rows.push(current);
      current = '';
      currentWidth = 0;
      if (rows.length >= maxRows) return rows;
    }
    current += ch;
    currentWidth += chWidth;
  }
  if (rows.length < maxRows) rows.push(current);
  return rows;
}

/**
 * The head of `output` with each line wrapped at display width `maxLineWidth`, at most `maxLines`
 * rows. Nothing is shortened: a line the row bound reaches keeps its first rows and is hidden.
 */
function wrappedToolOutputDisplay(
  output: string,
  maxLines: number,
  maxLineWidth: number,
  hint: string | undefined,
): ToolOutputDisplay {
  const rawLines = splitOutputLines(output);
  const rowLimit = Math.max(0, Math.floor(maxLines));
  const width = Math.max(1, Math.floor(maxLineWidth));
  const lines: string[] = [];
  let shownLines = 0;
  for (const rawLine of rawLines) {
    if (lines.length >= rowLimit) break;
    const room = rowLimit - lines.length;
    const rows = wrapRows(expandTabs(rawLine), width, room + 1);
    lines.push(...rows.slice(0, room));
    if (rows.length > room) break;
    shownLines++;
  }
  const hiddenLines = rawLines.length - shownLines;
  const footer =
    hiddenLines > 0 ? formatToolOutputFooter({ hiddenLines, truncatedLines: 0, hint }) : undefined;
  return {
    lines,
    totalLines: rawLines.length,
    totalChars: output.length,
    hiddenLines,
    truncatedLines: 0,
    truncated: hiddenLines > 0,
    footer,
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
