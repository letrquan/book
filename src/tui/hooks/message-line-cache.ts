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

/** Maximum cache entries before evicting oldest. Prevents unbounded growth. */
const MAX_CACHE_SIZE = 500;

const cache = new Map<string, CachedEntry>();

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
 * Reset the entire line-height cache.
 *
 * Called on /clear and /compact so stale estimates are not reused for
 * new or summarized messages.
 */
export function clearLineCache(): void {
  cache.clear();
}
