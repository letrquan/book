import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodePowerShellCommand,
  describeShell,
  resolveShell,
  shellExecution,
  shellPromptLine,
} from './shell-selection.js';
import type { ResolvedShell } from './types/runtime.js';

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
    expect(shellExecution(shell, 'echo hi')).toEqual({
      file: '/usr/bin/bash',
      args: ['-c', 'echo hi'],
    });
  });
});

describe('shellExecution', () => {
  it('runs bash with -c and the untouched command', () => {
    const shell: ResolvedShell = {
      kind: 'bash',
      file: GIT_BASH,
      label: 'Git Bash',
      source: 'detected',
    };
    expect(shellExecution(shell, 'echo "a b" && ls')).toEqual({
      file: GIT_BASH,
      args: ['-c', 'echo "a b" && ls'],
    });
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

function run(exec: {
  file: string;
  args: string[];
}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(exec.file, exec.args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe.runIf(process.platform === 'win32')('real Windows shells', () => {
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
  }, 60_000);

  it('runs Git Bash as a POSIX shell when one is installed', async () => {
    const shell = resolveShell({ requested: 'bash' });
    if (shell.kind !== 'bash') return;
    const result = await run(shellExecution(shell, 'echo $((1+2)) "$0"')!);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toMatch(/^3 .*bash/);
  }, 60_000);
});
