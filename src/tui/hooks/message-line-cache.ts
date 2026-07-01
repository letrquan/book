import type { Message } from '../../types.js';

/**
 * Cached line-height estimate for a single message.
 *
 * Stores length-based fingerprints rather than full strings to avoid O(content)
 * comparison on every cache check. Since content is append-only during streaming
 * and replaced wholesale on compaction, length comparison is sufficient to
 * detect staleness.
 */
interface CachedEntry {
  lines: number;
  contentLen: number;
  toolCallsLen: number;
  toolResultsLen: number;
  termWidth: number;
}

interface ContentRowsEntry {
  contentLen: number;
  termWidth: number;
  rowStarts: number[];
  scanIndex: number;
  column: number;
}

/** Maximum cache entries before evicting oldest. Prevents unbounded growth. */
const MAX_CACHE_SIZE = 500;

const cache = new Map<string, CachedEntry>();
const contentRowsCache = new Map<string, ContentRowsEntry>();

/**
 * Return a cached line-height estimate for `msg` at `termWidth`, or compute and
 * cache via `computeFn` when the message content or terminal width has changed.
 *
 * `computeFn` should be `estimateMessageLines` (or a compatible function).
 */
export function getCachedLineEstimate(
  msg: Message,
  termWidth: number,
  computeFn: (msg: Message, termWidth: number) => number,
): number {
  const contentLen = msg.content?.length ?? 0;
  const toolCallsLen = msg.toolCalls?.length ?? 0;
  const toolResultsLen = msg.toolResults?.length ?? 0;

  const entry = cache.get(msg.id);
  if (
    entry &&
    entry.contentLen === contentLen &&
    entry.toolCallsLen === toolCallsLen &&
    entry.toolResultsLen === toolResultsLen &&
    entry.termWidth === termWidth
  ) {
    return entry.lines;
  }

  // Evict oldest if at capacity.
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  const lines = computeFn(msg, termWidth);
  cache.set(msg.id, { lines, contentLen, toolCallsLen, toolResultsLen, termWidth });
  return lines;
}

/**
 * Return a bounded slice of message content after `rowsToSkip` wrapped rows.
 *
 * ponytail: char-wrap is enough for clipped hidden content; upgrade this to
 * word-wrap indexing if line-perfect mid-message scrolling becomes required.
 */
export function getCachedContentSlice(
  msg: Message,
  termWidth: number,
  rowsToSkip: number,
  rowsToKeep: number,
): string {
  const content = msg.content ?? '';
  if (!content || rowsToSkip <= 0) return content;

  const width = Math.max(20, termWidth);
  let entry = contentRowsCache.get(msg.id);
  if (!entry || entry.termWidth !== width || entry.contentLen > content.length) {
    if (!entry && contentRowsCache.size >= MAX_CACHE_SIZE) {
      const oldest = contentRowsCache.keys().next().value;
      if (oldest !== undefined) contentRowsCache.delete(oldest);
    }
    entry = {
      contentLen: 0,
      termWidth: width,
      rowStarts: [0],
      scanIndex: 0,
      column: 0,
    };
    contentRowsCache.set(msg.id, entry);
  }

  for (let i = entry.scanIndex; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '\n') {
      entry.rowStarts.push(i + 1);
      entry.column = 0;
      continue;
    }

    entry.column += 1;
    if (entry.column >= width) {
      entry.rowStarts.push(i + 1);
      entry.column = 0;
    }
  }

  entry.scanIndex = content.length;
  entry.contentLen = content.length;

  const start = entry.rowStarts[rowsToSkip] ?? content.length;
  const end = entry.rowStarts[rowsToSkip + rowsToKeep] ?? content.length;
  return content.slice(start, end);
}

/**
 * Reset the entire line-height cache.
 *
 * Called on /clear and /compact so stale estimates are not reused for
 * new or summarized messages.
 */
export function clearLineCache(): void {
  cache.clear();
  contentRowsCache.clear();
}
