import { describe, expect, it } from 'vitest';
import { hasCompoundShellSyntax } from './shell-chaining.js';

const linux = (command: string) => hasCompoundShellSyntax(command, 'linux');
const win = (command: string) => hasCompoundShellSyntax(command, 'win32');

describe('hasCompoundShellSyntax', () => {
  it.each([
    'git status',
    'git log --oneline -5',
    'git commit -m "fix(x): y"',
    "git stash show 'stash@{0}'",
    'git log "@{upstream}"',
    "git commit -m 'a; b | c'",
    'git commit -m "a; b > c & d"',
    'git commit -m "it\'s"',
    `git commit -m 'say "hi" $(x) \`y\`'`,
    '  git status  ',
    'git status\n',
    '',
  ])('admits %j', (command) => {
    expect(linux(command)).toBe(false);
  });

  it.each([
    ['semicolon', 'git log; rm x'],
    ['&&', 'git status && curl x'],
    ['pipe', 'git log | sh'],
    ['redirect', 'git log > x'],
    ['substitution', 'git log $(x)'],
    ['backtick', 'git log `x`'],
    ['group', 'git log (x)'],
    ['brace', 'git log {x}'],
    ['a separator after a closed quote', 'git log "a" ; rm x'],
    ['a backslash does not hide a separator', 'git log \\; rm x'],
  ])('refuses %s outside quotes', (_label, command) => {
    expect(linux(command)).toBe(true);
  });

  it.each([
    ['command substitution', 'git commit -m "$(curl x)"'],
    ['a backtick', 'git commit -m "`id`"'],
    ['a variable', 'git commit -m "$HOME"'],
  ])('refuses %s inside double quotes', (_label, command) => {
    expect(linux(command)).toBe(true);
  });

  it('treats everything inside single quotes as literal', () => {
    expect(linux("echo '$(x) `y` $HOME ; & | > <'")).toBe(false);
  });

  it.each([
    ['an unterminated double quote', 'git commit -m "abc'],
    ['an unterminated single quote', "git commit -m 'abc"],
    ['a lone quote', '"'],
  ])('fails closed on %s', (_label, command) => {
    expect(linux(command)).toBe(true);
  });

  it.each(['\n', '\r', '\u0085', '\u2028', '\u2029'])(
    'refuses a line break (%j) in every state',
    (lineBreak) => {
      expect(linux(`git log${lineBreak}rm x`)).toBe(true);
      expect(linux(`git log "a${lineBreak}b"`)).toBe(true);
      expect(linux(`git log 'a${lineBreak}b'`)).toBe(true);
    },
  );

  it('refuses a comment that hides an opening quote across lines', () => {
    expect(linux("git log # '\nrm -rf y\n#'")).toBe(true);
  });

  it('ignores whitespace around the command only', () => {
    expect(linux('\n\t git status \r\n')).toBe(false);
    expect(linux('git\nstatus')).toBe(true);
  });

  it.each([
    'echo \\" ; rm y ; echo \\"',
    "echo \\' ; rm y ; echo \\'",
    'git log "a\\" x" ; rm y ; echo "b\\" c"',
    'git log \\"',
  ])('refuses a backslash before a quote: %j', (command) => {
    expect(linux(command)).toBe(true);
    expect(win(command)).toBe(true);
  });

  it('does not treat a backslash before another character specially', () => {
    expect(linux('git log "a\\b"')).toBe(false);
    expect(linux("git log 'a\\b'")).toBe(false);
  });

  it('refuses a backslash before a quote inside single quotes (fish escapes it)', () => {
    expect(linux("echo 'a\\'' ; rm x ; echo \\'")).toBe(true);
    expect(linux("git log 'a\\'")).toBe(true);
    expect(linux("git log 'a\\\"'")).toBe(true);
  });

  it('refuses a caret before a quote outside quotes', () => {
    expect(linux('git log ^" ; rm y ; echo ^"')).toBe(true);
    expect(linux("git log ^' x")).toBe(true);
    expect(linux('git log "a^b"')).toBe(false);
  });

  it.each(['\u2018', '\u2019', '\u201A', '\u201B', '\u201C', '\u201D', '\u201E'])(
    'refuses the typographic quote %j anywhere',
    (quote) => {
      expect(linux(`git log ${quote}x`)).toBe(true);
      expect(linux(`git log "${quote}x"`)).toBe(true);
      expect(linux(`git log '${quote}x'`)).toBe(true);
    },
  );

  it('refuses the PowerShell typographic-quote bypass', () => {
    expect(linux("git log \u2018 ' ; rm x ; ' \u2018")).toBe(true);
  });

  it('does not treat the code points around the typographic range as quotes', () => {
    expect(linux('git log \u2017 \u201F')).toBe(false);
  });

  it.each([
    "git log '\"' ; rm x ; '\"'",
    "git stash show 'stash@{0}'",
    "git log 'a'",
    "git commit -m 'x & del *'",
    "git log it's",
  ])('refuses any single quote on win32: %j', (command) => {
    expect(win(command)).toBe(true);
  });

  it('still admits double-quoted arguments on win32, and single quotes on linux', () => {
    expect(win('git log "@{upstream}"')).toBe(false);
    expect(win('git commit -m "fix(x): y"')).toBe(false);
    expect(linux("git stash show 'stash@{0}'")).toBe(false);
  });
});

describe('hasCompoundShellSyntax on win32 reads the session shell (#512, decision 3)', () => {
  const gitBash = { kind: 'bash', file: 'C:/Program Files/Git/bin/bash.exe', msys: true } as const;

  it.each(["git log 'x'", "git stash show 'stash@{0}'", "git commit -m 'a; b | c'"])(
    'admits %j under Git Bash',
    (command) => {
      expect(hasCompoundShellSyntax(command, 'win32', gitBash)).toBe(false);
    },
  );

  it('still refuses what hides behind a single-quoted double quote under Git Bash', () => {
    expect(hasCompoundShellSyntax("git log '\"' ; rm x ; '\"'", 'win32', gitBash)).toBe(true);
  });

  it('keeps every stricter choice under Git Bash', () => {
    for (const command of [
      "git log 'a\nb'",
      "git log \\'x",
      "git log 'x",
      'git log \u2018x\u2019',
      "git log ^'x'",
      'git log "$(x)"',
    ]) {
      expect(hasCompoundShellSyntax(command, 'win32', gitBash), command).toBe(true);
    }
    expect(hasCompoundShellSyntax("  git log 'x'  ", 'win32', gitBash)).toBe(false);
  });

  it.each([
    ['pwsh', { kind: 'pwsh', file: 'C:/pwsh.exe' } as const],
    ['powershell', { kind: 'powershell', file: 'C:/powershell.exe' } as const],
    ['cmd', { kind: 'cmd' } as const],
    ['bash without a file', { kind: 'bash' } as const],
    ['Git Bash with no MSYS flag', { kind: 'bash', file: gitBash.file } as const],
    ['sh with a file', { kind: 'sh', file: 'C:/sh.exe' } as const],
    ['no shell', undefined],
  ])('refuses any single quote under %s', (_label, shell) => {
    expect(hasCompoundShellSyntax("git log 'x'", 'win32', shell)).toBe(true);
  });

  it('changes nothing off win32, whatever the shell', () => {
    for (const shell of [undefined, { kind: 'cmd' } as const, gitBash]) {
      expect(hasCompoundShellSyntax("git log 'x'", 'linux', shell)).toBe(false);
      expect(hasCompoundShellSyntax("git log 'x' ; rm y", 'linux', shell)).toBe(true);
    }
  });
});

// The Bash tool hands Git Bash on Windows its command in an environment variable (#523), so the
// MSYS runtime never rebuilds it and `'` is a POSIX single quote exactly as on Linux (#527): a
// space-free command is read like any other.
describe('hasCompoundShellSyntax under Git Bash reads single quotes as on Linux (#527)', () => {
  const gitBash = { kind: 'bash', file: 'C:/Program Files/Git/bin/bash.exe', msys: true } as const;

  it.each([
    "git commit -m 'fix(x): y'",
    "echo';id'",
    "echo'1;echo'2",
    "echo 'a;b'",
    "ls'x'",
    "  echo';id'  ",
    "\techo';id'\t",
    "echo';echo${IFS}y'",
    "echo\t'x;y'",
    'echo "it\'s"',
  ])('admits %j as one command, as on Linux', (command) => {
    expect(hasCompoundShellSyntax(command, 'win32', gitBash)).toBe(false);
    expect(hasCompoundShellSyntax(command, 'linux')).toBe(false);
  });

  it.each(["echo 'a';id", "echo 'a' | sh", "echo'a'&&id"])(
    'refuses %j: what is outside the quotes still chains, as on Linux',
    (command) => {
      expect(hasCompoundShellSyntax(command, 'win32', gitBash)).toBe(true);
      expect(hasCompoundShellSyntax(command, 'linux')).toBe(true);
    },
  );

  it.each([
    ['WSL bash.exe', { kind: 'bash', file: 'C:\\Windows\\System32\\bash.exe' } as const],
    ['pwsh', { kind: 'pwsh', file: 'C:/pwsh.exe' } as const],
    ['cmd', { kind: 'cmd' } as const],
  ])('still refuses any single quote under %s', (_label, shell) => {
    for (const command of ["echo';id'", "echo 'a;b'", "git commit -m 'fix(x): y'"]) {
      expect(hasCompoundShellSyntax(command, 'win32', shell), command).toBe(true);
    }
  });
});

// #548: a POSIX sh on the MSYS runtime gets the command out of band, byte for byte, exactly as Git
// Bash does, so `'` reads as on Linux under it. Every other out-of-band sh (Cygwin, a shim or copy
// with no DLL, busybox) still refuses `'`: Windows CI proves only the MSYS runtime's delivery.
describe('hasCompoundShellSyntax under an MSYS sh reads single quotes as on Linux (#548)', () => {
  const msysSh = {
    kind: 'sh',
    file: 'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
    label: '/bin/sh',
    source: 'setting',
    msys: true,
  } as const;

  it.each([
    "git commit -m 'fix(x): y'",
    "echo';id'",
    "echo'1;echo'2",
    "git log 'x'",
    "echo 'a;b'",
    'echo "it\'s"',
  ])('admits %j as one command, as on Linux', (command) => {
    expect(hasCompoundShellSyntax(command, 'win32', msysSh)).toBe(false);
    expect(hasCompoundShellSyntax(command, 'linux')).toBe(false);
  });

  it.each([
    "echo 'a' ; id",
    "echo 'a';id",
    "echo \\'x",
    "echo 'unterminated",
    "echo 'a'\nid",
    "echo 'a'\rid",
    'echo "$HOME"',
    'echo "`id`"',
  ])('still refuses %j, as on Linux', (command) => {
    expect(hasCompoundShellSyntax(command, 'win32', msysSh)).toBe(true);
    expect(hasCompoundShellSyntax(command, 'linux')).toBe(true);
  });

  it.each([
    ['the same file without the MSYS flag', { kind: 'sh', file: msysSh.file } as const],
    ['a Cygwin sh', { kind: 'sh', file: 'C:\\cygwin64\\bin\\sh.exe' } as const],
    ['a scoop shim', { kind: 'sh', file: 'C:\\Users\\u\\scoop\\shims\\sh.exe' } as const],
    ['a busybox-w32 copy', { kind: 'sh', file: 'C:\\tools\\busybox\\sh.exe' } as const],
    [
      'a forged System32 sh with the flag',
      { kind: 'sh', file: 'C:\\Windows\\System32\\sh.exe', msys: true } as const,
    ],
    [
      'a forged WindowsApps sh with the flag',
      {
        kind: 'sh',
        file: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\sh.exe',
        msys: true,
      } as const,
    ],
    [
      'a forged fish with the flag',
      { kind: 'sh', file: 'C:\\msys64\\usr\\bin\\fish.exe', msys: true } as const,
    ],
    ['a flagged sh with no file', { kind: 'sh', msys: true } as const],
    // #548 (owner, 2026-10-18): a non-WSL bash.exe off the MSYS runtime gets the command out of band
    // too, but refuses `'` as an unflagged sh does.
    ['a Cygwin bash.exe', { kind: 'bash', file: 'C:\\cygwin64\\bin\\bash.exe' } as const],
    [
      'a scoop bash.exe shim',
      { kind: 'bash', file: 'C:\\Users\\u\\scoop\\shims\\bash.exe' } as const,
    ],
    ['a bash.exe copy with no DLL', { kind: 'bash', file: 'D:\\tools\\bash.exe' } as const],
    [
      'WSL bash.exe in System32',
      { kind: 'bash', file: 'C:\\Windows\\System32\\bash.exe' } as const,
    ],
    [
      'a forged WSL bash.exe with the flag',
      { kind: 'bash', file: 'C:\\Windows\\System32\\bash.exe', msys: true } as const,
    ],
    [
      'WSL bash.exe in WindowsApps',
      {
        kind: 'bash',
        file: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
      } as const,
    ],
    ['cmd', { kind: 'cmd' } as const],
    ['pwsh', { kind: 'pwsh', file: 'C:/pwsh.exe' } as const],
    ['powershell', { kind: 'powershell', file: 'C:/powershell.exe' } as const],
    ['no known shell', undefined],
  ])('still refuses any single quote under %s on win32', (_label, shell) => {
    for (const command of ["echo';id'", "echo'1;echo'2", "git log 'x'", "echo 'a;b'"]) {
      expect(hasCompoundShellSyntax(command, 'win32', shell), command).toBe(true);
    }
  });

  it('reads it as on Linux off win32, whatever the shell', () => {
    for (const shell of [msysSh, { kind: 'sh', file: 'C:\\cygwin64\\bin\\sh.exe' } as const]) {
      expect(hasCompoundShellSyntax("git log 'x'", 'linux', shell)).toBe(false);
      expect(hasCompoundShellSyntax("echo 'a' ; id", 'linux', shell)).toBe(true);
    }
  });
});

// `kindFromExecutable` calls any executable with "bash" in its name `bash`, WSL's launcher
// included; that is not the MSYS runtime and rebuilds argv its own way.
describe('hasCompoundShellSyntax: the WSL launcher is not Git Bash (#512)', () => {
  it.each([
    'C:\\Windows\\System32\\bash.exe',
    'c:/windows/system32/bash.exe',
    'C:\\WINDOWS\\SysWOW64\\bash.exe',
    'C:\\Windows\\Sysnative\\bash.exe',
    'C:/Windows/System32/bash',
    // The app execution alias directory, where WSL also installs its launcher.
    'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
    'c:/users/me/appdata/local/microsoft/windowsapps/bash.exe',
  ])('refuses a single quote under %s', (file) => {
    for (const shell of [
      { kind: 'bash', file },
      { kind: 'bash', file, msys: true },
    ] as const) {
      expect(hasCompoundShellSyntax("git log 'x'", 'win32', shell)).toBe(true);
      expect(hasCompoundShellSyntax("echo';id'", 'win32', shell)).toBe(true);
    }
  });

  it('still reads a flagged Git Bash outside a WSL launcher directory as Git Bash', () => {
    for (const file of [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:/Program Files/Git/usr/bin/bash.exe',
      'D:\\tools\\Windows Kits\\bash.exe',
      'D:\\Microsoft\\Git\\bin\\bash.exe',
    ]) {
      const shell = { kind: 'bash', file, msys: true } as const;
      expect(hasCompoundShellSyntax("git log 'x'", 'win32', shell), file).toBe(false);
      // Only resolution sets the flag, from the MSYS DLL (#548); without it `'` is refused.
      expect(hasCompoundShellSyntax("git log 'x'", 'win32', { kind: 'bash', file }), file).toBe(
        true,
      );
    }
  });
});
