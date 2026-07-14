import { displayWidth, truncateDisplay } from './word-wrap.js';

export interface ToolOutputDisplayOptions {
  maxLines: number;
  maxLineWidth: number;
  /** Optional hint appended to the footer when output is hidden. */
  hint?: string;
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

export function formatByteSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  const kib = chars / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

/**
 * Prepare tool output for terminal display without mutating the underlying result.
 * Counts the original output, then returns a bounded, display-width-aware preview.
 */
export function prepareToolOutputDisplay(
  output: string,
  { maxLines, maxLineWidth, hint }: ToolOutputDisplayOptions,
): ToolOutputDisplay {
  const rawLines = output.length === 0 ? [] : output.split('\n');
  const lineLimit = Math.max(0, Math.floor(maxLines));
  const widthLimit = Math.max(0, Math.floor(maxLineWidth));
  const visibleRawLines = lineLimit > 0 ? rawLines.slice(0, lineLimit) : [];
  let truncatedLines = 0;
  const lines = visibleRawLines.map((line) => {
    const next = truncateDisplay(line, widthLimit);
    if (displayWidth(next) < displayWidth(line) || next !== line) truncatedLines++;
    return next;
  });
  const hiddenLines = Math.max(0, rawLines.length - visibleRawLines.length);
  const truncated = hiddenLines > 0 || truncatedLines > 0;
  const footer = truncated
    ? formatToolOutputFooter({
        totalLines: rawLines.length,
        totalChars: output.length,
        hiddenLines,
        truncatedLines,
        hint,
      })
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

function formatToolOutputFooter({
  totalLines,
  totalChars,
  hiddenLines,
  truncatedLines,
  hint,
}: {
  totalLines: number;
  totalChars: number;
  hiddenLines: number;
  truncatedLines: number;
  hint?: string;
}): string {
  const parts: string[] = [];
  if (hiddenLines > 0)
    parts.push(`${hiddenLines} more ${hiddenLines === 1 ? 'line' : 'lines'} hidden`);
  if (truncatedLines > 0)
    parts.push(`${truncatedLines} long ${truncatedLines === 1 ? 'line' : 'lines'} shortened`);
  const summary = `${totalLines} ${totalLines === 1 ? 'line' : 'lines'}, ${formatByteSize(totalChars)} total`;
  return `… ${parts.join(', ')} (${summary}${hint ? `; ${hint}` : ''})`;
}
