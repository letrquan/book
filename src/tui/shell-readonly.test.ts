import { describe, expect, it } from 'vitest';
import {
  classifyReadOnlyShellCommand,
  shellCommandPaths,
  type ReadOnlyShellPart,
} from './shell-readonly.js';

const accepted: Array<[string, ReadOnlyShellPart[]]> = [
  ['cat src/a.js', [{ kind: 'read', path: 'src/a.js' }]],
  ['head -n 40 src/a.js', [{ kind: 'read', path: 'src/a.js' }]],
  ['tail -n +5 src/a.js', [{ kind: 'read', path: 'src/a.js' }]],
  ['sed -n 1,40p src/a.js', [{ kind: 'read', path: 'src/a.js' }]],
  ["sed -n -e '5p' src/a.js", [{ kind: 'read', path: 'src/a.js' }]],
  ['rg TODO src', [{ kind: 'search', query: 'TODO', path: 'src' }]],
  ["rg 'foo$' src", [{ kind: 'search', query: 'foo$', path: 'src' }]],
  ['rg -n -g "*.ts" TODO src', [{ kind: 'search', query: 'TODO', path: 'src' }]],
  ['rg -e foo -e bar src', [{ kind: 'search', query: 'foo', path: 'src' }]],
  ['rg --files src', [{ kind: 'list', path: 'src' }]],
  ['grep -rn "TODO" .', [{ kind: 'search', query: 'TODO', path: '.' }]],
  ['grep -rnA 3 TODO src', [{ kind: 'search', query: 'TODO', path: 'src' }]],
  ['grep -rn TODO src lib', [{ kind: 'search', query: 'TODO', path: 'src', extraPaths: ['lib'] }]],
  ["find src -name '*.ts'", [{ kind: 'search', query: '*.ts', path: 'src' }]],
  ['find src -type f', [{ kind: 'search', path: 'src' }]],
  ['fd foo src', [{ kind: 'search', query: 'foo', path: 'src' }]],
  ['ls -la src', [{ kind: 'list', path: 'src' }]],
  ['ls', [{ kind: 'list' }]],
  ['tree -L 2 src', [{ kind: 'list', path: 'src' }]],
  ['tree src', [{ kind: 'list', path: 'src' }]],
  ['pwd', [{ kind: 'list' }]],
  ['git status', [{ kind: 'list' }]],
  ['git diff --stat', [{ kind: 'list' }]],
  ['git diff -- src/a.js', [{ kind: 'list', path: 'src/a.js' }]],
  ['git log --oneline -5', [{ kind: 'list' }]],
  ['git show HEAD:src/a.js', [{ kind: 'list' }]],
  ['git branch -a', [{ kind: 'list' }]],
  ['git branch', [{ kind: 'list' }]],
  ['git ls-files', [{ kind: 'list' }]],
  ['git grep -n TODO -- src', [{ kind: 'search', query: 'TODO', path: 'src' }]],
  ['git blame -L 1,5 src/a.js', [{ kind: 'read', path: 'src/a.js' }]],
  ['rg TODO src | head -n 20', [{ kind: 'search', query: 'TODO', path: 'src' }]],
  [
    'cat a.js && cat b.js',
    [
      { kind: 'read', path: 'a.js' },
      { kind: 'read', path: 'b.js' },
    ],
  ],
  ['rg foo 2>/dev/null', [{ kind: 'search', query: 'foo' }]],
  ['rg foo 2>&1 | head', [{ kind: 'search', query: 'foo' }]],
  ['grep -c x a.js | wc -l', [{ kind: 'search', query: 'x', path: 'a.js' }]],
  ['git log --oneline | sort | uniq -c | tail -n 3', [{ kind: 'list' }]],
  ['rg x src | cut -d: -f1 | sort -u', [{ kind: 'search', query: 'x', path: 'src' }]],
  ['rg x src | tr a-z A-Z', [{ kind: 'search', query: 'x', path: 'src' }]],
  [
    'ls src ; ls lib',
    [
      { kind: 'list', path: 'src' },
      { kind: 'list', path: 'lib' },
    ],
  ],
  [
    'ls src || ls lib',
    [
      { kind: 'list', path: 'src' },
      { kind: 'list', path: 'lib' },
    ],
  ],
  ['cat "my file.txt"', [{ kind: 'read', path: 'my file.txt' }]],
  ['cat my\\ file.txt  ', [{ kind: 'read', path: 'my file.txt' }]],
  ['rg "a|b" src', [{ kind: 'search', query: 'a|b', path: 'src' }]],
];

const rejected: Array<[string, string]> = [
  ['redirect out', 'echo hi > out.txt'],
  ['redirect out of a reader', 'cat a > b'],
  ['redirect append', 'cat a >> b'],
  ['redirect in', 'cat < a'],
  ['heredoc', 'cat <<EOF'],
  ['herestring', 'cat <<< hi'],
  ['stderr to a file', 'rg x 2>err.txt'],
  ['fd duplication', 'rg x 1>&2'],
  ['ampersand redirect', 'rg x &> all.txt'],
  ['pipe stderr', 'rg x |& head'],
  ['command substitution', 'cat $(ls)'],
  ['backticks', 'cat `ls`'],
  ['variable', 'cat "$HOME/x"'],
  ['unquoted variable', 'cat $HOME'],
  ['process substitution', 'diff <(ls) <(ls)'],
  ['background', 'sleep 5 &'],
  ['background between commands', 'cat a & cat b'],
  ['env assignment', 'FOO=1 cat a'],
  ['sudo', 'sudo cat a'],
  ['doas', 'doas cat a'],
  ['env', 'env cat a'],
  ['xargs', 'xargs cat'],
  ['eval', 'eval ls'],
  ['exec', 'exec ls'],
  ['command', 'command ls'],
  ['nohup', 'nohup ls'],
  ['time', 'time ls'],
  ['watch', 'watch ls'],
  ['shell -c', "bash -c 'cat a'"],
  ['sh -c', "sh -c 'ls'"],
  ['python', "python3 -c 'print(1)'"],
  ['node', "node -e '1'"],
  ['perl', "perl -e '1'"],
  ['awk', "awk '{print}' a"],
  ['pager', 'less a'],
  ['editor', 'vim a'],
  ['cd', 'cd src'],
  ['source', 'source env.sh'],
  ['dot', '. env.sh'],
  ['sed in place', 'sed -i s/a/b/ a'],
  ['sed in place long', 'sed -n --in-place 1p a'],
  ['sed without -n', "sed 's/a/b/' a"],
  ['sed write command', "sed -n '1w out' a"],
  ['sed execute command', "sed -n '1e' a"],
  ['sed read command', "sed -n '1r x' a"],
  ['sed -e write', "sed -n -e '1w out' a"],
  ['sed without a file', 'sed -n 1,5p'],
  ['find delete', 'find . -delete'],
  ['find exec', 'find . -exec rm {} \\;'],
  ['find exec quoted', "find . -exec 'rm' ';'"],
  ['find execdir', "find . -execdir ls ';'"],
  ['find fprint', 'find . -fprint out.txt'],
  ['find ok', "find . -ok rm ';'"],
  ['fd exec', 'fd x -x rm'],
  ['fd exec batch', 'fd x -X rm'],
  ['rg pre', 'rg --pre ./x foo'],
  ['rg pre inline', 'rg --pre=./x foo'],
  ['rg search-zip', 'rg -z foo'],
  ['rg search-zip long', 'rg --search-zip foo'],
  ['rg patterns from a file', 'rg -f pats src'],
  ['git branch create', 'git branch new-branch'],
  ['git branch delete', 'git branch -d old'],
  ['git branch move', 'git branch -m a b'],
  ['git branch list with pattern', "git branch --list 'f*'"],
  ['git config option', 'git -c core.pager=x log'],
  ['git -C', 'git -C .. log'],
  ['git commit', 'git commit -m x'],
  ['git checkout', 'git checkout main'],
  ['git push', 'git push'],
  ['git diff output', 'git diff --output=x'],
  ['git diff output abbreviation', 'git diff --out=x'],
  ['git diff ext-diff', 'git diff --ext-diff'],
  ['git diff no-index', 'git diff --no-index /etc/a /etc/b'],
  ['git log output', 'git log --output x'],
  ['git show output', 'git show --output=x'],
  ['git outside path', 'git diff -- ../x'],
  ['git absolute path', 'git show /etc/passwd'],
  ['npm', 'npm test'],
  ['rm', 'rm -rf x'],
  ['touch', 'touch x'],
  ['echo', 'echo hi'],
  ['rm after ls', 'ls; rm x'],
  ['rm after &&', 'ls && rm x'],
  ['pipe into a shell', 'cat a.js | sh'],
  ['pipe into tee', 'rg x | tee out'],
  ['pipe into xargs', 'rg -l x | xargs rm'],
  ['tail follow', 'tail -f log'],
  ['tail follow cluster', 'tail -fn 5 log'],
  ['tail follow long', 'tail --follow=name log'],
  ['tail -F', 'tail -F log'],
  ['sort output', 'rg x | sort -o out'],
  ['sort output long', 'rg x | sort --output=out'],
  ['sort output abbreviation', 'rg x | sort --out=out'],
  ['sort with an operand', 'rg x | sort file'],
  ['uniq with an output file', 'rg x | uniq in out'],
  ['sort leading a command', 'sort a.js'],
  ['stdin reader alone', 'cat'],
  ['wc alone', 'wc -l'],
  ['multi-line', 'cat a\ncat b'],
  ['multi-line inside quotes', "rg 'a\nb' src"],
  ['cd then ls', 'cd src && ls'],
  ['empty', ''],
  ['whitespace', '   '],
  ['trailing connector', 'ls &&'],
  ['leading connector', '&& ls'],
  ['empty segment', 'ls ;; ls'],
  ['unterminated quote', "cat 'a"],
  ['unterminated double quote', 'cat "a'],
  ['subshell', '(ls)'],
  ['group', '{ ls; }'],
  ['brace expansion', 'cat {a,/etc/passwd}'],
  ['tilde', 'cat ~/.ssh/id_rsa'],
  ['comment', 'ls # hi'],
  ['path-qualified command', '/bin/cat a'],
  ['formatter with an escaping redirect lookalike', 'rg x a2>/dev/null'],
  ['tree output file', 'tree -o out.txt'],
  ['bat pager', 'bat --pager=x a'],
];

describe('classifyReadOnlyShellCommand', () => {
  it.each(accepted)('accepts %s', (command, parts) => {
    expect(classifyReadOnlyShellCommand(command)).toEqual(parts);
  });

  it.each(rejected)('rejects (%s) %s', (_label, command) => {
    expect(classifyReadOnlyShellCommand(command)).toBeUndefined();
  });

  it('treats single-quoted dollars and escaped dollars as literal text', () => {
    expect(classifyReadOnlyShellCommand("grep 'end$' a.js")).toEqual([
      { kind: 'search', query: 'end$', path: 'a.js' },
    ]);
    expect(classifyReadOnlyShellCommand('grep "end\\$" a.js')).toEqual([
      { kind: 'search', query: 'end$', path: 'a.js' },
    ]);
  });

  it('treats a connector inside quotes as part of the word', () => {
    expect(classifyReadOnlyShellCommand("rg 'a && rm x; b' src")).toEqual([
      { kind: 'search', query: 'a && rm x; b', path: 'src' },
    ]);
  });
});

describe('shellCommandPaths', () => {
  it('lists every path the parts name', () => {
    const parts = classifyReadOnlyShellCommand('cat a.js && grep -rn x src lib && ls docs')!;
    expect(shellCommandPaths(parts)).toEqual(['a.js', 'src', 'lib', 'docs']);
  });

  it('is empty when the command names no path', () => {
    expect(shellCommandPaths(classifyReadOnlyShellCommand('git status')!)).toEqual([]);
  });
});
