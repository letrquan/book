import { existsSync } from 'node:fs';
import { delimiter, join, win32 } from 'node:path';
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

/**
 * The sh at `segments` under the Git for Windows root (derived from {@link windowsGitBash}'s
 * `<root>\bin\bash.exe`), resolved as a `shell` path setting is, so the MSYS detection runs for real
 * (#532); undefined off Windows or when that file is absent.
 */
function gitForWindowsSh(...segments: string[]): ResolvedShell | undefined {
  if (!windowsGitBash?.file) return undefined;
  const root = win32.dirname(win32.dirname(windowsGitBash.file));
  const sh = win32.join(root, ...segments);
  if (!existsSync(sh)) return undefined;
  const resolved = resolveShell({ platform: 'win32', env: {}, requested: sh });
  return resolved.kind === 'sh' && resolved.file === sh ? resolved : undefined;
}

/** Git for Windows' `<root>\usr\bin\sh.exe`, which has `msys-2.0.dll` beside it. */
export const windowsMsysSh: ResolvedShell | undefined = gitForWindowsSh('usr', 'bin', 'sh.exe');

/**
 * Git for Windows' `<root>\bin\sh.exe`, a launcher stub with no MSYS DLL of its own that runs
 * `<root>\usr\bin\sh.exe` with its environment and raw command line, so it is detected through
 * `..\usr\bin\msys-2.0.dll`.
 */
export const windowsGitBinSh: ResolvedShell | undefined = gitForWindowsSh('bin', 'sh.exe');
