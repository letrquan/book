import { displayWidth, truncateDisplay } from './word-wrap.js';

export interface ToolOutputDisplayOptions {
  maxLines: number;
  maxLineWidth: number;
  /** Optional hint appended to the footer when output is hidden. */
  hint?: string;
  /** Select initial lines, final lines, or a balanced initial/final preview. */
  strategy?: 'head' | 'tail' | 'head-tail';
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
 * The lines {@link prepareToolOutputDisplay} makes of `output`: none for an empty output, otherwise
 * one for each piece between newlines, so a final newline ends in an empty line of its own. Only a
 * newline splits: the `\r` of a CRLF stays at the end of its line. {@link countOutputLines} counts
 * these lines without making them.
 */
function splitOutputLines(output: string): string[] {
  return output.length === 0 ? [] : output.split('\n');
}

/**
 * How many lines {@link prepareToolOutputDisplay} makes of `output` (its `totalLines`), found by
 * scanning for newlines: a large output costs one pass and no allocation per line. The empty line
 * after a final newline is one of them; {@link countDrawnOutputLines} leaves it out, as the block
 * draws no row for it.
 */
export function countOutputLines(output: string): number {
  if (output.length === 0) return 0;
  let lines = 1;
  for (let at = output.indexOf('\n'); at !== -1; at = output.indexOf('\n', at + 1)) lines++;
  return lines;
}

/**
 * How many rows OutputBlock draws for `output` once it shows every line: one for each line the
 * output makes, an empty one included (the blank line between two paragraphs is a row), except the
 * empty line after a final newline. That one is no line of the output but what its last newline
 * leaves behind, so real output (`"X\n"`) is one row, as {@link prepareToolOutputDisplay} shows it.
 * A newline alone splits, as in the block: the `\r` of a CRLF stays on its line, so `"X\r\n"` is
 * one row.
 *
 * Found by scanning for newlines and making no line, so a large output costs one pass and no
 * allocation per line. A line of nothing but the escape sequences Ink strips (cursor movement,
 * erasing) draws no row either, but telling it from text takes the sequences parsed: it is counted.
 */
export function countDrawnOutputLines(output: string): number {
  return countOutputLines(output) - (output.endsWith('\n') ? 1 : 0);
}

/**
 * Prepare tool output for terminal display without mutating the underlying result.
 * Counts the original output, then returns a bounded, display-width-aware preview. `lines` are the
 * rows to draw, each one a row even when empty.
 */
export function prepareToolOutputDisplay(
  output: string,
  { maxLines, maxLineWidth, hint, strategy = 'head' }: ToolOutputDisplayOptions,
): ToolOutputDisplay {
  const splitLines = splitOutputLines(output);
  // The empty line a final newline leaves is no line of the output: nothing is drawn for it, so it
  // is neither shown nor counted as hidden. `totalLines` still counts it, as `countOutputLines` does.
  const rawLines = output.endsWith('\n') ? splitLines.slice(0, -1) : splitLines;
  const lineLimit = Math.max(0, Math.floor(maxLines));
  const widthLimit = Math.max(0, Math.floor(maxLineWidth));
  const visibleIndices = selectVisibleLineIndices(rawLines.length, lineLimit, strategy);
  const visibleRawLines = visibleIndices.map((index) => rawLines[index] ?? '');
  let truncatedLines = 0;
  const lines = visibleRawLines.map((line) => {
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
    totalLines: splitLines.length,
    totalChars: output.length,
    hiddenLines,
    truncatedLines,
    truncated,
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
