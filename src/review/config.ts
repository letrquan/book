import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Review-only project instructions (REVIEW.md).
 *
 * The file at the workspace root is injected into every review pass as the
 * highest-priority instruction block. It is intentionally read fresh per review
 * so team calibrations are picked up without a restart.
 */

export interface ReviewConfig {
  body?: string;
  path?: string;
}

export function loadReviewConfig(workspace: string): ReviewConfig {
  const root = resolve(workspace);
  const path = join(root, 'REVIEW.md');
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return {};
    const body = readFileSync(path, 'utf-8').trim();
    return body ? { body, path } : {};
  } catch {
    return {};
  }
}

export function renderReviewConfigInstruction(config: ReviewConfig): string {
  if (!config.body) return '';
  return [
    '## Review instructions (REVIEW.md)',
    '',
    'The following project-specific review rules override the defaults and take',
    'highest priority. Use them to decide severity, skip rules, verification bars,',
    'and output shape.',
    '',
    config.body,
  ].join('\n');
}
