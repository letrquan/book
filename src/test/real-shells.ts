import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { resolveShell } from '../shell-selection.js';
import type { ResolvedShell } from '../types/runtime.js';

/**
 * `bash` on PATH off Windows, for tests that need a real bash; undefined on win32 or when there is
 * none.
 */
export const posixBash: string | undefined = (() => {
  if (process.platform === 'win32') return undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, 'bash');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
})();

/**
 * Git Bash on Windows, resolved the way a `bash` shell request is; undefined off Windows or when Git
 * Bash is not installed.
 */
export const windowsGitBash: ResolvedShell | undefined = (() => {
  if (process.platform !== 'win32') return undefined;
  const resolved = resolveShell({ platform: 'win32', requested: 'bash' });
  return resolved.kind === 'bash' && resolved.file ? resolved : undefined;
})();
