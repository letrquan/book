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
