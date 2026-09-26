/** Finish reasons that mean a reply stopped at its output limit (OpenAI and Anthropic spellings). */
export const TRUNCATION_FINISH_REASONS: ReadonlySet<string> = new Set(['length', 'max_tokens']);
