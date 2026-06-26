import type { Message, Usage } from '../types.js';

/** Decide whether the context window is approaching its limit and needs compaction. */
export function shouldCompact(
  usage: Usage | null,
  maxTokens: number,
  threshold = 0.8,
): boolean {
  if (!usage) return false;
  return usage.totalTokens >= maxTokens * threshold;
}

/**
 * Split history into the recent turns to keep verbatim and the older turns
 * to summarize. `keepLast` is a count of trailing messages to preserve.
 */
export function compactHistory(
  history: Message[],
  keepLast: number,
): { kept: Message[]; summarized: Message[] } {
  if (history.length <= keepLast) {
    return { kept: history, summarized: [] };
  }
  const summarized = history.slice(0, history.length - keepLast);
  const kept = history.slice(history.length - keepLast);
  return { kept, summarized };
}

/** Build the summarization prompt sent to the model to compress older turns. */
export function buildCompactPrompt(summarized: Message[]): string {
  const transcript = summarized
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');
  return `Summarize the following conversation so far in a compact form, preserving key decisions, file paths, code changes, and unresolved questions. Output a concise prose summary:\n\n${transcript}`;
}
