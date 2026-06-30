import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Load .gitignore patterns from the workspace root and return
 * the raw glob patterns (for fast-glob's `ignore` option).
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
