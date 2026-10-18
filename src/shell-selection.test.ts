import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodePowerShellCommand,
  describeShell,
  GIT_BASH_EVAL_SCRIPT,
  isGitBash,
  readsSingleQuoteAsPosix,
  receivesCommandOutOfBand,
  resolveShell,
  shellExecution,
  shellPromptLine,
  spawnCommandExecution,
} from './shell-selection.js';
import { posixBash, posixExecutable } from './test/real-shells.js';
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

// #532: resolution marks a POSIX sh on the MSYS runtime, by the runtime's DLL beside the executable
// or under `..\usr\bin` for Git's `bin\sh.exe` launcher stub. Since #548 the flag no longer decides
// delivery (every POSIX-named sh outside the WSL directories gets the command out of band); it only
// lets the permission scanner read `'` as on Linux, where Windows CI proves the delivery.
describe('resolveShell marks an MSYS POSIX sh on Windows (#532, #548)', () => {
  const GIT_USR_BIN = win32.join(GIT_ROOT, 'usr', 'bin');
  const MSYS2_USR_BIN = 'C:\\msys64\\usr\\bin';
  const requestedAlone = (file: string, ...present: string[]): ResolvedShell =>
    windows([file, ...present], {}, file);

  it("flags Git's usr\\bin\\sh.exe beside msys-2.0.dll", () => {
    const sh = win32.join(GIT_USR_BIN, 'sh.exe');
    expect(requestedAlone(sh, win32.join(GIT_USR_BIN, 'msys-2.0.dll'))).toMatchObject({
      kind: 'sh',
      file: sh,
      source: 'setting',
      msys: true,
    });
  });

  it("flags Git's bin\\sh.exe launcher through ..\\usr\\bin\\msys-2.0.dll", () => {
    const sh = win32.join(GIT_ROOT, 'bin', 'sh.exe');
    expect(requestedAlone(sh, win32.join(GIT_USR_BIN, 'msys-2.0.dll'))).toMatchObject({
      kind: 'sh',
      file: sh,
      msys: true,
    });
  });

  it.each([
    'dash.exe',
    'zsh.exe',
    'ash.exe',
    'ksh.exe',
    'mksh.exe',
    'SH.EXE',
    'sh',
    'zsh-5.9.exe',
    'ksh93.exe',
  ])('flags MSYS2 %s beside msys-2.0.dll', (name) => {
    const file = win32.join(MSYS2_USR_BIN, name);
    expect(requestedAlone(file, win32.join(MSYS2_USR_BIN, 'msys-2.0.dll'))).toMatchObject({
      kind: 'sh',
      msys: true,
    });
  });

  it.each(['C:\\Program Files\\Git\\usr\\bin\\sh.exe', `${MSYS2_USR_BIN}\\dash.exe`])(
    'delivers flagged %s out of band, and lets the scanner read its quotes',
    (file) => {
      const dll = win32.join(win32.dirname(file), 'msys-2.0.dll');
      const shell = requestedAlone(file, dll);
      expect(shellExecution(shell, 'echo hi', 'win32')).toEqual({
        file,
        args: ['-c', GIT_BASH_EVAL_SCRIPT],
        env: { BOOK_BASH_COMMAND: 'echo hi' },
      });
      expect(readsSingleQuoteAsPosix(shell)).toBe(true);
    },
  );

  // #548: fail closed. The DLL no longer decides delivery: any runtime that rebuilds argv (Cygwin's
  // `build_argv`, which MSYS forked; a shim or copy of an MSYS sh with no DLL beside it) would
  // otherwise get the command where it can be globbed, unquoted or read as `@file`. None of these is
  // flagged, so the scanner still refuses `'` under them.
  it.each<[string, string, string[]]>([
    ['Cygwin beside cygwin1.dll', 'C:\\cygwin64\\bin\\sh.exe', ['C:\\cygwin64\\bin\\cygwin1.dll']],
    ['a scoop shim with no DLL', 'C:\\Users\\u\\scoop\\shims\\sh.exe', []],
    ['a copy with no DLL', 'D:\\tools\\sh.exe', []],
    ['busybox-w32 copied as sh.exe', 'C:\\tools\\busybox\\sh.exe', []],
    ['dash.exe with no DLL', 'D:\\tools\\dash.exe', []],
    ['ash.exe with no DLL', 'D:\\tools\\ash.exe', []],
    ['ksh.exe with no DLL', 'D:\\tools\\ksh.exe', []],
    ['mksh.exe with no DLL', 'D:\\tools\\mksh.exe', []],
    ['zsh.exe with no DLL', 'D:\\tools\\zsh.exe', []],
    ['an extensionless sh with no DLL', 'D:\\tools\\sh', []],
    ['a versioned zsh-5.9.exe with no DLL', 'D:\\tools\\zsh-5.9.exe', []],
    ["Debian's versioned zsh5", 'D:\\tools\\zsh5', []],
    ['a versioned ksh93.exe', 'D:\\tools\\ksh93.exe', []],
    // The WSL exception is WSL's `bash.exe` alone (see isGitBash): WSL ships no `sh.exe` there, so a
    // POSIX name in these directories is some other program, and failing closed is the safe side.
    // The MSYS flag is still never set there, so the scanner keeps refusing `'`.
    [
      'a sh.exe in System32, even beside msys-2.0.dll',
      'C:\\Windows\\System32\\sh.exe',
      ['C:\\Windows\\System32\\msys-2.0.dll'],
    ],
    [
      'an app execution alias zsh.exe',
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\zsh.exe',
      [],
    ],
  ])('delivers %s out of band, unflagged (#548)', (_label, file, present) => {
    const shell = requestedAlone(file, ...present);
    expect(shell).toMatchObject({ kind: 'sh', file });
    expect(shell).not.toHaveProperty('msys');
    const command = "ls?echo_INJECTED 'a b'";
    expect(shellExecution(shell, command, 'win32')).toEqual({
      file,
      args: ['-c', GIT_BASH_EVAL_SCRIPT],
      env: { BOOK_BASH_COMMAND: command },
    });
    expect(receivesCommandOutOfBand(shell)).toBe(true);
    expect(readsSingleQuoteAsPosix(shell)).toBe(false);
  });

  it.each<[string, string, string[]]>([
    [
      'a non-POSIX fish beside msys-2.0.dll',
      `${MSYS2_USR_BIN}\\fish.exe`,
      [`${MSYS2_USR_BIN}\\msys-2.0.dll`],
    ],
    ['fish with no DLL', 'D:\\tools\\fish.exe', []],
    ['nu beside msys-2.0.dll', `${MSYS2_USR_BIN}\\nu.exe`, [`${MSYS2_USR_BIN}\\msys-2.0.dll`]],
    ['nu with no DLL', 'D:\\tools\\nu.exe', []],
    ['busybox.exe under its own name', 'C:\\tools\\busybox.exe', []],
    ['ssh.exe', 'C:\\Windows\\System32\\OpenSSH\\ssh.exe', []],
    ['a name that only starts like a shell', 'D:\\tools\\shell.exe', []],
    ['a non-numeric suffix', 'D:\\tools\\zsh-static.exe', []],
  ])('leaves %s unflagged, on argv', (_label, file, present) => {
    const shell = requestedAlone(file, ...present);
    expect(shell).toMatchObject({ kind: 'sh', file });
    expect(shell).not.toHaveProperty('msys');
    const exec = shellExecution(shell, 'echo hi', 'win32');
    expect(exec).toEqual({ file, args: ['-c', 'echo hi'] });
    expect(exec).not.toHaveProperty('env');
    expect(receivesCommandOutOfBand(shell)).toBe(false);
  });

  it.each(['linux', 'darwin'] as const)('never flags a sh or a bash on %s', (platform) => {
    for (const [kind, file] of [
      ['sh', '/usr/bin/sh'],
      ['bash', '/usr/bin/bash'],
    ] as const) {
      const shell = resolveShell({ platform, env: {}, requested: file, existsSync: () => true });
      expect(shell).toMatchObject({ kind, file });
      expect(shell).not.toHaveProperty('msys');
    }
  });
});

// #548 (owner, 2026-10-18): a non-WSL `bash.exe` reads `'` as on Linux only on the MSYS runtime,
// found as for a sh: `msys-2.0.dll` beside it, or under `..\usr\bin` for Git's `bin\bash.exe`
// launcher stub. Every other one (Cygwin's, scoop's `shims\bash.exe`, a copy) still gets the command
// out of band, but refuses `'` as an unflagged sh does.
describe('resolveShell marks a bash.exe on the MSYS runtime on Windows (#548)', () => {
  const GIT_USR_BIN = win32.join(GIT_ROOT, 'usr', 'bin');
  const GIT_DLL = win32.join(GIT_USR_BIN, 'msys-2.0.dll');
  const MSYS2_USR_BIN = 'C:\\msys64\\usr\\bin';
  const requestedAlone = (file: string, ...present: string[]): ResolvedShell =>
    windows([file, ...present], {}, file);
  const outOfBand = (file: string, command: string): CommandExecution => ({
    file,
    args: ['-c', GIT_BASH_EVAL_SCRIPT],
    env: { BOOK_BASH_COMMAND: command },
  });

  it.each<[string, string, string]>([
    ["Git's bin\\bash.exe launcher through ..\\usr\\bin", GIT_BASH, GIT_DLL],
    ["Git's usr\\bin\\bash.exe beside the DLL", win32.join(GIT_USR_BIN, 'bash.exe'), GIT_DLL],
    [
      "MSYS2's usr\\bin\\bash.exe beside the DLL",
      `${MSYS2_USR_BIN}\\bash.exe`,
      `${MSYS2_USR_BIN}\\msys-2.0.dll`,
    ],
  ])('flags %s, so its quotes read as on Linux', (_label, file, dll) => {
    const shell = requestedAlone(file, dll);
    expect(shell).toMatchObject({ kind: 'bash', file, source: 'setting', msys: true });
    expect(shellExecution(shell, 'echo hi', 'win32')).toEqual(outOfBand(file, 'echo hi'));
    expect(readsSingleQuoteAsPosix(shell)).toBe(true);
  });

  // Git Bash also reaches a session by name, as the launching shell and as the installed fallback,
  // not only as a path; each route must probe the DLL, or real Git Bash users lose `'`.
  const routes: Array<[string, (present: string[]) => ResolvedShell, Partial<ResolvedShell>]> = [
    [
      'the launching shell',
      (present) => windows(present, { MSYSTEM: 'MINGW64', EXEPATH: GIT_ROOT }),
      { source: 'launching-shell' },
    ],
    ['the installed fallback', (present) => windows(present, {}), { source: 'detected' }],
    ['a `bash` request', (present) => windows(present, {}, 'bash'), { source: 'setting' }],
    [
      'BOOK_SHELL=git-bash',
      (present) => windows(present, { BOOK_SHELL: 'git-bash' }),
      { source: 'setting' },
    ],
    [
      'the fallback after a request that was not found',
      (present) => windows(present, {}, 'D:\\missing\\sh.exe'),
      { source: 'detected', warning: expect.stringContaining('D:\\missing\\sh.exe') as string },
    ],
  ];

  it.each(routes)('flags Git Bash chosen as %s', (_label, resolve, expected) => {
    const shell = resolve([GIT_BASH, GIT_DLL]);
    expect(shell).toMatchObject({ kind: 'bash', file: GIT_BASH, msys: true, ...expected });
    expect(readsSingleQuoteAsPosix(shell)).toBe(true);
  });

  it.each(routes)('leaves Git Bash chosen as %s unflagged with no DLL', (_label, resolve) => {
    const shell = resolve([GIT_BASH]);
    expect(shell).toMatchObject({ kind: 'bash', file: GIT_BASH });
    expect(shell).not.toHaveProperty('msys');
    expect(shellExecution(shell, 'echo hi', 'win32')).toEqual(outOfBand(GIT_BASH, 'echo hi'));
    expect(readsSingleQuoteAsPosix(shell)).toBe(false);
  });

  it.each<[string, string, string[]]>([
    [
      'a Cygwin bash.exe beside cygwin1.dll',
      'C:\\cygwin64\\bin\\bash.exe',
      ['C:\\cygwin64\\bin\\cygwin1.dll'],
    ],
    ["scoop's shims\\bash.exe", 'C:\\Users\\u\\scoop\\shims\\bash.exe', []],
    ['a copy of bash.exe with no DLL', 'D:\\tools\\bash.exe', []],
    ['a bash5.exe with no DLL', 'D:\\tools\\bash5.exe', []],
  ])('delivers %s out of band, unflagged, and refuses its quotes', (_label, file, present) => {
    const shell = requestedAlone(file, ...present);
    expect(shell).toMatchObject({ kind: 'bash', file });
    expect(shell).not.toHaveProperty('msys');
    const command = "ls?echo_INJECTED 'a b'";
    expect(shellExecution(shell, command, 'win32')).toEqual(outOfBand(file, command));
    expect(receivesCommandOutOfBand(shell)).toBe(true);
    expect(readsSingleQuoteAsPosix(shell)).toBe(false);
  });

  // The `..\usr\bin` probe is for Git's `bin\` launcher stubs only: a bash or sh in any other
  // directory whose parent happens to hold `usr\bin\msys-2.0.dll` is not on the MSYS runtime.
  it.each<[ResolvedShell['kind'], string, string]>([
    ['bash', win32.join(GIT_ROOT, 'cmd', 'bash.exe'), GIT_DLL],
    ['sh', win32.join(GIT_ROOT, 'cmd', 'sh.exe'), GIT_DLL],
    ['bash', 'C:\\msys64\\opt\\bash.exe', `${MSYS2_USR_BIN}\\msys-2.0.dll`],
  ])('reads ..\\usr\\bin only from a bin directory: %s %s', (kind, file, dll) => {
    const shell = requestedAlone(file, dll);
    expect(shell).toMatchObject({ kind, file });
    expect(shell).not.toHaveProperty('msys');
    expect(receivesCommandOutOfBand(shell)).toBe(true);
    expect(readsSingleQuoteAsPosix(shell)).toBe(false);
  });

  it.each([
    'C:\\Windows\\System32\\bash.exe',
    'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
  ])("never flags WSL's %s, even beside msys-2.0.dll", (file) => {
    const shell = requestedAlone(file, win32.join(win32.dirname(file), 'msys-2.0.dll'));
    expect(shell).toMatchObject({ kind: 'bash', file });
    expect(shell).not.toHaveProperty('msys');
    expect(shellExecution(shell, 'echo hi', 'win32')).toEqual({ file, args: ['-c', 'echo hi'] });
    expect(readsSingleQuoteAsPosix(shell)).toBe(false);
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

  // #548: whether or not resolution found the MSYS runtime, a POSIX sh gets the command out of band.
  it('hands an unflagged sh with a file on Windows the command out of band too (#548)', () => {
    const sh: ResolvedShell = {
      kind: 'sh',
      file: 'C:\\tools\\sh.exe',
      label: 'sh',
      source: 'setting',
    };
    expect(shellExecution(sh, 'echo hi', 'win32')).toEqual({
      file: 'C:\\tools\\sh.exe',
      args: ['-c', GIT_BASH_EVAL_SCRIPT],
      env: { BOOK_BASH_COMMAND: 'echo hi' },
    });
  });

  it.each(['linux', 'darwin'] as const)('keeps every shell on the plain argv on %s', (platform) => {
    const shells: ResolvedShell[] = [
      bashAt('/usr/bin/bash'),
      bashAt(GIT_BASH),
      { kind: 'sh', file: '/usr/bin/sh', label: '/bin/sh', source: 'setting' },
      { kind: 'sh', file: '/usr/bin/zsh', label: '/bin/sh', source: 'setting' },
      { kind: 'sh', file: 'C:\\tools\\sh.exe', label: '/bin/sh', source: 'setting', msys: true },
      { kind: 'sh', file: '/usr/bin/fish', label: '/bin/sh', source: 'setting' },
    ];
    for (const shell of shells) {
      expect(shellExecution(shell, 'echo hi', platform), shell.file).toEqual({
        file: shell.file,
        args: ['-c', 'echo hi'],
      });
    }
  });

  // #532: an MSYS POSIX sh rebuilds argv like Git Bash, so it gets the same delivery on Windows.
  it('hands an MSYS sh on Windows the command in BOOK_BASH_COMMAND and the fixed script', () => {
    const file = 'C:\\Program Files\\Git\\usr\\bin\\sh.exe';
    const sh: ResolvedShell = { kind: 'sh', file, label: '/bin/sh', source: 'setting', msys: true };
    const command = 'ls?echo_INJECTED';
    expect(shellExecution(sh, command, 'win32')).toEqual({
      file,
      args: ['-c', GIT_BASH_EVAL_SCRIPT],
      env: { BOOK_BASH_COMMAND: command },
    });
    for (const platform of ['linux', 'darwin'] as const) {
      expect(shellExecution(sh, command, platform)).toEqual({ file, args: ['-c', command] });
    }
  });

  // #548: delivery is decided by kind and file name alone, never by the MSYS flag or the directory.
  it('delivers out of band to Git Bash and every POSIX-named sh, wherever it lives', () => {
    const outOfBand: Array<Pick<ResolvedShell, 'kind' | 'file' | 'msys'> | undefined> = [
      { kind: 'bash', file: GIT_BASH },
      { kind: 'sh', file: 'C:\\msys64\\usr\\bin\\sh.exe', msys: true },
      { kind: 'sh', file: 'C:\\tools\\sh.exe' },
      { kind: 'sh', file: 'C:\\cygwin64\\bin\\sh.exe' },
      { kind: 'sh', file: 'C:\\Users\\u\\scoop\\shims\\sh.exe' },
      { kind: 'sh', file: 'D:/tools/ZSH.EXE' },
      { kind: 'sh', file: 'D:\\tools\\mksh' },
      { kind: 'sh', file: 'D:\\tools\\zsh-5.9.exe' },
      { kind: 'sh', file: 'C:\\Windows\\System32\\sh.exe', msys: true },
      { kind: 'sh', file: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\sh.exe' },
    ];
    for (const shell of outOfBand) expect(receivesCommandOutOfBand(shell), shell?.file).toBe(true);
    const argv: Array<Pick<ResolvedShell, 'kind' | 'file' | 'msys'> | undefined> = [
      { kind: 'sh' },
      { kind: 'sh', msys: true },
      { kind: 'sh', file: 'C:\\msys64\\usr\\bin\\fish.exe', msys: true },
      { kind: 'sh', file: 'D:\\tools\\nu.exe' },
      { kind: 'sh', file: 'C:\\tools\\busybox.exe' },
      { kind: 'sh', file: 'D:\\tools\\shell.exe' },
      { kind: 'bash', file: 'C:\\Windows\\System32\\bash.exe' },
      { kind: 'bash' },
      { kind: 'pwsh', file: PWSH },
      { kind: 'powershell', file: POWERSHELL },
      { kind: 'cmd', file: CMD },
      undefined,
    ];
    for (const shell of argv) expect(receivesCommandOutOfBand(shell), shell?.file).toBe(false);
  });

  // #548: the scanner reads `'` as on Linux only where CI proves the delivery: a bash or sh on the
  // MSYS runtime. Cygwin, shims and copies with no DLL, and busybox get the delivery but not this.
  it('reads single quotes as POSIX under a flagged Git Bash or MSYS sh only', () => {
    expect(readsSingleQuoteAsPosix({ kind: 'bash', file: GIT_BASH, msys: true })).toBe(true);
    expect(
      readsSingleQuoteAsPosix({ kind: 'bash', file: 'C:\\msys64\\usr\\bin\\bash.exe', msys: true }),
    ).toBe(true);
    expect(
      readsSingleQuoteAsPosix({ kind: 'sh', file: 'C:\\msys64\\usr\\bin\\sh.exe', msys: true }),
    ).toBe(true);
    expect(
      readsSingleQuoteAsPosix({
        kind: 'sh',
        file: 'C:\\msys64\\usr\\bin\\zsh-5.9.exe',
        msys: true,
      }),
    ).toBe(true);
    for (const shell of [
      { kind: 'sh', file: 'C:\\msys64\\usr\\bin\\sh.exe' },
      { kind: 'sh', file: 'C:\\cygwin64\\bin\\sh.exe' },
      { kind: 'sh', file: 'C:\\Users\\u\\scoop\\shims\\sh.exe' },
      { kind: 'sh', msys: true },
      { kind: 'sh', file: 'C:\\Windows\\System32\\sh.exe', msys: true },
      {
        kind: 'sh',
        file: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\sh.exe',
        msys: true,
      },
      { kind: 'sh', file: 'C:\\msys64\\usr\\bin\\fish.exe', msys: true },
      { kind: 'bash', file: GIT_BASH },
      { kind: 'bash', file: 'C:\\cygwin64\\bin\\bash.exe' },
      { kind: 'bash', file: 'C:\\Users\\u\\scoop\\shims\\bash.exe' },
      { kind: 'bash', file: 'C:\\Windows\\System32\\bash.exe' },
      { kind: 'bash', file: 'C:\\Windows\\System32\\bash.exe', msys: true },
      {
        kind: 'bash',
        file: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
        msys: true,
      },
      { kind: 'bash' },
      { kind: 'bash', msys: true },
      { kind: 'pwsh', file: PWSH, msys: true },
      { kind: 'cmd', file: CMD },
      undefined,
    ] as const) {
      expect(readsSingleQuoteAsPosix(shell), JSON.stringify(shell)).toBe(false);
    }
    expect(isGitBash({ kind: 'sh', file: 'C:\\msys64\\usr\\bin\\sh.exe' })).toBe(false);
  });

  // The scanner must never be laxer than delivery: a shell that reads `'` as POSIX must also get the
  // command byte for byte, or the scanner and the shell could read two different commands.
  it('never relaxes the quote rule for a shell that gets the command in argv', () => {
    const table: Array<Pick<ResolvedShell, 'kind' | 'file' | 'msys'>> = [
      { kind: 'bash', file: GIT_BASH },
      { kind: 'bash', file: GIT_BASH, msys: true },
      { kind: 'bash', file: 'C:\\Windows\\System32\\bash.exe' },
      { kind: 'bash', file: 'C:\\Windows\\System32\\bash.exe', msys: true },
      { kind: 'bash', msys: true },
      { kind: 'bash', file: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe' },
      { kind: 'sh', file: 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', msys: true },
      { kind: 'sh', file: 'C:\\cygwin64\\bin\\sh.exe' },
      { kind: 'sh', file: 'C:\\Users\\u\\scoop\\shims\\sh.exe' },
      { kind: 'sh', file: 'C:\\msys64\\usr\\bin\\fish.exe' },
      { kind: 'sh', file: 'D:\\tools\\nu.exe' },
      { kind: 'sh', file: 'C:\\Windows\\System32\\sh.exe', msys: true },
      { kind: 'sh', file: 'C:\\msys64\\usr\\bin\\fish.exe', msys: true },
      { kind: 'sh', msys: true },
      { kind: 'cmd', file: CMD },
      { kind: 'pwsh', file: PWSH },
      { kind: 'pwsh', file: PWSH, msys: true },
    ];
    for (const shell of table) {
      if (readsSingleQuoteAsPosix(shell)) {
        expect(receivesCommandOutOfBand(shell), JSON.stringify(shell)).toBe(true);
      }
    }
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
function run(exec: CommandExecution, timeoutMs?: number, cwd?: string): Promise<ShellRun> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BOOK_BASH_COMMAND;
  return new Promise((resolve, reject) => {
    const child = spawnCommandExecution(exec, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd,
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

// #548: every POSIX-named sh on Windows gets the command through GIT_BASH_EVAL_SCRIPT, whatever its
// runtime, so the script must behave as a direct `-c` in each shell of the set. That is checked here
// against the real shells found on PATH (each skipped when absent, nothing is downloaded); the
// Windows side of the delivery runs on the Windows CI leg (`src/tools/shell.test.ts`).
const posixShells: ReadonlyArray<
  readonly [label: string, file: string | undefined, prefix: readonly string[]]
> = [
  ['sh', posixExecutable('sh'), []],
  ['bash', posixExecutable('bash'), []],
  ['dash', posixExecutable('dash'), []],
  ['zsh', posixExecutable('zsh'), []],
  ['ksh', posixExecutable('ksh'), []],
  ['mksh', posixExecutable('mksh'), []],
  ['busybox sh', posixExecutable('busybox'), ['sh']],
];
for (const [label, file, prefix] of posixShells) {
  describe.skipIf(!file)(`GIT_BASH_EVAL_SCRIPT under a real ${label} (#548)`, () => {
    let dir = '';
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'book-eval-script-'));
    });
    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    const evaluated = (command: string): Promise<ShellRun> =>
      run(
        {
          file: file!,
          args: [...prefix, '-c', GIT_BASH_EVAL_SCRIPT],
          env: { BOOK_BASH_COMMAND: command },
        },
        undefined,
        dir,
      );
    const plain = (command: string): Promise<ShellRun> =>
      run({ file: file!, args: [...prefix, '-c', command] }, undefined, dir);
    const notFound = (text: string): number => text.match(/not found/g)?.length ?? 0;

    it('keeps a quoted space-free word as one word, byte for byte', async () => {
      const result = await evaluated("printf '%s\\n' a'1;b'2");
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('a1;b2\n');
    });

    it("runs `echo'1;echo'2` as one command, not two", async () => {
      const result = await evaluated("echo'1;echo'2");
      expect(notFound(result.stderr), result.stderr).toBe(1);
      expect(result.stderr).toContain('echo1;echo2');
      expect(result.code).not.toBe(0);
    });

    it('does not read a leading @word as a response file', async () => {
      writeFileSync(join(dir, 'f'), 'echo INJECTED\n');
      const result = await evaluated('@f');
      expect(notFound(result.stderr), result.stderr).toBe(1);
      expect(result.out).not.toContain('INJECTED');
    });

    it('hides BOOK_BASH_COMMAND from the command and its children', async () => {
      const result = await evaluated(
        `printf '%s\\n' "[\${BOOK_BASH_COMMAND+LEAK}]" "$(env | grep -c '^BOOK_BASH_COMMAND=')"`,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('[]\n0\n');
    });

    it('keeps the stdout, $0, $# and exit status of a direct -c', async () => {
      const command = 'echo "x [$0][$#]"; exit 7';
      const [tool, direct] = await Promise.all([evaluated(command), plain(command)]);
      expect(tool.stdout).toBe(direct.stdout);
      expect(tool.code).toBe(direct.code);
      expect(tool.code).toBe(7);
    });

    // bash, dash and busybox exit 2 on a syntax error and zsh exits 1, through eval or not alike.
    it('exits as a direct -c does on a syntax error', async () => {
      const command = 'echo "a" )';
      const [tool, direct] = await Promise.all([evaluated(command), plain(command)]);
      expect(tool.code).toBe(direct.code);
      expect(tool.code).not.toBe(0);
    });
  });
}
