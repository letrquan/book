import { homedir } from 'os';
import { resolve, sep } from 'path';
import { resolveBookHome } from '../book-home.js';

/**
 * Prompt-wide determinism helpers. They live apart from the prompt builder so
 * both the static zones and the per-turn session-state block can apply them
 * without importing each other.
 */

const EVALUATION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const SYSTEM_PROMPT_VERSION = 'book-system-prompt-v2';

/** Return the date exposed to the model, with evaluator-controlled runs frozen. */
export function promptCurrentDate(): string {
  const configured = process.env.BOOK_EVALUATION_DATE?.trim();
  return configured && EVALUATION_DATE_PATTERN.test(configured)
    ? configured
    : new Date().toISOString().split('T')[0];
}

/**
 * How long this run has been going, coarsely, for the session-state block.
 *
 * The only temporal signal in the whole prompt is a UTC calendar date at day
 * granularity, so a model five days into a week-long objective cannot tell that
 * from turn 3: it cannot pace itself, cannot notice it has been circling the same
 * file since Tuesday, and cannot honour a time-bounded instruction in the
 * objective itself.
 *
 * Coarse on purpose. The block is stamped once per user message and memoized, so
 * exact milliseconds would add churn without adding anything a model can act on.
 * Suppressed entirely when the evaluator has frozen the date, so equivalent arms
 * still receive byte-identical prompts.
 */
export function promptElapsed(elapsedMs: number): string | undefined {
  if (process.env.BOOK_EVALUATION_DATE?.trim()) return undefined;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return undefined;
  const minutes = Math.floor(elapsedMs / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function evaluationIsolationEnabled(): boolean {
  return Boolean(process.env.BOOK_HOME?.trim() && process.env.BOOK_EVALUATION_RUN_ID?.trim());
}

/** Hide evaluator-owned temporary paths so equivalent arms receive the same prompt. */
export function normalizePromptPath(path: string, workspace: string): string {
  if (!evaluationIsolationEnabled()) return path;
  const replacements = [
    [resolve(workspace), '<evaluation-workspace>'],
    [resolveBookHome(), '<evaluation-book-home>'],
    [resolve(homedir()), '<evaluation-home>'],
  ].sort(([left], [right]) => right.length - left.length);
  for (const [root, label] of replacements) {
    if (path === root) return label;
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (path.startsWith(prefix))
      return `${label}/${path.slice(prefix.length).replaceAll(sep, '/')}`;
  }
  return path;
}
