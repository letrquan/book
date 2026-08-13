/**
 * Prompt builders for action-style built-in slash commands.
 *
 * Review prompts now live in `src/review/prompts.ts`; this module preserves the
 * historical import surface so existing callers and tests keep working.
 */

export { buildReviewPrompt, buildSecurityReviewPrompt } from '../review/prompts.js';

/** Tools an agent may use during a /review (read-only + git). */
export const REVIEW_TOOLS = ['Read', 'Glob', 'Grep', 'GitStatus', 'GitDiff'] as const;

/** Tools an agent may use during a /security-review (read-only + git). */
export const SECURITY_REVIEW_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'GitStatus',
  'GitDiff',
  'WebSearch',
] as const;
