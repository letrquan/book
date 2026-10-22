import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { reachesUncPath } from '../unc-path.js';

/**
 * Load .gitignore patterns from the workspace root and return
 * the raw glob patterns (for a glob walk's `ignore` option).
 *
 * If no .gitignore exists or loading fails, returns an empty pattern set. So it does, on Windows,
 * for a `.gitignore` that is, or reaches through a link, a UNC location (`reachesUncPath`), which
 * is not opened.
 */
export function loadGitignore(workspaceRoot: string): {
  patterns: string[];
} {
  const patterns: string[] = [];
  const giPath = join(workspaceRoot, '.gitignore');
  if (reachesUncPath(giPath)) return { patterns };
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
