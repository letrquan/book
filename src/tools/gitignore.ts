import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import ignore from 'ignore';

/**
 * Load .gitignore patterns from the workspace root and return:
 *  - `patterns`: the raw glob patterns (for fast-glob's `ignore` option)
 *  - `filter`: an ignore() instance that tests full relative paths (for Read edge cases)
 *
 * If no .gitignore exists or loading fails, returns an empty pattern set.
 */
export function loadGitignore(workspaceRoot: string): {
  patterns: string[];
} {
  const patterns: string[] = [];
  const giPath = join(workspaceRoot, '.gitignore');
  try {
    if (existsSync(giPath)) {
      const raw = readFileSync(giPath, 'utf-8');
      // fast-glob's `ignore` accepts plain glob strings; pass non-comment, non-empty lines.
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        patterns.push(trimmed);
      }
    }
  } catch {
    // non-fatal
  }
  return { patterns };
}

/** Build an ignore() filter for path testing (used by tools that need per-file checks). */
export function buildIgnoreFilter(patterns: string[]) {
  const ig = ignore();
  for (const p of patterns) ig.add(p);
  return ig;
}
