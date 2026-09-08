/**
 * Which shell the Bash tool spawns.
 *
 * Node's `shell: true` means `/bin/sh` on POSIX and `%ComSpec%` on Windows, so
 * for a long time a tool called `Bash` ran cmd.exe on Windows: one line per
 * command, `%VAR%` quoting, no heredocs, and the shell every model writes
 * worst. Every other native-Windows coding agent resolved this the same way,
 * with PowerShell 7 first and Windows PowerShell 5.1 next; Claude Code keeps
 * Git Bash as its POSIX shell; OpenCode honours the shell Book was launched
 * from before either. This module is that ladder, resolved once per session:
 *
 *   1. `BOOK_SHELL` in the environment, then `shell` in a trusted settings
 *      layer - a kind name (`bash`, `pwsh`, `powershell`, `cmd`, `sh`) or an
 *      executable path. A request that cannot be found is reported and the
 *      automatic ladder continues, rather than failing every command.
 *   2. Git Bash, when Book was launched from one (MSYSTEM or a POSIX $SHELL is
 *      set), so the syntax the user sees in their own terminal is the syntax
 *      the model writes.
 *   3. PowerShell 7 (`pwsh`), then Windows PowerShell 5.1.
 *   4. Git Bash if it is merely installed.
 *   5. cmd.exe, which still works but is never chosen over a real shell.
 *
 * Off Windows the platform default (`/bin/sh` through `shell: true`) is kept.
 *
 * Pure: every probe (platform, environment, filesystem) is injected, so the
 * ladder is testable on any host. Nothing here is cached at module level;
 * `loadConfig` resolves once and the result rides on `AgentConfig.shell`.
 */
import { existsSync as fsExistsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { CommandExecution, ResolvedShell, ShellKind, ShellSource } from './types/runtime.js';

export interface ShellSelectionInput {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** `settings.shell`: a shell kind name or an executable path. `BOOK_SHELL` wins over it. */
  requested?: string;
  existsSync?: (path: string) => boolean;
}

const KIND_BY_NAME: Record<string, ShellKind> = {
  bash: 'bash',
  'git-bash': 'bash',
  gitbash: 'bash',
  pwsh: 'pwsh',
  powershell: 'powershell',
  cmd: 'cmd',
  'cmd.exe': 'cmd',
  sh: 'sh',
};

const LABELS: Record<ShellKind, string> = {
  bash: 'Git Bash',
  pwsh: 'PowerShell 7',
  powershell: 'Windows PowerShell 5.1',
  cmd: 'cmd.exe',
  sh: '/bin/sh',
};

interface Probe {
  which: (name: string) => string | undefined;
  exists: (path: string) => boolean;
  pwsh: () => string | undefined;
  powershell: () => string | undefined;
  gitBash: () => string | undefined;
  cmd: () => string | undefined;
}

function createProbe(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): Probe {
  const path = platform === 'win32' ? win32 : posix;
  const separator = platform === 'win32' ? ';' : ':';
  const pathDirs = (env.PATH ?? env.Path ?? '').split(separator).filter(Boolean);
  const which = (name: string): string | undefined => {
    for (const dir of pathDirs) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
    return undefined;
  };
  const first = (candidates: Array<string | undefined>): string | undefined => {
    for (const candidate of candidates) {
      if (candidate && exists(candidate)) return candidate;
    }
    return undefined;
  };
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
  const localAppData = env.LOCALAPPDATA;
  return {
    which,
    exists,
    pwsh: () =>
      first([
        which('pwsh.exe'),
        path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
        localAppData ? path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe') : undefined,
      ]),
    // Windows PowerShell lives one directory below System32, where the
    // `system32Executable` helper does not look, so the path is built here.
    powershell: () =>
      first([
        path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        which('powershell.exe'),
      ]),
    gitBash: () => {
      const git = which('git.exe');
      return first([
        // Git Bash exports EXEPATH as the Git for Windows root.
        env.EXEPATH ? path.join(env.EXEPATH, 'bin', 'bash.exe') : undefined,
        // `Git\cmd\git.exe`, `Git\bin\git.exe`, and `Git\mingw64\bin\git.exe`
        // all sit two levels below the root that holds `bin\bash.exe`.
        git ? path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe') : undefined,
        path.join(programFiles, 'Git', 'bin', 'bash.exe'),
        path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
        localAppData ? path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe') : undefined,
      ]);
    },
    // ComSpec is what Node's `shell: true` spawns verbatim, so it is reported
    // as-is; the System32 path is only a guess for a display name.
    cmd: () =>
      env.ComSpec ||
      env.COMSPEC ||
      first([path.join(systemRoot, 'System32', 'cmd.exe')]) ||
      'cmd.exe',
  };
}

function shell(
  kind: ShellKind,
  source: ShellSource,
  file?: string,
  warning?: string,
): ResolvedShell {
  const resolved: ResolvedShell = { kind, label: LABELS[kind], source };
  if (file) resolved.file = file;
  if (warning) resolved.warning = warning;
  return resolved;
}

function kindFromExecutable(file: string, platform: NodeJS.Platform): ShellKind {
  const path = platform === 'win32' ? win32 : posix;
  const name = path
    .basename(file)
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (name === 'pwsh') return 'pwsh';
  if (name === 'powershell') return 'powershell';
  if (name === 'cmd') return 'cmd';
  if (name.includes('bash')) return 'bash';
  return 'sh';
}

function resolveRequested(
  requested: string,
  platform: NodeJS.Platform,
  probe: Probe,
): ResolvedShell | undefined {
  const byName = KIND_BY_NAME[requested.toLowerCase()];
  if (byName) {
    switch (byName) {
      case 'bash': {
        const file = platform === 'win32' ? probe.gitBash() : probe.which('bash');
        return file ? shell('bash', 'setting', file) : undefined;
      }
      case 'pwsh': {
        const file = probe.pwsh() ?? (platform === 'win32' ? undefined : probe.which('pwsh'));
        return file ? shell('pwsh', 'setting', file) : undefined;
      }
      case 'powershell': {
        const file = probe.powershell();
        return file ? shell('powershell', 'setting', file) : undefined;
      }
      case 'cmd':
        return platform === 'win32' ? shell('cmd', 'setting', probe.cmd()) : undefined;
      case 'sh': {
        if (platform === 'win32') return undefined;
        return shell('sh', 'setting', probe.which('sh') ?? '/bin/sh');
      }
    }
  }
  if (probe.exists(requested)) {
    return shell(kindFromExecutable(requested, platform), 'setting', requested);
  }
  return undefined;
}

function launchedFromPosixShell(env: NodeJS.ProcessEnv): boolean {
  if (env.MSYSTEM) return true;
  const launcher = env.SHELL ?? '';
  return /(^|[\\/])(ba|z|da)?sh(\.exe)?$/i.test(launcher);
}

function resolveWindows(env: NodeJS.ProcessEnv, probe: Probe): ResolvedShell {
  if (launchedFromPosixShell(env)) {
    const bash = probe.gitBash();
    if (bash) return shell('bash', 'launching-shell', bash);
  }
  const pwsh = probe.pwsh();
  if (pwsh) return shell('pwsh', 'detected', pwsh);
  const powershell = probe.powershell();
  if (powershell) return shell('powershell', 'detected', powershell);
  const bash = probe.gitBash();
  if (bash) return shell('bash', 'detected', bash);
  return shell('cmd', 'fallback', probe.cmd());
}

/** Resolve the shell the Bash tool should spawn. See the module comment for the ladder. */
export function resolveShell(input: ShellSelectionInput = {}): ResolvedShell {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const probe = createProbe(platform, env, input.existsSync ?? fsExistsSync);
  const requested = (env.BOOK_SHELL || input.requested || '').trim();

  let warning: string | undefined;
  if (requested) {
    const chosen = resolveRequested(requested, platform, probe);
    if (chosen) return chosen;
    warning = `Requested shell "${requested}" was not found; Book chose one automatically instead.`;
  }
  // POSIX keeps Node's default: `/bin/sh` through `shell: true`, exactly as before.
  const automatic = platform === 'win32' ? resolveWindows(env, probe) : shell('sh', 'detected');
  return warning ? { ...automatic, warning } : automatic;
}

/**
 * Silences progress records (which a redirected stderr would otherwise carry
 * as CLIXML) and sets UTF-8 on both pipes so non-ASCII output survives.
 */
const POWERSHELL_PRELUDE =
  "$ProgressPreference = 'SilentlyContinue'; " +
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  '$OutputEncoding = [System.Text.Encoding]::UTF8\n';

/**
 * Mirrors bash: the process exits with the last statement's status, using the
 * native command's code when there is one. `$?` refers to the statement
 * before the `if`, i.e. the last line of the user's command.
 */
const POWERSHELL_EPILOGUE =
  '\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }';

/**
 * Windows PowerShell 5.1 serializes anything it writes to a redirected stderr
 * as CLIXML, so a plain `Get-Item missing` hands the model an XML document
 * instead of "Cannot find path". Merging the error stream is not enough on
 * its own: an ErrorRecord that reaches the end of the pipeline is still
 * rendered to the host's error stream. Each record is turned into its message
 * text inside the pipeline instead, and the failure is recorded in a flag
 * because `$?` after the `ForEach-Object` describes the pipeline, not the
 * user's last statement. Verified on this exact script: text errors on
 * stdout, exit codes 0/1/3/7 preserved, table formatting intact.
 */
function wrapForWindowsPowerShell(command: string): string {
  return (
    POWERSHELL_PRELUDE +
    '$global:__bookErr = $false\n' +
    '& {\n' +
    command +
    '\nif (-not $?) { $global:__bookErr = $true }\n' +
    '} 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { "$_" } else { $_ } }\n' +
    'if ($global:__bookErr) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }'
  );
}

/**
 * Base64 of UTF-16LE, the encoding `-EncodedCommand` reads. Chosen over
 * `-Command` because Windows PowerShell 5.1 re-parses a `-Command` argument
 * and silently strips embedded double quotes from it; the encoded form is
 * delivered byte for byte. The cost is roughly 2.7x the command length on the
 * command line, which stays inside CreateProcess's 32k limit for anything a
 * model writes as a single tool call.
 */
export function encodePowerShellCommand(
  command: string,
  kind: 'pwsh' | 'powershell' = 'pwsh',
): string {
  const script =
    kind === 'powershell'
      ? wrapForWindowsPowerShell(command)
      : POWERSHELL_PRELUDE + command + POWERSHELL_EPILOGUE;
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Decode what `encodePowerShellCommand` produced, for tests and diagnostics. */
export function decodePowerShellCommand(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

/**
 * The argv that runs `command` under `shell`, or undefined when the command
 * should go to Node's `shell: true` (cmd.exe and the POSIX default).
 */
export function shellExecution(
  resolved: ResolvedShell,
  command: string,
): CommandExecution | undefined {
  switch (resolved.kind) {
    case 'bash':
    case 'sh':
      return resolved.file ? { file: resolved.file, args: ['-c', command] } : undefined;
    case 'pwsh':
    case 'powershell':
      return resolved.file
        ? {
            file: resolved.file,
            args: [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              encodePowerShellCommand(command, resolved.kind),
            ],
          }
        : undefined;
    case 'cmd':
      // cmd.exe quoting cannot be reproduced from an argv; Node's `shell: true`
      // builds the `/d /s /c "..."` line itself.
      return undefined;
  }
}

/** `label (file)` for doctor and the system prompt. */
export function describeShell(resolved: ResolvedShell): string {
  return resolved.file ? `${resolved.label} (${resolved.file})` : resolved.label;
}

/**
 * The Harness bullet that tells the model which syntax to write. The shell is
 * fixed for the session, so this belongs in the cached prompt prefix.
 */
export function shellPromptLine(resolved: ResolvedShell): string {
  const where = resolved.file ? ` at \`${resolved.file}\`` : '';
  switch (resolved.kind) {
    case 'bash':
      return (
        `- The Bash tool runs Git Bash (POSIX sh)${where}, not cmd.exe or PowerShell. Use Unix shell ` +
        'syntax: `/dev/null` not `NUL`, forward slashes, `$VAR` not `%VAR%` or `$env:VAR`. Windows ' +
        'drive paths such as `C:/dir` and MSYS paths such as `/c/dir` both work. The bash sandbox ' +
        'requires bubblewrap and is unavailable on Windows.'
      );
    case 'pwsh':
      return (
        `- The Bash tool runs PowerShell 7 (pwsh)${where}, not bash or cmd.exe. Use PowerShell ` +
        'syntax: `&&` and `||` work, `;` sequences commands, `$env:VAR` reads a variable, and ' +
        '`Get-ChildItem`, `Select-String`, `Get-Content` replace `ls`, `grep`, `cat` unless those ' +
        'tools are on PATH. There are no heredocs: use a single-quoted here-string with the closing ' +
        "`'@` at column 0. The bash sandbox is unavailable on Windows."
      );
    case 'powershell':
      return (
        `- The Bash tool runs Windows PowerShell 5.1${where}, not bash or cmd.exe. ` +
        '`&&` and `||` are NOT available: use `;` to sequence, or `cmd1; if ($?) { cmd2 }`. Avoid ' +
        'PowerShell 7-only syntax (`??`, `?.`). `$env:VAR` reads a variable; `Get-ChildItem`, ' +
        '`Select-String`, `Get-Content` replace `ls`, `grep`, `cat` unless those tools are on PATH. ' +
        "There are no heredocs: use a single-quoted here-string with the closing `'@` at column 0. " +
        'The bash sandbox is unavailable on Windows.'
      );
    case 'cmd':
      return (
        '- The Bash tool runs cmd.exe because no PowerShell or Git Bash was found (set `shell` in ' +
        '`~/.book/settings.json` or `BOOK_SHELL` to change this). Each command must be a single ' +
        'line; chain with `&` or `&&`; `%VAR%` reads a variable; `dir`, `findstr`, `type` replace ' +
        '`ls`, `grep`, `cat`; quoting follows cmd.exe rules, not POSIX. The bash sandbox is ' +
        'unavailable on Windows.'
      );
    case 'sh':
      return (
        `- The Bash tool runs commands through the platform's default shell, \`/bin/sh\`${where}. ` +
        'The bash sandbox requires bubblewrap.'
      );
  }
}
