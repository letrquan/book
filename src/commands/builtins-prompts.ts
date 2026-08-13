/**
 * Prompt builders for action-style built-in slash commands.
 *
 * `/review` is host-orchestrated (see `src/review/`) and builds its prompts from
 * a resolved review target, so it has no prompt or tool allowlist here.
 * `/security-review` still runs as an ordinary agent prompt.
 */

export { buildSecurityReviewPrompt } from '../review/prompts.js';

/** Tools an agent may use during a /security-review (read-only + git). */
export const SECURITY_REVIEW_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'GitStatus',
  'GitDiff',
  'WebSearch',
] as const;
