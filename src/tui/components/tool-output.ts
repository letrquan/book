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
  totalBytes: number;
  hiddenLines: number;
  hiddenBytes: number;
  truncatedLines: number;
  truncated: boolean;
  footer?: string;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
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
  { maxLines, maxLineWidth, hint, strategy = 'head' }: ToolOutputDisplayOptions,
): ToolOutputDisplay {
  const rawLines = output.length === 0 ? [] : output.split('\n');
  const lineLimit = Math.max(0, Math.floor(maxLines));
  const widthLimit = Math.max(0, Math.floor(maxLineWidth));
  const visibleIndices = selectVisibleLineIndices(rawLines.length, lineLimit, strategy);
  const visibleRawLines = visibleIndices.map((index) => rawLines[index] ?? '');
  const visibleIndexSet = new Set(visibleIndices);
  const lineByteSizes = rawLines.map((line, index) =>
    Buffer.byteLength(`${line}${index < rawLines.length - 1 ? '\n' : ''}`, 'utf8'),
  );
  const totalBytes = lineByteSizes.reduce((total, bytes) => total + bytes, 0);
  const visibleBytes = lineByteSizes.reduce(
    (total, bytes, index) => total + (visibleIndexSet.has(index) ? bytes : 0),
    0,
  );
  let truncatedLines = 0;
  const lines = visibleRawLines.map((line) => {
    const next = truncateDisplay(line, widthLimit);
    if (displayWidth(next) < displayWidth(line) || next !== line) truncatedLines++;
    return next;
  });
  const hiddenLines = Math.max(0, rawLines.length - visibleRawLines.length);
  const hiddenBytes = Math.max(0, totalBytes - visibleBytes);
  const truncated = hiddenLines > 0 || truncatedLines > 0;
  const footer = truncated
    ? formatToolOutputFooter({
        totalLines: rawLines.length,
        totalBytes,
        hiddenLines,
        hiddenBytes,
        truncatedLines,
        hint,
      })
    : undefined;

  return {
    lines,
    totalLines: rawLines.length,
    totalChars: output.length,
    totalBytes,
    hiddenLines,
    hiddenBytes,
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

function formatToolOutputFooter({
  totalLines,
  totalBytes,
  hiddenLines,
  hiddenBytes,
  truncatedLines,
  hint,
}: {
  totalLines: number;
  totalBytes: number;
  hiddenLines: number;
  hiddenBytes: number;
  truncatedLines: number;
  hint?: string;
}): string {
  const parts: string[] = [];
  if (hiddenLines > 0)
    parts.push(
      `${hiddenLines} more ${hiddenLines === 1 ? 'line' : 'lines'} hidden, ${hiddenBytes} B`,
    );
  if (truncatedLines > 0)
    parts.push(`${truncatedLines} long ${truncatedLines === 1 ? 'line' : 'lines'} shortened`);
  const summary = `${totalLines} ${totalLines === 1 ? 'line' : 'lines'}, ${formatByteSize(totalBytes)} total`;
  return `… ${parts.join(', ')} (${summary}${hint ? `; ${hint}` : ''})`;
}
