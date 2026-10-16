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
    `git commit -m 'say "hi" $(x) \`y\` \\'`,
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
    expect(linux("git log 'a\\'")).toBe(false);
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

  it('reads a single quote as an ordinary character on win32', () => {
    expect(win("git stash show 'stash@{0}'")).toBe(true);
    expect(win("git commit -m 'x & del *'")).toBe(true);
    expect(win("git log it's")).toBe(false);
    expect(win('git log "@{upstream}"')).toBe(false);
    expect(win('git commit -m "fix(x): y"')).toBe(false);
    expect(win('git commit -m "it\'s"')).toBe(false);
    expect(linux("git stash show 'stash@{0}'")).toBe(false);
  });
});
