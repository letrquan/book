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
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
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
    const kind = kindFromExecutable(requested, platform);
    const resolved = shell(kind, 'setting', requested);
    // The only route to a win32 `sh` with a file, so the MSYS runtime is detected here, once, and
    // `shellExecution` stays pure.
    if (platform === 'win32' && kind === 'sh' && isMsysPosixShell(requested, probe)) {
      resolved.msys = true;
    }
    return resolved;
  }
  return undefined;
}

/** The MSYS runtime, which Git for Windows and MSYS2 ship beside every program built on it. */
const MSYS_RUNTIME_DLL = 'msys-2.0.dll';

/**
 * POSIX shells, by lowercased name without `.exe`. {@link GIT_BASH_EVAL_SCRIPT} is POSIX sh, so only
 * these get the out-of-band delivery: `kindFromExecutable` also calls `fish`, `nu` and any other
 * name `sh`, and MSYS2 ships `fish.exe` beside the runtime.
 */
const MSYS_POSIX_SHELL_NAMES = new Set(['sh', 'dash', 'ash', 'ksh', 'mksh', 'zsh']);

/**
 * Whether `file` is a POSIX shell running on the MSYS runtime (#532): `msys-2.0.dll` beside it, or
 * in `..\usr\bin` for Git for Windows' `<root>\bin\sh.exe`, a launcher stub with no DLL of its own
 * that hands its raw command line to `<root>\usr\bin\sh.exe`. A WSL launcher directory never
 * matches (see {@link WSL_LAUNCHER_DIRECTORY}).
 *
 * busybox-w32 is a native program whose argv libuv's quoting round-trips, so it rightly keeps argv.
 * A Cygwin `sh.exe` (`cygwin1.dll` beside it) also keeps argv, but only because #532 is scoped to
 * the MSYS runtime: Cygwin's own `build_argv` (`winsup/cygwin/dcrt0.cc`, which MSYS forked)
 * probably rebuilds argv the same way (globbing, quote stripping, `@file`), so it is a known gap,
 * not a safe case.
 */
function isMsysPosixShell(file: string, probe: Probe): boolean {
  const name = win32
    .basename(file)
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (!MSYS_POSIX_SHELL_NAMES.has(name) || WSL_LAUNCHER_DIRECTORY.test(file)) return false;
  const dir = win32.dirname(file);
  return (
    probe.exists(win32.join(dir, MSYS_RUNTIME_DLL)) ||
    probe.exists(win32.join(dir, '..', 'usr', 'bin', MSYS_RUNTIME_DLL))
  );
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
 * Directories that hold WSL's `bash.exe` launcher, which `kindFromExecutable` also calls `bash`
 * (any executable name containing "bash"): the Windows system directories, and the app execution
 * alias directory (`%LOCALAPPDATA%\Microsoft\WindowsApps`). WSL is not the MSYS runtime: it
 * rebuilds argv its own way and never sees a Windows environment variable without WSLENV, so it is
 * not Git Bash. Either slash, any case.
 */
const WSL_LAUNCHER_DIRECTORY =
  /[\\/](?:windows[\\/](?:system32|syswow64|sysnative)|microsoft[\\/]windowsapps)[\\/]/i;

/**
 * Whether `shell` is Git Bash: `kind: 'bash'` with a `file` (a `bash` without one goes to Node's
 * `shell: true`, which is cmd.exe on Windows), and the file is not WSL's launcher (see
 * {@link WSL_LAUNCHER_DIRECTORY}). The permission quote scanner asks this, and every shell it
 * answers true for is also delivered out of band ({@link receivesCommandOutOfBand}), so the scanner
 * is never laxer than delivery. The converse does not hold: an MSYS POSIX sh is delivered byte for
 * byte too, but by owner decision the scanner still refuses `'` under it (#532).
 */
export function isGitBash(shell: Pick<ResolvedShell, 'kind' | 'file'> | undefined): boolean {
  return (
    shell?.kind === 'bash' && Boolean(shell.file) && !WSL_LAUNCHER_DIRECTORY.test(shell.file ?? '')
  );
}

/**
 * Whether {@link shellExecution} hands `shell` its command out of band on Windows: Git Bash
 * ({@link isGitBash}), or a POSIX sh that resolution found on the MSYS runtime
 * (`ResolvedShell.msys`, #532). Both rebuild argv through the MSYS runtime the same way.
 */
export function receivesCommandOutOfBand(
  shell: Pick<ResolvedShell, 'kind' | 'file' | 'msys'> | undefined,
): boolean {
  return isGitBash(shell) || (shell?.kind === 'sh' && Boolean(shell.file) && shell.msys === true);
}

/** The environment variable that carries a Git Bash or MSYS sh command on Windows. */
export const GIT_BASH_COMMAND_VARIABLE = 'BOOK_BASH_COMMAND';

/**
 * The fixed `-c` script that runs the command held in `BOOK_BASH_COMMAND`.
 *
 * - It contains a space, so libuv wraps it in `"…"` and the MSYS runtime leaves it literal.
 * - It is POSIX sh, so an MSYS `sh`, `dash` or `zsh` runs it as Git Bash does (#532).
 * - Nothing follows it in argv and it uses no function or shell variable, so `$0`, `$#`, `$1` and
 *   `return` behave exactly as under `bash -c <command>`, and so does the exit status.
 * - The `unset` is parsed together with the command's first line and runs before any of it, so
 *   neither the command nor its children see the variable; a syntax error there aborts the whole
 *   eval, so nothing runs with it set.
 * - `:?` makes a spawn that forgot the variable fail loudly rather than run `eval ""` and succeed.
 *
 * Error messages read `bash: eval: line N:` instead of `bash: -c: line N:`, and
 * `BASH_EXECUTION_STRING` holds this script rather than the command.
 */
export const GIT_BASH_EVAL_SCRIPT = `eval "unset ${GIT_BASH_COMMAND_VARIABLE};\${${GIT_BASH_COMMAND_VARIABLE}:?}"`;

/**
 * The argv that runs `command` under `shell`, or undefined when the command
 * should go to Node's `shell: true` (cmd.exe and the POSIX default).
 *
 * Git Bash on Windows gets the command out of band, in `BOOK_BASH_COMMAND`
 * with {@link GIT_BASH_EVAL_SCRIPT} as its `-c` script (#523), and so does a
 * POSIX sh on the MSYS runtime (#532; see {@link receivesCommandOutOfBand}).
 * Passed in argv, the command could reach the shell altered: libuv
 * (`quote_cmd_arg`) leaves an argument with no space, tab or `"` unquoted on
 * the Windows command line, and the MSYS runtime rebuilds argv from that line
 * itself (`build_argv` in `winsup/cygwin/dcrt0.cc`). In an unquoted word it
 * strips `'` and `"` quotes, globs `?*[{` and a leading `~` against the cwd,
 * and replaces a leading `@word` with the contents of that file, so the shell
 * would run a different string from the one the permission scanner read. An
 * environment variable reaches it byte for byte.
 *
 * WSL's `bash.exe` keeps the plain argv: Windows variables do not reach WSL
 * without WSLENV. So do busybox-w32's `sh` (a native program whose argv libuv
 * round-trips) and non-POSIX shells. A Cygwin `sh.exe` keeps argv too, but
 * that is a known gap, not a safe case: #532 is scoped to the MSYS runtime, and
 * Cygwin's `build_argv`, which MSYS forked, probably rewrites argv the same way
 * (see `isMsysPosixShell`). Every other shell and platform is unchanged. Spawn
 * the result with {@link spawnCommandExecution}, which applies its `env`.
 */
export function shellExecution(
  resolved: ResolvedShell,
  command: string,
  platform: NodeJS.Platform = process.platform,
): CommandExecution | undefined {
  switch (resolved.kind) {
    case 'bash':
    case 'sh':
      if (!resolved.file) return undefined;
      if (platform === 'win32' && receivesCommandOutOfBand(resolved)) {
        return {
          file: resolved.file,
          args: ['-c', GIT_BASH_EVAL_SCRIPT],
          env: { [GIT_BASH_COMMAND_VARIABLE]: command },
        };
      }
      return { file: resolved.file, args: ['-c', command] };
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

/**
 * Spawn a {@link CommandExecution}: `file` with `args` and `shell: false`, with `exec.env` merged
 * last over `options.env` (or the inherited environment). Every site that runs an `exec` goes
 * through here, so the command in `BOOK_BASH_COMMAND` (Git Bash, MSYS sh) reaches the command's
 * spawn alone and is never dropped by one site that forgot it.
 */
export function spawnCommandExecution(
  exec: CommandExecution,
  options: Omit<SpawnOptions, 'shell'>,
): ChildProcess {
  return spawn(exec.file, exec.args, {
    ...options,
    env: exec.env ? { ...(options.env ?? process.env), ...exec.env } : options.env,
    shell: false,
  });
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
