import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, win32 } from 'node:path';
import { resolveShell } from '../shell-selection.js';
import type { ResolvedShell } from '../types/runtime.js';

/**
 * The executable `name` on PATH off Windows, for tests that need a real shell; undefined on win32 or
 * when there is none.
 */
export function posixExecutable(name: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** `bash` on PATH off Windows, for tests that need a real bash (see {@link posixExecutable}). */
export const posixBash: string | undefined = posixExecutable('bash');

/**
 * Git Bash on Windows, resolved the way a `bash` shell request is; undefined off Windows or when Git
 * Bash is not installed. Its `msys` flag comes from the real `msys-2.0.dll` probe (#548).
 */
export const windowsGitBash: ResolvedShell | undefined = (() => {
  if (process.platform !== 'win32') return undefined;
  const resolved = resolveShell({ platform: 'win32', requested: 'bash' });
  return resolved.kind === 'bash' && resolved.file ? resolved : undefined;
})();

/**
 * The shell at `segments` under the Git for Windows root (derived from {@link windowsGitBash}'s
 * `<root>\bin\bash.exe`), resolved as a `shell` path setting is, so the MSYS detection runs for real
 * (#532, #548); undefined off Windows, when that file is absent, or when it resolves to another kind.
 */
function gitForWindowsShell(kind: 'bash' | 'sh', ...segments: string[]): ResolvedShell | undefined {
  if (!windowsGitBash?.file) return undefined;
  const root = win32.dirname(win32.dirname(windowsGitBash.file));
  const file = win32.join(root, ...segments);
  if (!existsSync(file)) return undefined;
  const resolved = resolveShell({ platform: 'win32', env: {}, requested: file });
  return resolved.kind === kind && resolved.file === file ? resolved : undefined;
}

/** Git for Windows' `<root>\usr\bin\sh.exe`, which has `msys-2.0.dll` beside it. */
export const windowsMsysSh: ResolvedShell | undefined = gitForWindowsShell(
  'sh',
  'usr',
  'bin',
  'sh.exe',
);

/**
 * Git for Windows' `<root>\bin\sh.exe`, a launcher stub with no MSYS DLL of its own that runs
 * `<root>\usr\bin\sh.exe` with its environment and raw command line, so it is detected through
 * `..\usr\bin\msys-2.0.dll`.
 */
export const windowsGitBinSh: ResolvedShell | undefined = gitForWindowsShell('sh', 'bin', 'sh.exe');

/** Git for Windows' `<root>\usr\bin\bash.exe`, which has `msys-2.0.dll` beside it (#548). */
export const windowsMsysBash: ResolvedShell | undefined = gitForWindowsShell(
  'bash',
  'usr',
  'bin',
  'bash.exe',
);

/** What {@link WindowsPosixShell.setup} hands a test: the shell and how to spawn it. */
export interface WindowsPosixShellSetup {
  /** Resolved from its path the way a `shell` setting is, so the MSYS detection runs for real. */
  shell: ResolvedShell;
  /** Variables the shell needs to start, for the tool context and any direct spawn alike. */
  env: Record<string, string>;
  /** A directory the setup created (a copy of the shell lives there), for the caller to remove. */
  tempDir?: string;
}

/** A real POSIX shell on a Windows machine, for the end-to-end delivery tests (#532, #548). */
export interface WindowsPosixShell {
  label: string;
  /** The kind resolution must give it: `bash` for a `bash.exe`, `sh` for every other name. */
  kind: 'bash' | 'sh';
  /** Whether resolution must find the shell on the MSYS runtime (`ResolvedShell.msys`). */
  msys: boolean;
  /**
   * Prepares the shell (copying it first when the entry is a copy); undefined when its source is
   * absent here, and always off Windows. Nothing is downloaded.
   */
  setup: (() => WindowsPosixShellSetup) | undefined;
}

/**
 * `dir` prepended to the inherited search path, under the key the environment already uses for it
 * (on Windows usually `Path`), so a child environment built over `process.env` never holds two
 * spellings of it.
 */
function withSearchPathFirst(dir: string): Record<string, string> {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'Path';
  const rest = process.env[key];
  return { [key]: rest ? `${dir}${win32.delimiter}${rest}` : dir };
}

/** The first of `candidates` that exists, or undefined. */
function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

/** `name` on the Windows search path, or undefined. */
function onWindowsPath(name: string): string | undefined {
  const key = Object.keys(process.env).find((entry) => entry.toUpperCase() === 'PATH');
  const dirs = (key ? (process.env[key] ?? '') : '').split(win32.delimiter).filter(Boolean);
  return firstExisting(dirs.map((dir) => win32.join(dir, name)));
}

/** `source` copied as `name` into a fresh temporary directory, resolved as a `shell` setting. */
function copiedAs(
  source: string,
  name: 'sh.exe' | 'bash.exe',
  env: Record<string, string>,
): WindowsPosixShellSetup {
  const tempDir = mkdtempSync(join(tmpdir(), 'book-sh-copy-'));
  const copy = win32.join(tempDir, name);
  copyFileSync(source, copy);
  return { shell: resolveShell({ platform: 'win32', env: {}, requested: copy }), env, tempDir };
}

/** `file` resolved as a `shell` setting, with its own directory first on the search path. */
function inPlace(file: string): WindowsPosixShellSetup {
  return {
    shell: resolveShell({ platform: 'win32', env: {}, requested: file }),
    env: withSearchPathFirst(win32.dirname(file)),
  };
}

/**
 * Every POSIX shell the Windows CI runner can offer, each with the delivery facts a test checks:
 * Git for Windows' two `sh.exe` and its `usr\bin\bash.exe` (MSYS, flagged); copies of Git's
 * `usr\bin\sh.exe` and `usr\bin\bash.exe` in a directory with no MSYS DLL, which stand for a shim,
 * hardlink or copy (not flagged, and started with Git's `usr\bin` first on their search path so
 * their DLLs load); MSYS2's `dash.exe` (flagged); Cygwin's `sh.exe` and `bash.exe` (not flagged);
 * and busybox-w32 copied as `sh.exe` (not flagged). Git's `bin\bash.exe` is {@link windowsGitBash}.
 * The ones that are not installed have no `setup`. Built on call, so importing this module copies
 * nothing.
 */
export function windowsPosixShells(): WindowsPosixShell[] {
  const onWindows = process.platform === 'win32';
  const gitSh = onWindows ? windowsMsysSh?.file : undefined;
  const gitBash = onWindows ? windowsMsysBash?.file : undefined;
  const msys2Dash = onWindows ? firstExisting(['C:\\msys64\\usr\\bin\\dash.exe']) : undefined;
  const cygwinSh = onWindows
    ? firstExisting(['C:\\cygwin64\\bin\\sh.exe', 'C:\\cygwin\\bin\\sh.exe'])
    : undefined;
  const cygwinBash = onWindows
    ? firstExisting(['C:\\cygwin64\\bin\\bash.exe', 'C:\\cygwin\\bin\\bash.exe'])
    : undefined;
  const busybox = onWindows
    ? (onWindowsPath('busybox.exe') ?? onWindowsPath('busybox64.exe'))
    : undefined;
  return [
    {
      label: "Git's usr\\bin\\sh.exe",
      kind: 'sh',
      msys: true,
      setup: windowsMsysSh ? () => ({ shell: windowsMsysSh, env: {} }) : undefined,
    },
    {
      label: "Git's bin\\sh.exe launcher stub",
      kind: 'sh',
      msys: true,
      setup: windowsGitBinSh ? () => ({ shell: windowsGitBinSh, env: {} }) : undefined,
    },
    {
      label: "a copy of Git's usr\\bin\\sh.exe with no DLL beside it",
      kind: 'sh',
      msys: false,
      setup: gitSh
        ? () => copiedAs(gitSh, 'sh.exe', withSearchPathFirst(win32.dirname(gitSh)))
        : undefined,
    },
    {
      label: "Git's usr\\bin\\bash.exe",
      kind: 'bash',
      msys: true,
      setup: windowsMsysBash ? () => ({ shell: windowsMsysBash, env: {} }) : undefined,
    },
    {
      label: "a copy of Git's usr\\bin\\bash.exe with no DLL beside it",
      kind: 'bash',
      msys: false,
      setup: gitBash
        ? () => copiedAs(gitBash, 'bash.exe', withSearchPathFirst(win32.dirname(gitBash)))
        : undefined,
    },
    {
      label: "MSYS2's usr\\bin\\dash.exe",
      kind: 'sh',
      msys: true,
      setup: msys2Dash ? () => inPlace(msys2Dash) : undefined,
    },
    {
      label: 'Cygwin sh.exe',
      kind: 'sh',
      msys: false,
      setup: cygwinSh ? () => inPlace(cygwinSh) : undefined,
    },
    {
      label: 'Cygwin bash.exe',
      kind: 'bash',
      msys: false,
      setup: cygwinBash ? () => inPlace(cygwinBash) : undefined,
    },
    {
      label: 'busybox-w32 copied as sh.exe',
      kind: 'sh',
      msys: false,
      setup: busybox ? () => copiedAs(busybox, 'sh.exe', {}) : undefined,
    },
  ];
}
