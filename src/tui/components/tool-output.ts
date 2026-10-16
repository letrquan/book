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
 * Prepare tool output for terminal display without mutating the underlying result.
 * Counts the original output, then returns a bounded, display-width-aware preview.
 */
export function prepareToolOutputDisplay(
  output: string,
  { maxLines, maxLineWidth, hint, strategy = 'head' }: ToolOutputDisplayOptions,
): ToolOutputDisplay {
  const rawLines = output.length === 0 ? [] : output.split('\n');
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
    totalLines: rawLines.length,
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

/** `… +N lines, M long lines shortened (hint)`; each part appears only when it applies. */
export function formatToolOutputFooter({
  hiddenLines,
  truncatedLines,
  hint,
  of,
}: {
  hiddenLines: number;
  truncatedLines: number;
  hint?: string;
  /** What the hidden lines are lines of, when the rows above them are not: `… +1 line of output`. */
  of?: string;
}): string {
  const parts: string[] = [];
  if (hiddenLines > 0) {
    parts.push(`+${hiddenLines} ${hiddenLines === 1 ? 'line' : 'lines'}${of ? ` of ${of}` : ''}`);
  }
  if (truncatedLines > 0)
    parts.push(`${truncatedLines} long ${truncatedLines === 1 ? 'line' : 'lines'} shortened`);
  return `… ${parts.join(', ')}${hint ? ` (${hint})` : ''}`;
}
