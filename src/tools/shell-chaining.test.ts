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
  const gitBash = { kind: 'bash', file: 'C:/Program Files/Git/bin/bash.exe' } as const;

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

// Git Bash is spawned as `[file, '-c', command]`. libuv leaves a space-free argument unwrapped on
// the Windows command line, and the MSYS runtime rebuilds argv from that line itself, reading `'`
// in an unwrapped word as a quote and stripping it: `echo';id'` reaches bash as `echo;id`. A word
// with a space, a tab or a `"` is wrapped in `"…"` by libuv, inside which `'` is literal.
describe('hasCompoundShellSyntax under Git Bash: a space-free command is not wrapped (#512)', () => {
  const gitBash = { kind: 'bash', file: 'C:/Program Files/Git/bin/bash.exe' } as const;

  it.each(["echo';id'", "echo'1;echo'2", "ls'x'", "echo'", "  echo';id'  "])(
    'refuses %j: MSYS would strip the quotes and run two commands',
    (command) => {
      expect(hasCompoundShellSyntax(command, 'win32', gitBash)).toBe(true);
    },
  );

  it.each(["git log 'x'", "git stash show 'stash@{0}'", "echo\t'x;y'", 'echo "it\'s"'])(
    'admits %j: libuv wraps the argument, so the quotes arrive intact',
    (command) => {
      expect(hasCompoundShellSyntax(command, 'win32', gitBash)).toBe(false);
    },
  );

  it('reads the trimmed command: surrounding spaces do not wrap it', () => {
    expect(hasCompoundShellSyntax("  echo';id'  ", 'win32', gitBash)).toBe(true);
    expect(hasCompoundShellSyntax("\techo';id'\t", 'win32', gitBash)).toBe(true);
  });

  it('does not change anything off win32', () => {
    expect(hasCompoundShellSyntax("echo'x'", 'linux', gitBash)).toBe(false);
    expect(hasCompoundShellSyntax("echo';id'", 'linux', gitBash)).toBe(false);
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
  ])('refuses a single quote under %s', (file) => {
    expect(hasCompoundShellSyntax("git log 'x'", 'win32', { kind: 'bash', file })).toBe(true);
  });

  it('still reads a Git Bash outside a system directory as Git Bash', () => {
    for (const file of [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:/Program Files/Git/usr/bin/bash.exe',
      'D:\\tools\\Windows Kits\\bash.exe',
    ]) {
      expect(hasCompoundShellSyntax("git log 'x'", 'win32', { kind: 'bash', file }), file).toBe(
        false,
      );
    }
  });
});
