import { describe, expect, it } from 'vitest';
import {
  committerSigningIdentity,
  parseSigningConfig,
  signingPins,
  type SigningConfigEntry,
} from './git-signing.js';

const IDENT = 'Test <test@example.com> 1790626018 +0700';

/** Entries as `git config --show-scope` reports them: config order, lowest scope first. */
function entries(...list: (readonly [string, string] | readonly [string, string, string])[]) {
  return list.map(([scope, key, value = '']) => ({ scope, key, value }));
}

describe('parseSigningConfig', () => {
  it('reads the -z stream as scope, key, value, and takes a key without a value as true', () => {
    // The layout read off a real git: `scope\0key\nvalue\0`, and `scope\0key\0` for a key written
    // as a bare `[commit] gpgsign`, which git is about to read as a boolean.
    const stdout =
      'system\0gpg.ssh.allowedsignersfile\n/home/allowed\0' +
      'global\0commit.gpgsign\ntrue\0' +
      'local\0gpg.program\n/bin/evil\0' +
      'local\0commit.gpgsign\0';

    expect(parseSigningConfig(stdout)).toEqual([
      { scope: 'system', key: 'gpg.ssh.allowedsignersfile', value: '/home/allowed' },
      { scope: 'global', key: 'commit.gpgsign', value: 'true' },
      { scope: 'local', key: 'gpg.program', value: '/bin/evil' },
      { scope: 'local', key: 'commit.gpgsign', value: 'true' },
    ]);
  });

  it('keeps a value that contains newlines, and lower-cases the key git canonicalized', () => {
    expect(parseSigningConfig('global\0gpg.ssh.revocationfile\nline one\nline two\0')).toEqual([
      { scope: 'global', key: 'gpg.ssh.revocationfile', value: 'line one\nline two' },
    ]);
  });

  it('reads nothing at all as nothing at all', () => {
    expect(parseSigningConfig('')).toEqual([]);
  });
});

describe('signingPins', () => {
  it('pins nothing when only the operator has configured signing', () => {
    // The ordinary case: a checkout that says nothing about signing, and a commit that has to be
    // signed exactly as it was signed before any of this existed.
    expect(
      signingPins(
        entries(['global', 'commit.gpgsign', 'true'], ['global', 'gpg.program', '/usr/bin/gpg2']),
        IDENT,
      ),
    ).toEqual([]);
  });

  it('replaces a repository value with the operator’s, and never reads the repository’s as one', () => {
    // The repository's `gpg.program` is what would have been run; the operator's is what runs.
    // The `local` entry is the one that would have decided it, and it is not in the output.
    expect(
      signingPins(
        entries(
          ['global', 'gpg.program', '/usr/bin/gpg2'],
          ['local', 'gpg.program', '/tmp/evil.sh'],
        ),
        IDENT,
      ),
    ).toEqual([
      '-c',
      'gpg.program=gpg',
      '-c',
      'gpg.openpgp.program=gpg',
      '-c',
      'gpg.program=/usr/bin/gpg2',
      '-c',
      'gpg.openpgp.program=/usr/bin/gpg2',
    ]);
  });

  it('treats a worktree-scope value as a repository value, because a repository sets it', () => {
    // `config.worktree` is a file inside `.git`, and `extensions.worktreeConfig` is the switch that
    // makes git read it. The scope differs from `local`; where the value comes from does not.
    expect(signingPins(entries(['worktree', 'gpg.format', 'ssh']), IDENT)).toEqual([
      '-c',
      'gpg.format=openpgp',
    ]);
  });

  it('falls back to git’s built-in defaults when the operator has set nothing', () => {
    expect(
      signingPins(
        entries(
          ['local', 'commit.gpgsign', 'true'],
          ['local', 'gpg.program', '/tmp/evil.sh'],
          ['local', 'gpg.format', 'ssh'],
          ['local', 'gpg.x509.program', '/tmp/evil-x509.sh'],
          ['local', 'gpg.ssh.program', '/tmp/evil-ssh.sh'],
        ),
        IDENT,
      ),
    ).toEqual([
      '-c',
      'commit.gpgsign=false',
      '-c',
      'gpg.format=openpgp',
      '-c',
      'gpg.program=gpg',
      '-c',
      'gpg.openpgp.program=gpg',
      '-c',
      'gpg.x509.program=gpgsm',
      '-c',
      'gpg.ssh.program=ssh-keygen',
    ]);
  });

  it('gives the operator’s own value the last word, after the default it stands behind', () => {
    // The order git reads is the order of the arguments, and the last one wins: a `-c` that came
    // first would be the value in force, which is the opposite of what is wanted here.
    expect(
      signingPins(
        entries(['local', 'commit.gpgsign', 'true'], ['global', 'commit.gpgsign', 'true']),
        IDENT,
      ),
    ).toEqual(['-c', 'commit.gpgsign=false', '-c', 'commit.gpgsign=true']);
  });

  it('reads the last operator value for a key, in config order, across the operator’s scopes', () => {
    // `global` is reported before `local`, and `command` after it, so a later entry is the one
    // git itself would end up with — the same answer the pins have to give.
    expect(
      signingPins(
        entries(
          ['global', 'gpg.program', '/usr/bin/gpg2'],
          ['local', 'gpg.program', '/tmp/evil.sh'],
          ['command', 'gpg.program', '/usr/local/bin/gpg'],
        ),
        IDENT,
      ),
    ).toEqual([
      '-c',
      'gpg.program=gpg',
      '-c',
      'gpg.openpgp.program=gpg',
      '-c',
      'gpg.program=/usr/local/bin/gpg',
      '-c',
      'gpg.openpgp.program=/usr/local/bin/gpg',
    ]);
  });

  it('treats the two spellings of the program key as one setting', () => {
    // `gpg.openpgp.program` is the same setting as `gpg.program` and the later of the two wins in
    // git's own config, so the repository spelling either one of them is the same situation: both
    // are pinned, and to the same value, or the unpinned one would read the repository's value
    // straight back out of the same file.
    expect(
      signingPins(
        entries(
          ['global', 'gpg.openpgp.program', '/usr/bin/gpg2'],
          ['local', 'gpg.program', '/tmp/evil.sh'],
        ),
        IDENT,
      ),
    ).toEqual([
      '-c',
      'gpg.program=gpg',
      '-c',
      'gpg.openpgp.program=gpg',
      '-c',
      'gpg.program=/usr/bin/gpg2',
      '-c',
      'gpg.openpgp.program=/usr/bin/gpg2',
    ]);
  });

  it('neutralizes the ssh keys that have no default, including one it has never heard of', () => {
    // The three known ssh paths are read only to verify signatures, which a cherry-pick of an
    // agent's commit never does, and `defaultKeyCommand` is a command git would run. An empty
    // value is the honest pin for all of them: there is no default to fall back to, and an
    // unknown `gpg.*` key is exactly what a repository would add to reach a program.
    expect(
      signingPins(
        entries(
          ['local', 'gpg.ssh.defaultkeycommand', '/tmp/evil.sh'],
          ['local', 'gpg.ssh.allowedsignersfile', '/tmp/allowed'],
          ['local', 'gpg.ssh.revocationfile', '/tmp/revoked'],
          ['local', 'gpg.something.new', '/tmp/evil-new.sh'],
        ),
        IDENT,
      ),
    ).toEqual([
      '-c',
      'gpg.ssh.defaultkeycommand=',
      '-c',
      'gpg.ssh.allowedsignersfile=',
      '-c',
      'gpg.ssh.revocationfile=',
      '-c',
      'gpg.something.new=',
    ]);
  });

  it('keeps an operator value for an unknown key behind the empty one', () => {
    expect(
      signingPins(
        entries(
          ['global', 'gpg.something.new', '/usr/bin/something'],
          ['local', 'gpg.something.new', '/tmp/evil.sh'],
        ),
        IDENT,
      ),
    ).toEqual(['-c', 'gpg.something.new=', '-c', 'gpg.something.new=/usr/bin/something']);
  });

  it('signs openpgp with the committer identity when the repository picks the key', () => {
    // With no `user.signingKey` of the operator's, git's own default for openpgp is the committer
    // identity without the date, and an empty value would be no key at all. The repository's
    // choice of key is the one thing here that cannot be honored, and it is not honored.
    expect(
      signingPins(
        entries(
          ['local', 'user.signingkey', 'THE-REPOSITORYS-KEY'],
          ['global', 'commit.gpgsign', 'true'],
        ),
        IDENT,
      ),
    ).toEqual(['-c', 'user.signingkey=Test <test@example.com>']);
  });

  it('uses the operator’s key where they set one', () => {
    expect(
      signingPins(
        entries(
          ['local', 'user.signingkey', 'THE-REPOSITORYS-KEY'],
          ['global', 'user.signingkey', 'MY-KEY'],
        ),
        IDENT,
      ),
    ).toEqual(['-c', 'user.signingkey=Test <test@example.com>', '-c', 'user.signingkey=MY-KEY']);
  });

  it('leaves an ssh commit with no operator key to fail, rather than to guess one', () => {
    // Git will not look for a key of its own for ssh: it stops with "user.signingKey needs to be
    // set for ssh signing". An empty pin is that failure rather than a repository's key, and it
    // is the one signing shape the pins cannot carry across — an operator who relies on
    // `gpg.ssh.defaultKeyCommand` has to set `user.signingKey` globally to be unaffected by it.
    // `gpg.format` is the operator's own here, so it is not a repository key and is not pinned.
    expect(
      signingPins(
        entries(
          ['local', 'user.signingkey', 'THE-REPOSITORYS-KEY'],
          ['global', 'gpg.format', 'ssh'],
        ),
        IDENT,
      ),
    ).toEqual(['-c', 'user.signingkey=']);
  });

  it('ignores a repository’s format when it decides which key the operator would sign with', () => {
    // The format in force is the operator's, whatever the repository asked for, so the answer here
    // has to be the one that follows the pin rather than the one that follows `.git/config`: an
    // `x509` operator signing with the committer identity, not an `ssh` one with no key at all.
    expect(
      signingPins(
        entries(
          ['local', 'gpg.format', 'ssh'],
          ['local', 'user.signingkey', 'THE-REPOSITORYS-KEY'],
          ['global', 'gpg.format', 'x509'],
        ),
        IDENT,
      ),
    ).toEqual([
      '-c',
      'gpg.format=openpgp',
      '-c',
      'user.signingkey=Test <test@example.com>',
      '-c',
      'gpg.format=x509',
    ]);
  });
});

describe('committerSigningIdentity', () => {
  it('drops the date and the offset from the identity git reports', () => {
    expect(committerSigningIdentity(IDENT)).toBe('Test <test@example.com>');
    expect(committerSigningIdentity('Test <test@example.com> 1790626018 -0700\n')).toBe(
      'Test <test@example.com>',
    );
  });
});

describe('a repository value is never a source', () => {
  it('holds for both scopes git reports for a file a repository controls', () => {
    // The same three keys, once as the operator's configuration and once as the repository's own
    // and its worktree's, in both orders: a repository value that were ever treated as a source
    // would show up in the pins here as the value that stands behind the fallback.
    const operator: SigningConfigEntry[] = entries(
      ['global', 'commit.gpgsign', 'true'],
      ['global', 'gpg.program', '/usr/bin/gpg2'],
      ['global', 'user.signingkey', 'MY-KEY'],
    );
    const repository: SigningConfigEntry[] = entries(
      ['local', 'commit.gpgsign', 'false'],
      ['worktree', 'gpg.program', '/tmp/evil.sh'],
      ['local', 'user.signingkey', 'THE-REPOSITORYS-KEY'],
    );
    const fromRepositoryAlone = signingPins(repository, IDENT);
    const fromBoth = signingPins([...operator, ...repository], IDENT);

    expect(fromRepositoryAlone).toEqual([
      '-c',
      'commit.gpgsign=false',
      '-c',
      'gpg.program=gpg',
      '-c',
      'gpg.openpgp.program=gpg',
      '-c',
      'user.signingkey=Test <test@example.com>',
    ]);
    expect(fromBoth).toEqual([
      '-c',
      'commit.gpgsign=false',
      '-c',
      'gpg.program=gpg',
      '-c',
      'gpg.openpgp.program=gpg',
      '-c',
      'user.signingkey=Test <test@example.com>',
      '-c',
      'commit.gpgsign=true',
      '-c',
      'gpg.program=/usr/bin/gpg2',
      '-c',
      'gpg.openpgp.program=/usr/bin/gpg2',
      '-c',
      'user.signingkey=MY-KEY',
    ]);
    // Every value in the first is a default or a derived identity, and every value in the second
    // half of the second list is the operator's own.
    expect(fromBoth.join('\n')).not.toContain('/tmp/evil.sh');
    expect(fromBoth.join('\n')).not.toContain('THE-REPOSITORYS-KEY');
  });
});
