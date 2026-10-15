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
  ['tail -n 5 a', [{ kind: 'read', path: 'a' }]],
  ['tail -n5 a', [{ kind: 'read', path: 'a' }]],
  ['cat src/*.ts', [{ kind: 'read', path: 'src/*.ts' }]],
  ['bat --paging=never a.js', [{ kind: 'read', path: 'a.js' }]],
  ['bat --paging never a.js', [{ kind: 'read', path: 'a.js' }]],
  ['rg --ignore-file .ignore foo', [{ kind: 'search', query: 'foo', path: '.ignore' }]],
  ['rg -f pats src', [{ kind: 'search', path: 'src', extraPaths: ['pats'] }]],
  ['fd --ignore-file .fdignore foo', [{ kind: 'search', query: 'foo', path: '.fdignore' }]],
  ['fd --search-path src foo', [{ kind: 'search', query: 'foo', path: 'src' }]],
  ['find src -newer a.js', [{ kind: 'search', path: 'src', extraPaths: ['a.js'] }]],
  [
    'file -m magic.mgc a.bin',
    [
      { kind: 'read', path: 'a.bin' },
      { kind: 'read', path: 'magic.mgc' },
    ],
  ],
  ['du --exclude=node_modules src', [{ kind: 'list', path: 'src' }]],
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
  ['rg x src | sort | uniq -c | tail -n 3', [{ kind: 'search', query: 'x', path: 'src' }]],
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
  // Read-only git, with `-C <dir>` and the pager options accepted before the subcommand.
  ['git status', [{ kind: 'lookup', target: 'git status' }]],
  ['git -C src status', [{ kind: 'lookup', target: 'git status', path: 'src' }]],
  ['git --no-pager log --oneline -5', [{ kind: 'lookup', target: 'git log' }]],
  ['git -P --no-optional-locks status', [{ kind: 'lookup', target: 'git status' }]],
  ['git diff HEAD~1 -- src/a.js', [{ kind: 'lookup', target: 'git diff', path: 'src/a.js' }]],
  ['git diff --stat', [{ kind: 'lookup', target: 'git diff' }]],
  ['git diff --exit-code', [{ kind: 'lookup', target: 'git diff' }]],
  ['git log main..feature', [{ kind: 'lookup', target: 'git log' }]],
  ['git log -n 5 --author=me', [{ kind: 'lookup', target: 'git log' }]],
  ["git log '--format=%h %s'", [{ kind: 'lookup', target: 'git log' }]],
  ["git log '--pretty=format:%h %an'", [{ kind: 'lookup', target: 'git log' }]],
  ['git log --pretty=oneline', [{ kind: 'lookup', target: 'git log' }]],
  ["git show '--format=%H'", [{ kind: 'lookup', target: 'git show' }]],
  ['git show HEAD:src/a.js', [{ kind: 'lookup', target: 'git show', path: 'src/a.js' }]],
  ['git show', [{ kind: 'lookup', target: 'git show' }]],
  ['git branch', [{ kind: 'lookup', target: 'git branch' }]],
  ['git branch -a', [{ kind: 'lookup', target: 'git branch' }]],
  ['git branch -r -vv', [{ kind: 'lookup', target: 'git branch' }]],
  ['git branch --show-current', [{ kind: 'lookup', target: 'git branch' }]],
  ['git branch --contains HEAD~2', [{ kind: 'lookup', target: 'git branch' }]],
  ['git branch --merged', [{ kind: 'lookup', target: 'git branch' }]],
  ['git branch --no-merged main', [{ kind: 'lookup', target: 'git branch' }]],
  ['git branch --sort=-committerdate', [{ kind: 'lookup', target: 'git branch' }]],
  ["git branch --format='%(refname)'", [{ kind: 'lookup', target: 'git branch' }]],
  ["git branch --list 'f*'", [{ kind: 'lookup', target: 'git branch' }]],
  ['git branch -a --list feature/*', [{ kind: 'lookup', target: 'git branch' }]],
  ['git grep -n TODO src', [{ kind: 'search', query: 'TODO', path: 'src' }]],
  ['git grep -n -A 3 TODO -- src', [{ kind: 'search', query: 'TODO', path: 'src' }]],
  ['git grep -e foo -e bar', [{ kind: 'search', query: 'foo' }]],
  ['git ls-files', [{ kind: 'list' }]],
  ['git ls-files src', [{ kind: 'list', path: 'src' }]],
  ['git status | head -5', [{ kind: 'lookup', target: 'git status' }]],
  ['git log --oneline | sort | uniq -c | tail -n 3', [{ kind: 'lookup', target: 'git log' }]],
  [
    'git status && git log -1',
    [
      { kind: 'lookup', target: 'git status' },
      { kind: 'lookup', target: 'git log' },
    ],
  ],
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
  // Read-only git folds, but only the listed subcommands and global options; the rest keeps its row.
  ['git rev-parse', 'git rev-parse HEAD'],
  ['git blame', 'git blame -L 1,5 src/a.js'],
  ['git branch create', 'git branch new-feature'],
  ['git branch create with -a', 'git branch -a new-feature'],
  ['git branch delete', 'git branch -d old'],
  ['git branch force delete', 'git branch -D old'],
  ['git branch move', 'git branch -m a b'],
  ['git branch move capital', 'git branch -M a b'],
  ['git branch copy', 'git branch -c a b'],
  ['git branch copy long', 'git branch --copy a b'],
  ['git branch delete long', 'git branch --delete old'],
  ['git branch delete abbreviation', 'git branch --del old'],
  ['git branch delete in a cluster', 'git branch -vd old'],
  ['git branch set upstream', 'git branch --set-upstream-to=origin/main'],
  ['git branch set upstream short', 'git branch -u origin/main'],
  ['git branch unset upstream', 'git branch --unset-upstream'],
  ['git branch edit description', 'git branch --edit-description'],
  ['git branch force', 'git branch -f main HEAD~1'],
  ['git branch track', 'git branch --track x origin/x'],
  ['git branch no-track', 'git branch --no-track'],
  ['git branch pattern without --list', 'git branch -a feature'],
  ['git config option', 'git -c core.pager=x log'],
  ['git config-env option', 'git --config-env=core.pager=X log'],
  ['git exec-path', 'git --exec-path=/tmp status'],
  ['git exec-path bare', 'git --exec-path status'],
  ['git git-dir', 'git --git-dir=/x status'],
  ['git work-tree', 'git --work-tree=/x status'],
  ['git namespace', 'git --namespace=x status'],
  ['git super-prefix', 'git --super-prefix=x/ status'],
  ['git -C without a directory', 'git -C'],
  ['git -C attached', 'git -Csrc status'],
  ['git no subcommand', 'git'],
  ['git only options', 'git --no-pager'],
  ['git commit', 'git commit -m x'],
  ['git checkout', 'git checkout main'],
  ['git push', 'git push'],
  ['git pull', 'git pull'],
  ['git stash list', 'git stash list'],
  ['git config', 'git config user.name'],
  ['git alias', 'git st'],
  ['git redirect', 'git status > out.txt'],
  ['git substitution', 'git log $(cat f)'],
  ['git background', 'git status &'],
  ['git diff output', 'git diff --output=/tmp/x'],
  ['git diff output separate', 'git diff --output /tmp/x'],
  ['git diff output abbreviation', 'git diff --out=x'],
  ['git log format with a signature placeholder', 'git log --format=%G?'],
  ['git log format with the signer', "git log '--pretty=format:%GS'"],
  ['git log tformat with a signature placeholder', "git log '--format=tformat:%h %GK'"],
  ['git log pretty with a signature placeholder', "git log '--pretty=%GG'"],
  ['git log format with a later signature placeholder', "git log '--format=%h %s %GP'"],
  ['git show format with a signature placeholder', "git show '--format=%GT'"],
  ['git show pretty with a signature placeholder', "git show '--pretty=format:%GF'"],
  ['git branch format with a %G placeholder', "git branch '--format=%G?'"],
  ['git branch format with a signature atom', "git branch '--format=%(signature)'"],
  ['git branch format with a signature atom, separate', "git branch --format '%(signature:grade)'"],
  ['git diff orderfile', 'git diff -O/tmp/order'],
  ['git diff ext-diff', 'git diff --ext-diff'],
  ['git log output', 'git log --output=x'],
  ['git log output after a path', 'git log --oneline --output x'],
  ['git show output', 'git show --output=x'],
  ['git status output', 'git status --output=x'],
  ['git grep open in pager', 'git grep -O TODO'],
  ['git grep open in pager attached', 'git grep -Oless TODO'],
  ['git grep open in pager in a cluster', 'git grep -nO TODO'],
  ['git grep open in pager long', 'git grep --open-files-in-pager=less TODO'],
  ['git pathspec magic', "git diff -- ':(top)x'"],
  ['git pathspec exclude', "git log -- ':!node_modules'"],
  ['git show index blob', 'git show :0:src/a.js'],
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
  ['tail obsolete follow', 'tail +1f a'],
  ['tail + operand', 'tail +5 a'],
  ['tail follow with a count', 'tail -5f a'],
  ['tail follow after -n', 'tail -nf a'],
  ['tail follow as a formatter', 'rg x | tail -5f'],
  ['tail plus operand as a formatter', 'rg x | tail +1f'],
  ['du files0-from', 'du --files0-from=/etc/x'],
  ['du files0-from abbreviation', 'du --files0=x'],
  ['du exclude-from', 'du -X pats'],
  ['du exclude-from long', 'du --exclude-from=pats'],
  ['find files0-from', 'find . -files0-from list'],
  ['find -D leading', 'find -D tree /etc -name x'],
  ['fd list details', 'fd -l foo'],
  ['file files-from', 'file -f list'],
  ['file files-from long', 'file --files-from=list'],
  ['grep file', 'grep -f pats src'],
  ['grep file long', 'grep --file=pats src'],
  ['tree fromfile', 'tree --fromfile list'],
  ['sort files0-from', 'rg x | sort --files0-from=f'],
  ['sort temporary directory', 'rg x | sort -T /tmp'],
  ['sort temporary directory long', 'rg x | sort --temporary-directory=/tmp'],
  ['sort random source', 'rg x | sort --random-source=/dev/zero'],
  ['glob dot star', 'cat .*/secret'],
  ['glob dot bracket', 'cat .[.]/x'],
  ['glob dot question', 'ls .?'],
  ['glob dot star alone', 'ls .*'],
  ['glob of bracket dots', 'cat [.][.]/x'],
  ['glob star segment', 'ls */x'],
  ['glob question segment', 'cat src/?/a'],
  ['glob in a search path', 'rg x .*/src'],
  ['bat paging always', 'bat --paging=always a'],
  ['bat paging auto', 'bat --paging=auto a'],
  ['bat paging separate', 'bat --paging always a'],
  ['bat paging abbreviation', 'bat --pag=auto a'],
  ['bat pager long', 'bat --pager less a'],
  ['bat generate config', 'bat --generate-config-file'],
  ['batcat pager', 'batcat --pager=less a'],
  ['ack', 'ack foo src'],
  ['ack pager', 'ack --pager=less foo'],
  ['ag pager', 'ag --pager less foo'],
  ['ag pager inline', 'ag --pager=less foo'],
  ['ag path-to-ignore', 'ag -p /etc/x foo'],
  ['ag file names only', 'ag -g foo /etc'],
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
    expect(shellCommandPaths(classifyReadOnlyShellCommand('ls')!)).toEqual([]);
  });

  it('counts the value of an option that names a file', () => {
    expect(
      shellCommandPaths(classifyReadOnlyShellCommand('rg --ignore-file .ignore foo src')!),
    ).toEqual(['src', '.ignore']);
    expect(shellCommandPaths(classifyReadOnlyShellCommand('file -m a:b c')!)).toEqual([
      'c',
      'a:b',
      'a',
      'b',
    ]);
  });
});

describe('git paths', () => {
  const pathsOf = (command: string) => shellCommandPaths(classifyReadOnlyShellCommand(command)!);

  it('reports the directory of -C', () => {
    expect(pathsOf('git -C ../other status')).toEqual(['../other']);
  });

  it('resolves a later -C against the earlier one', () => {
    expect(pathsOf('git -C a -C ../b status')).toEqual(['a', 'b']);
    expect(pathsOf('git -C a -C /abs status')).toEqual(['a', '/abs']);
  });

  it('reports pathspecs after --', () => {
    expect(pathsOf('git diff -- ../outside')).toEqual(['../outside']);
    expect(pathsOf('git log -- src/a.js lib/b.js')).toEqual(['src/a.js', 'lib/b.js']);
  });

  it('reports the operands of diff --no-index', () => {
    expect(pathsOf('git diff --no-index /etc/a /etc/b')).toEqual(['/etc/a', '/etc/b']);
  });

  it('reports path operands of ls-files and grep', () => {
    expect(pathsOf('git ls-files ../x')).toEqual(['../x']);
    expect(pathsOf('git grep TODO ../x')).toEqual(['../x']);
    // With `-f` there is no pattern operand, so every operand is ambiguous: a path.
    expect(pathsOf('git grep -f ../pats src')).toEqual(['src', '../pats']);
    expect(pathsOf('git ls-files -X ../ignore')).toEqual(['../ignore']);
  });

  it('resolves the operands against the -C directory', () => {
    expect(pathsOf('git -C src diff -- a.js')).toEqual(['src', 'src/a.js']);
    expect(pathsOf('git -C src diff -- ../../x')).toEqual(['src', '../x']);
  });

  it('reports the path half of a <rev>:<path> operand, so a climb past the workspace shows', () => {
    // The `HEAD:..` segment must not cancel one `..` of the path: git reads the path from the
    // current directory, not from the revision.
    expect(pathsOf('git show HEAD:../../secret')).toEqual(['../../secret']);
    expect(pathsOf('git show HEAD:../secret')).toEqual(['../secret']);
    expect(pathsOf('git diff HEAD~1:../../a')).toEqual(['../../a']);
    expect(pathsOf('git grep foo HEAD:../..')).toEqual(['../..']);
    expect(pathsOf('git show HEAD:src/a.js')).toEqual(['src/a.js']);
    expect(pathsOf('git -C src show HEAD:a.js')).toEqual(['src', 'src/a.js']);
    expect(pathsOf('git show HEAD:')).toEqual([]);
  });

  it('counts the file of --orderfile as a path', () => {
    expect(pathsOf('git diff --orderfile=/etc/passwd')).toEqual(['/etc/passwd']);
    expect(pathsOf('git diff --orderfile /etc/passwd')).toEqual(['/etc/passwd']);
    expect(pathsOf('git log --orderfile=../order -p')).toEqual(['../order']);
    expect(pathsOf('git show --orderfile ../order')).toEqual(['../order']);
    expect(pathsOf('git -C src diff --orderfile=order')).toEqual(['src', 'src/order']);
  });

  it('does not report revision operands', () => {
    expect(pathsOf('git log HEAD~2')).toEqual([]);
    expect(pathsOf('git log main..feature')).toEqual([]);
    expect(pathsOf('git diff abc1234 HEAD')).toEqual([]);
    expect(pathsOf('git show HEAD:src/a.js')).toEqual(['src/a.js']);
    expect(pathsOf('git show HEAD:../x')).toEqual(['../x']);
  });

  it('treats an ambiguous operand as a path', () => {
    expect(pathsOf('git diff main')).toEqual(['main']);
    expect(pathsOf('git diff /etc/passwd')).toEqual(['/etc/passwd']);
  });

  it('refuses a glob that could reach the parent', () => {
    expect(classifyReadOnlyShellCommand("git ls-files '.*/x'")).toBeUndefined();
    expect(classifyReadOnlyShellCommand("git -C '.*' status")).toBeUndefined();
  });
});
