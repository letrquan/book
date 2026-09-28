/** Finish reasons that mean a reply stopped at its output limit (OpenAI and Anthropic spellings). */
export const TRUNCATION_FINISH_REASONS: ReadonlySet<string> = new Set(['length', 'max_tokens']);

/** Whether this one finish reason means the reply stopped at its output limit. */
export function isTruncationFinishReason(reason: string | undefined): boolean {
  return reason !== undefined && TRUNCATION_FINISH_REASONS.has(reason);
}

/**
 * Whether a response reported any finish reason that means it stopped at its output limit.
 *
 * The agent loop, compaction and memory extraction all need this same reading of a
 * truncated reply, and a copy of the predicate at each site is a set that drifts: one
 * of them ends up believing a spelling the others do not. Providers disagree about
 * that spelling, so the set above is the only place that knows both.
 */
export function isTruncationFinish(finishReasons: readonly string[] | undefined): boolean {
  return finishReasons?.some((reason) => isTruncationFinishReason(reason)) === true;
}
