import { win32 } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decodePowerShellCommand,
  describeShell,
  GIT_BASH_EVAL_SCRIPT,
  isGitBash,
  resolveShell,
  shellExecution,
  shellPromptLine,
  spawnCommandExecution,
} from './shell-selection.js';
import { posixBash } from './test/real-shells.js';
import type { CommandExecution, ResolvedShell } from './types/runtime.js';

const GIT_ROOT = 'C:\\Program Files\\Git';
const GIT_BASH = win32.join(GIT_ROOT, 'bin', 'bash.exe');
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';

function windows(
  present: string[],
  env: NodeJS.ProcessEnv = {},
  requested?: string,
): ResolvedShell {
  const files = new Set(present);
  return resolveShell({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ComSpec: CMD, ...env },
    requested,
    existsSync: (path) => files.has(path),
  });
}

describe('resolveShell on Windows', () => {
  it('keeps Git Bash when Book was launched from one', () => {
    const shell = windows([GIT_BASH, PWSH, POWERSHELL], { MSYSTEM: 'MINGW64', EXEPATH: GIT_ROOT });
    expect(shell).toMatchObject({ kind: 'bash', file: GIT_BASH, source: 'launching-shell' });
  });

  it('recognises a POSIX $SHELL as the launching shell even without MSYSTEM', () => {
    const shell = windows([GIT_BASH, PWSH], { SHELL: '/usr/bin/bash', EXEPATH: GIT_ROOT });
    expect(shell).toMatchObject({ kind: 'bash', source: 'launching-shell' });
  });

  it('prefers PowerShell 7 when not launched from a POSIX shell', () => {
    const shell = windows([GIT_BASH, PWSH, POWERSHELL], { EXEPATH: GIT_ROOT });
    expect(shell).toMatchObject({ kind: 'pwsh', file: PWSH, source: 'detected' });
  });

  it('finds pwsh on PATH before the install directories', () => {
    const onPath = 'D:\\tools\\pwsh.exe';
    const shell = windows([onPath, PWSH], { PATH: 'D:\\tools;C:\\Windows' });
    expect(shell.file).toBe(onPath);
  });

  it('falls back to Windows PowerShell 5.1, then an installed Git Bash, then cmd.exe', () => {
    expect(windows([POWERSHELL, GIT_BASH])).toMatchObject({
      kind: 'powershell',
      file: POWERSHELL,
      source: 'detected',
    });
    expect(windows([GIT_BASH])).toMatchObject({ kind: 'bash', file: GIT_BASH, source: 'detected' });
    expect(windows([])).toMatchObject({ kind: 'cmd', file: CMD, source: 'fallback' });
  });

  it('derives Git Bash from the git executable on PATH', () => {
    const git = 'E:\\Git\\cmd\\git.exe';
    const bash = 'E:\\Git\\bin\\bash.exe';
    const shell = windows([git, bash], { PATH: 'E:\\Git\\cmd', MSYSTEM: 'MINGW64' });
    expect(shell.file).toBe(bash);
  });

  it('honours a requested kind over the launching shell', () => {
    const shell = windows(
      [GIT_BASH, POWERSHELL],
      { MSYSTEM: 'MINGW64', EXEPATH: GIT_ROOT },
      'powershell',
    );
    expect(shell).toMatchObject({ kind: 'powershell', file: POWERSHELL, source: 'setting' });
  });

  it('lets BOOK_SHELL win over the settings value', () => {
    const shell = windows([GIT_BASH, PWSH], { BOOK_SHELL: 'bash', EXEPATH: GIT_ROOT }, 'pwsh');
    expect(shell).toMatchObject({ kind: 'bash', file: GIT_BASH, source: 'setting' });
  });

  it('accepts an executable path and classifies it by name', () => {
    const custom = 'D:\\shells\\pwsh.exe';
    expect(windows([custom], {}, custom)).toMatchObject({ kind: 'pwsh', file: custom });
    const bash = 'D:\\msys64\\usr\\bin\\bash.exe';
    expect(windows([bash], {}, bash)).toMatchObject({ kind: 'bash', file: bash });
  });

  it('reports a request it cannot honour and still chooses a shell', () => {
    const shell = windows([PWSH], {}, 'D:\\missing\\bash.exe');
    expect(shell).toMatchObject({ kind: 'pwsh', source: 'detected' });
    expect(shell.warning).toContain('D:\\missing\\bash.exe');
  });
});

describe('resolveShell off Windows', () => {
  it('keeps the platform default with no executable, so spawn still uses shell: true', () => {
    const shell = resolveShell({ platform: 'linux', env: {}, existsSync: () => false });
    expect(shell).toMatchObject({ kind: 'sh', source: 'detected' });
    expect(shell.file).toBeUndefined();
    expect(shellExecution(shell, 'ls')).toBeUndefined();
  });

  it('resolves a requested bash from PATH', () => {
    const shell = resolveShell({
      platform: 'linux',
      env: { PATH: '/usr/local/bin:/usr/bin' },
      requested: 'bash',
      existsSync: (path) => path === '/usr/bin/bash',
    });
    expect(shell).toMatchObject({ kind: 'bash', file: '/usr/bin/bash', source: 'setting' });
    expect(shellExecution(shell, 'echo hi', 'linux')).toEqual({
      file: '/usr/bin/bash',
      args: ['-c', 'echo hi'],
    });
  });
});

describe('shellExecution', () => {
  const bashAt = (file: string): ResolvedShell => ({
    kind: 'bash',
    file,
    label: 'Git Bash',
    source: 'detected',
  });

  it('runs bash with -c and the untouched command off Windows', () => {
    expect(shellExecution(bashAt(GIT_BASH), 'echo "a b" && ls', 'linux')).toEqual({
      file: GIT_BASH,
      args: ['-c', 'echo "a b" && ls'],
    });
    expect(shellExecution(bashAt('/usr/bin/bash'), "echo';id'", 'linux')).toEqual({
      file: '/usr/bin/bash',
      args: ['-c', "echo';id'"],
    });
    expect(shellExecution(bashAt('/bin/bash'), 'ls', 'darwin')).toEqual({
      file: '/bin/bash',
      args: ['-c', 'ls'],
    });
  });

  // #523: the MSYS runtime rebuilds an unwrapped argv word itself, stripping quotes, globbing and
  // expanding `@file`, so Git Bash on Windows gets the command in an environment variable instead.
  it('hands Git Bash on Windows the command in BOOK_BASH_COMMAND and a fixed script', () => {
    const command = "echo';echo${IFS}y'";
    expect(shellExecution(bashAt(GIT_BASH), command, 'win32')).toEqual({
      file: GIT_BASH,
      args: ['-c', GIT_BASH_EVAL_SCRIPT],
      env: { BOOK_BASH_COMMAND: command },
    });
    expect(GIT_BASH_EVAL_SCRIPT).toBe('eval "unset BOOK_BASH_COMMAND;${BOOK_BASH_COMMAND:?}"');
    // The script has a space, so libuv wraps it in `"…"` and MSYS leaves it literal.
    expect(GIT_BASH_EVAL_SCRIPT).toContain(' ');
  });

  it.each([
    'C:\\Windows\\System32\\bash.exe',
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
    'c:/users/me/appdata/local/microsoft/windowsapps/bash.exe',
  ])("keeps WSL's %s on the plain argv: Windows variables do not reach WSL", (wsl) => {
    const exec = shellExecution(bashAt(wsl), 'echo hi', 'win32');
    expect(exec).toEqual({ file: wsl, args: ['-c', 'echo hi'] });
    expect(exec).not.toHaveProperty('env');
  });

  it('keeps sh with a file on Windows on the plain argv', () => {
    const sh: ResolvedShell = {
      kind: 'sh',
      file: 'C:\\tools\\sh.exe',
      label: 'sh',
      source: 'setting',
    };
    expect(shellExecution(sh, 'echo hi', 'win32')).toEqual({
      file: 'C:\\tools\\sh.exe',
      args: ['-c', 'echo hi'],
    });
  });

  it('leaves a bash without a file to Node on Windows', () => {
    const shell: ResolvedShell = { kind: 'bash', label: 'Git Bash', source: 'detected' };
    expect(shellExecution(shell, 'echo hi', 'win32')).toBeUndefined();
  });

  it('recognises Git Bash by kind, file and directory', () => {
    expect(isGitBash({ kind: 'bash', file: GIT_BASH })).toBe(true);
    expect(isGitBash({ kind: 'bash', file: 'C:/Program Files/Git/usr/bin/bash.exe' })).toBe(true);
    expect(isGitBash({ kind: 'bash', file: 'C:\\Windows\\System32\\bash.exe' })).toBe(false);
    expect(isGitBash({ kind: 'bash', file: 'c:/windows/sysnative/bash.exe' })).toBe(false);
    expect(
      isGitBash({
        kind: 'bash',
        file: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
      }),
    ).toBe(false);
    expect(isGitBash({ kind: 'bash', file: 'D:/MICROSOFT/WINDOWSAPPS/bash.exe' })).toBe(false);
    expect(isGitBash({ kind: 'bash' })).toBe(false);
    expect(isGitBash({ kind: 'sh', file: 'C:\\tools\\sh.exe' })).toBe(false);
    expect(isGitBash({ kind: 'pwsh', file: PWSH })).toBe(false);
    expect(isGitBash(undefined)).toBe(false);
  });

  it('leaves PowerShell on Windows unchanged, with no env', () => {
    const shell: ResolvedShell = {
      kind: 'pwsh',
      file: PWSH,
      label: 'PowerShell 7',
      source: 'detected',
    };
    const onWindows = shellExecution(shell, 'Write-Output "x"', 'win32');
    expect(onWindows).toEqual(shellExecution(shell, 'Write-Output "x"', 'linux'));
    expect(onWindows).not.toHaveProperty('env');
    expect(onWindows?.args.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
  });

  it('encodes a PowerShell command so quotes and $env survive byte for byte', () => {
    const shell: ResolvedShell = {
      kind: 'pwsh',
      file: PWSH,
      label: 'PowerShell 7',
      source: 'detected',
    };
    const command = 'Write-Output "a \'b\' c"; $env:X = "y"; Get-ChildItem `\n"C:\\dir with space"';
    const exec = shellExecution(shell, command);
    expect(exec?.file).toBe(PWSH);
    expect(exec?.args.slice(0, 4)).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
    ]);
    const decoded = decodePowerShellCommand(exec!.args[4]!);
    expect(decoded).toContain(command);
    expect(decoded.startsWith("$ProgressPreference = 'SilentlyContinue'")).toBe(true);
    expect(decoded.endsWith('exit 1 } }')).toBe(true);
    expect(decoded).not.toContain('ErrorRecord');
  });

  it('wraps a Windows PowerShell 5.1 command so errors arrive as text, not CLIXML', () => {
    const shell: ResolvedShell = {
      kind: 'powershell',
      file: POWERSHELL,
      label: 'Windows PowerShell 5.1',
      source: 'detected',
    };
    const decoded = decodePowerShellCommand(shellExecution(shell, 'Get-Item "C:\\x"')!.args[4]!);
    expect(decoded).toContain('& {\nGet-Item "C:\\x"\n');
    expect(decoded).toContain('2>&1 | ForEach-Object');
    expect(decoded).toContain('[System.Management.Automation.ErrorRecord]');
    expect(decoded.endsWith('exit 1 } }')).toBe(true);
  });

  it('leaves cmd.exe to Node so its quoting rules are applied by the platform', () => {
    const shell: ResolvedShell = { kind: 'cmd', file: CMD, label: 'cmd.exe', source: 'fallback' };
    expect(shellExecution(shell, 'dir')).toBeUndefined();
  });
});

describe('spawnCommandExecution', () => {
  const script =
    'process.stdout.write(JSON.stringify([process.env.BOOK_TEST_A ?? null, process.env.BOOK_TEST_B ?? null, Boolean(process.env.PATH ?? process.env.Path)]))';

  function printed(exec: CommandExecution, env?: NodeJS.ProcessEnv): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawnCommandExecution(exec, { stdio: ['ignore', 'pipe', 'inherit'], env });
      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', () => resolve(JSON.parse(out)));
    });
  }

  it('merges exec.env last, over the env it is given', async () => {
    const exec = { file: process.execPath, args: ['-e', script], env: { BOOK_TEST_A: 'exec' } };
    const env = { ...process.env, BOOK_TEST_A: 'options', BOOK_TEST_B: 'options' };
    expect(await printed(exec, env)).toEqual(['exec', 'options', true]);
  });

  it('merges exec.env over the inherited environment when no env is given', async () => {
    const exec = { file: process.execPath, args: ['-e', script], env: { BOOK_TEST_A: 'exec' } };
    expect(await printed(exec)).toEqual(['exec', null, true]);
  });

  it('passes the env through untouched when exec has none', async () => {
    const exec = { file: process.execPath, args: ['-e', script] };
    const env = { ...process.env, BOOK_TEST_B: 'options' };
    expect(await printed(exec, env)).toEqual([null, 'options', true]);
  });
});

describe('shellPromptLine', () => {
  const line = (kind: ResolvedShell['kind']): string =>
    shellPromptLine({ kind, file: 'X:\\shell.exe', label: kind, source: 'detected' });

  it('names the shell and the syntax that changes with it', () => {
    expect(line('bash')).toContain('Git Bash (POSIX sh)');
    expect(line('bash')).toContain('not cmd.exe or PowerShell');
    expect(line('pwsh')).toContain('`&&` and `||` work');
    expect(line('powershell')).toContain('`&&` and `||` are NOT available');
    expect(line('cmd')).toContain('runs cmd.exe');
    expect(line('cmd')).toContain('BOOK_SHELL');
    expect(shellPromptLine({ kind: 'sh', label: '/bin/sh', source: 'detected' })).toContain(
      '`/bin/sh`',
    );
  });

  it('describes a shell with its path for doctor', () => {
    expect(
      describeShell({ kind: 'pwsh', file: PWSH, label: 'PowerShell 7', source: 'detected' }),
    ).toBe(`PowerShell 7 (${PWSH})`);
    expect(describeShell({ kind: 'sh', label: '/bin/sh', source: 'detected' })).toBe('/bin/sh');
  });
});

interface ShellRun {
  code: number | null;
  /** stdout and stderr interleaved in arrival order. */
  out: string;
  stdout: string;
  stderr: string;
}

/**
 * Run `exec` the way the Bash tool does (`spawnCommandExecution`, so `exec.env` is applied), with an
 * environment that inherits no BOOK_BASH_COMMAND of its own.
 */
function run(exec: CommandExecution, timeoutMs?: number): Promise<ShellRun> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BOOK_BASH_COMMAND;
  return new Promise((resolve, reject) => {
    const child = spawnCommandExecution(exec, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      // A deadline is a kill, not a warning: a shell that never returns must
      // not outlive the hook that waited for it.
      timeout: timeoutMs,
    });
    let out = '';
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, stdout, stderr }));
  });
}

describe.runIf(process.platform === 'win32')('real Windows shells', () => {
  // The first powershell.exe on a cold Windows runner pays for module auto-load
  // and a Defender scan, which on its own can outlast a test timeout — the run
  // below spawns the same executable four times. So the cold start is paid here,
  // on the same executable the test measures rather than a path assumed to be
  // it, and the measured test does not pay it. The child gets its own deadline
  // shorter than the hook's, so a shell that never comes back is killed instead
  // of being left running; a warm-up that fails is not this suite's finding to
  // report, and the test that needs it will say so in its own right.
  beforeAll(async () => {
    const shell = resolveShell({ requested: 'powershell' });
    if (shell.kind !== 'powershell' || !shell.file) return;
    await run(
      {
        file: shell.file,
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
      },
      150_000,
    ).catch(() => undefined);
  }, 180_000);

  it('runs Windows PowerShell 5.1 with the exit code of the last statement', async () => {
    const shell = resolveShell({ requested: 'powershell' });
    expect(shell.kind).toBe('powershell');
    const ok = await run(shellExecution(shell, 'Write-Output "a b"')!);
    expect(ok.out.trim()).toBe('a b');
    expect(ok.code).toBe(0);
    const explicit = await run(shellExecution(shell, 'Write-Output x; exit 3')!);
    expect(explicit.code).toBe(3);
    const native = await run(shellExecution(shell, 'cmd /c exit 7')!);
    expect(native.code).toBe(7);
    const failed = await run(shellExecution(shell, 'Get-Item "C:\\definitely\\missing\\path"')!);
    expect(failed.code).toBe(1);
    // 5.1 would otherwise hand the model a CLIXML document on stderr.
    expect(failed.out).toContain('Cannot find path');
    expect(failed.out).not.toContain('CLIXML');
  }, 120_000);

  it('runs Git Bash as a POSIX shell when one is installed', async () => {
    const shell = resolveShell({ requested: 'bash' });
    if (shell.kind !== 'bash') return;
    const result = await run(shellExecution(shell, 'echo $((1+2)) "$0"')!);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toMatch(/^3 .*bash/);
  }, 60_000);
});

/** The command through the Git Bash delivery: the fixed script, the command in the variable. */
const viaEval = (command: string): Promise<ShellRun> =>
  run({
    file: posixBash!,
    args: ['-c', GIT_BASH_EVAL_SCRIPT],
    env: { BOOK_BASH_COMMAND: command },
  });

/** The command as `bash -c <command>`, the behaviour the eval script must reproduce. */
const direct = (command: string): Promise<ShellRun> =>
  run({ file: posixBash!, args: ['-c', command] });

// #523: the fixed script is plain bash, so its contract is checked against a real bash here; the
// MSYS side of the delivery only runs on the Windows CI leg (`src/tools/shell.test.ts`).
describe.skipIf(!posixBash)('GIT_BASH_EVAL_SCRIPT under a real bash', () => {
  it('keeps $0, $# and the exit status of bash -c', async () => {
    const command = 'echo "[$0][$#][$*]"; exit 7';
    const evaluated = await viaEval(command);
    const plain = await direct(command);
    expect(evaluated.stdout).toBe(plain.stdout);
    expect(evaluated.code).toBe(plain.code);
    expect(evaluated.code).toBe(7);
  });

  it('exits 2 on a syntax error, as bash -c does', async () => {
    const evaluated = await viaEval('echo (');
    expect(evaluated.code).toBe((await direct('echo (')).code);
    expect(evaluated.code).toBe(2);
  });

  it('unsets the variable before the command runs, for the shell and its children', async () => {
    const result = await viaEval('echo "[${BOOK_BASH_COMMAND+LEAK}]"; env');
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe('[]');
    expect(result.stdout).not.toMatch(/^BOOK_BASH_COMMAND=/m);
    expect(result.stdout).not.toContain('LEAK');
  });

  it('never runs a later line with the variable set when line 1 is a syntax error', async () => {
    const result = await viaEval('echo (\necho "${BOOK_BASH_COMMAND+LEAK}"');
    expect(result.stdout).not.toContain('LEAK');
    expect(result.code).not.toBe(0);
  });

  it('runs a ~20,000-character command', async () => {
    const literal = 'x'.repeat(20_000);
    const result = await viaEval(`echo ${literal}`);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${literal}\n`);
  });

  it('fails loudly when the variable is empty or missing instead of running nothing', async () => {
    const empty = await viaEval('');
    expect(empty.code).not.toBe(0);
    expect(empty.stderr).toContain('BOOK_BASH_COMMAND');
    const missing = await run({ file: posixBash!, args: ['-c', GIT_BASH_EVAL_SCRIPT] });
    expect(missing.code).not.toBe(0);
  });
});
