import { describe, expect, it } from 'vitest';
import {
  canonicalConfigKey,
  committerSigningIdentity,
  parseSigningConfig,
  readSigningConfig,
  signingFacts,
  signingKeySource,
  signingPinArgs,
  signingPins,
  type HardenedRunner,
  type RunOptions,
  type RunResult,
  type SigningConfigEntry,
} from './git-signing.js';

const IDENT = 'Test <test@example.com> 1790626018 +0700';

/** The pins every apply carries, whatever the repository configured, in the order they are read. */
const ALWAYS_PINNED = [
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
  '-c',
  'gpg.ssh.defaultkeycommand=',
  '-c',
  'gpg.ssh.allowedsignersfile=',
  '-c',
  'gpg.ssh.revocationfile=',
];

/**
 * Entries as `git config --show-scope` reports them: config order, lowest scope first.
 *
 * The keys go through the same canonicalization the parser's do, because these fixtures stand in
 * for git's output and a key spelled the way a person writes it — `user.signingKey` — is not a key
 * git ever reports, so a pin computed against one would be measuring the fixture rather than the
 * behavior. A key mis-cased on purpose is unaffected, since what git keeps is the subsection's
 * case.
 */
function entries(...list: (readonly [string, string] | readonly [string, string, string])[]) {
  return list.map(([scope, key, value = '']) => ({ scope, key: canonicalConfigKey(key), value }));
}

/** The `-z` stream git would print for these entries. */
function stream(...list: (readonly [string, string] | readonly [string, string, string])[]) {
  return entries(...list)
    .map((entry) => `${entry.scope}\0${entry.key}\n${entry.value}\0`)
    .join('');
}

/**
 * A runner that answers a short script of calls, so the reads that cost a process each can be
 * tested without one. Anything not scripted throws rather than quietly answering nothing.
 */
function scriptedRunner(responses: {
  config?: RunResult;
  version?: RunResult;
  identity?: RunResult;
  keyCommand?: (command: string, args: string[]) => RunResult;
  failOn?: (command: string, args: string[]) => string | undefined;
}): { run: HardenedRunner; calls: { command: string; args: string[]; options: RunOptions }[] } {
  const calls: { command: string; args: string[]; options: RunOptions }[] = [];
  const run: HardenedRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    const failure = responses.failOn?.(command, args);
    if (failure) throw new Error(failure);
    if (args[0] === 'config' && args[1] === '--show-scope') {
      return responses.config ?? { stdout: '', stderr: '', code: 1 };
    }
    if (args[0] === '--version') return responses.version ?? { stdout: '', stderr: '', code: 0 };
    if (args[0] === 'var') {
      return responses.identity ?? { stdout: `${IDENT}\n`, stderr: '', code: 0 };
    }
    if (responses.keyCommand) return responses.keyCommand(command, args);
    throw new Error(`unexpected call: ${command} ${args.join(' ')}`);
  };
  return { run, calls };
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

  it('keeps a value that contains newlines', () => {
    expect(parseSigningConfig('global\0gpg.ssh.revocationfile\nline one\nline two\0')).toEqual([
      { scope: 'global', key: 'gpg.ssh.revocationfile', value: 'line one\nline two' },
    ]);
  });

  it('reads nothing at all as nothing at all', () => {
    expect(parseSigningConfig('')).toEqual([]);
  });
});

describe('canonicalConfigKey', () => {
  it('folds the section and the variable name but keeps a subsection verbatim', () => {
    // Git does exactly this, and the difference is not cosmetic: `gpg.SSH.program` is not a key git
    // reads for ssh signing, so folding it would invent a value the operator never set.
    expect(canonicalConfigKey('commit.GPGSign')).toBe('commit.gpgsign');
    expect(canonicalConfigKey('gpg.Program')).toBe('gpg.program');
    expect(canonicalConfigKey('gpg.ssh.defaultKeyCommand')).toBe('gpg.ssh.defaultkeycommand');
    expect(canonicalConfigKey('GPG.SSH.PROGRAM')).toBe('gpg.SSH.program');
    // A subsection may itself contain dots; only the section in front of the first one is folded.
    expect(canonicalConfigKey('gpg.a.b.program')).toBe('gpg.a.b.program');
  });

  it('treats a mis-cased subsection as an unknown key, neutralized rather than honored', () => {
    const pins = signingPins(entries(['local', 'gpg.SSH.program', '/tmp/evil.sh']), {
      committerIdent: IDENT,
      sshDefaultKey: '',
    });
    expect(pins).toContain('gpg.SSH.program=');
    // The key git actually uses is untouched: no repository set it, and the mis-cased one is
    // never a source of an operator's value for it.
    expect(signingPins(entries(['global', 'gpg.SSH.program', '/usr/bin/mine']))).toEqual(
      ALWAYS_PINNED,
    );
  });
});

describe('signingPins', () => {
  it('pins every program and format key whatever the repository configured', () => {
    // A checkout that says nothing about signing still gets the whole list. Safety cannot rest on
    // the read having been complete and on the configuration not having changed between the read
    // and the cherry-pick, and a pin whose last value is the operator's own costs nothing: it is
    // the configuration they already had.
    expect(signingPins(entries())).toEqual(ALWAYS_PINNED);
  });

  it('gives the operator’s own value the last word, after the default it stands behind', () => {
    expect(
      signingPins(
        entries(['global', 'commit.gpgSign', 'true'], ['global', 'gpg.program', '/usr/bin/gpg2']),
      ),
    ).toEqual([
      ...ALWAYS_PINNED,
      '-c',
      'commit.gpgsign=true',
      '-c',
      'gpg.program=/usr/bin/gpg2',
      '-c',
      'gpg.openpgp.program=/usr/bin/gpg2',
    ]);
  });

  it('replaces a repository value with the operator’s, and never reads the repository’s as one', () => {
    expect(
      signingPins(
        entries(
          ['global', 'gpg.program', '/usr/bin/gpg2'],
          ['local', 'gpg.program', '/tmp/evil.sh'],
        ),
      ),
    ).toEqual([
      ...ALWAYS_PINNED,
      '-c',
      'gpg.program=/usr/bin/gpg2',
      '-c',
      'gpg.openpgp.program=/usr/bin/gpg2',
    ]);
  });

  it('treats a worktree-scope value as a repository value, because a repository sets it', () => {
    // `config.worktree` is a file inside `.git`, and `extensions.worktreeConfig` is the switch that
    // makes git read it. The scope differs from `local`; where the value comes from does not.
    expect(signingFacts(entries(['worktree', 'gpg.format', 'ssh'])).repositoryKeys).toEqual(
      new Set(['gpg.format']),
    );
    expect(signingPins(entries(['worktree', 'gpg.format', 'ssh']))).toEqual(ALWAYS_PINNED);
  });

  it('reads the last operator value for a key, in config order', () => {
    // `command` is reported after the repository's own files, so a later entry is the one git
    // itself would end up with — the same answer the pins have to give.
    expect(
      signingPins(
        entries(
          ['global', 'gpg.program', '/usr/bin/gpg2'],
          ['local', 'gpg.program', '/tmp/evil.sh'],
          ['command', 'gpg.program', '/usr/local/bin/gpg'],
        ),
      ),
    ).toEqual([
      ...ALWAYS_PINNED,
      '-c',
      'gpg.program=/usr/local/bin/gpg',
      '-c',
      'gpg.openpgp.program=/usr/local/bin/gpg',
    ]);
  });

  it('takes the last of the two program spellings in config order, whichever it is', () => {
    // Git stores the two spellings in one slot and reads whichever was written last, so a lookup
    // that preferred `gpg.program` would hand back the wrong one of these two arrangements.
    expect(
      signingPins(
        entries(['global', 'gpg.openpgp.program', '/first'], ['global', 'gpg.program', '/second']),
      ),
    ).toEqual([...ALWAYS_PINNED, '-c', 'gpg.program=/second', '-c', 'gpg.openpgp.program=/second']);
    expect(
      signingPins(
        entries(['global', 'gpg.program', '/second'], ['global', 'gpg.openpgp.program', '/first']),
      ),
    ).toEqual([...ALWAYS_PINNED, '-c', 'gpg.program=/first', '-c', 'gpg.openpgp.program=/first']);
  });

  it('neutralizes an unknown gpg.* key a repository sets, whatever it is called', () => {
    // The three ssh paths are already pinned empty by every apply, and the operator's value stands
    // after them; an unknown key is exactly what a repository would add to reach a program.
    expect(signingPins(entries(['local', 'gpg.something.new', '/tmp/evil-new.sh']))).toEqual([
      ...ALWAYS_PINNED,
      '-c',
      'gpg.something.new=',
    ]);
    expect(
      signingPins(
        entries(
          ['global', 'gpg.something.new', '/usr/bin/mine'],
          ['local', 'gpg.something.new', '/tmp/evil.sh'],
        ),
      ),
    ).toEqual([
      ...ALWAYS_PINNED,
      '-c',
      'gpg.something.new=',
      '-c',
      'gpg.something.new=/usr/bin/mine',
    ]);
    expect(
      signingPins(
        entries(
          ['local', 'gpg.ssh.defaultKeyCommand', '/tmp/evil.sh'],
          ['global', 'gpg.ssh.defaultKeyCommand', 'ssh-add -L'],
        ),
      ),
    ).toContain('gpg.ssh.defaultkeycommand=ssh-add -L');
  });
});

describe('the user.signingkey pin', () => {
  const inputs = { committerIdent: IDENT, sshDefaultKey: '' };

  it('is pinned only when a repository sets one', () => {
    expect(signingPins(entries(['global', 'user.signingKey', 'MY-KEY']))).toEqual(ALWAYS_PINNED);
  });

  it('uses the operator’s key where they set one', () => {
    expect(
      signingPins(
        entries(['local', 'user.signingKey', 'REPO-KEY'], ['global', 'user.signingKey', 'MY-KEY']),
        inputs,
      ),
    ).toEqual([...ALWAYS_PINNED, '-c', 'user.signingkey=', '-c', 'user.signingkey=MY-KEY']);
  });

  it('signs openpgp with the committer identity when the repository picks the key', () => {
    // With no `user.signingKey` of the operator's, git's own default for openpgp is the committer
    // identity without the date, and an empty value would be no key at all.
    expect(
      signingPins(
        entries(['local', 'user.signingKey', 'REPO-KEY'], ['global', 'commit.gpgSign', 'true']),
        inputs,
      ),
    ).toEqual([
      ...ALWAYS_PINNED,
      '-c',
      'user.signingkey=Test <test@example.com>',
      '-c',
      'commit.gpgsign=true',
    ]);
  });

  it('is empty when signing is effectively off, because git never reads it then', () => {
    expect(signingPins(entries(['local', 'user.signingKey', 'REPO-KEY']), inputs)).toEqual([
      ...ALWAYS_PINNED,
      '-c',
      'user.signingkey=',
    ]);
  });

  it('uses the key the operator’s own ssh key command produced', () => {
    const key = 'key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey fake';
    expect(
      signingPins(
        entries(
          ['local', 'user.signingKey', 'REPO-KEY'],
          ['global', 'commit.gpgSign', 'true'],
          ['global', 'gpg.format', 'ssh'],
          ['global', 'gpg.ssh.defaultKeyCommand', 'ssh-add -L'],
        ),
        { committerIdent: IDENT, sshDefaultKey: key },
      ),
    ).toEqual([
      ...ALWAYS_PINNED,
      '-c',
      `user.signingkey=${key}`,
      '-c',
      'commit.gpgsign=true',
      '-c',
      'gpg.format=ssh',
      '-c',
      'gpg.ssh.defaultkeycommand=ssh-add -L',
    ]);
  });

  it('is empty for an ssh operator with neither a key nor a key command', () => {
    // The one shape the pins cannot carry across: there is no key to carry, and a repository's is
    // not one to borrow. An empty pin is git's own "user.signingKey needs to be set for ssh
    // signing", which fails the apply rather than signing with what the repository asked for.
    expect(
      signingPins(
        entries(
          ['local', 'user.signingKey', 'REPO-KEY'],
          ['global', 'commit.gpgSign', 'true'],
          ['global', 'gpg.format', 'ssh'],
        ),
        inputs,
      ),
    ).toEqual([
      ...ALWAYS_PINNED,
      '-c',
      'user.signingkey=',
      '-c',
      'commit.gpgsign=true',
      '-c',
      'gpg.format=ssh',
    ]);
  });

  it('ignores a repository’s format when it decides where the key comes from', () => {
    // The format in force is the operator's, whatever the repository asked for: an `x509` operator
    // signing with the committer identity, not an `ssh` one with no key at all.
    const facts = signingFacts(
      entries(
        ['local', 'gpg.format', 'ssh'],
        ['local', 'user.signingKey', 'REPO-KEY'],
        ['global', 'gpg.format', 'x509'],
        ['global', 'commit.gpgSign', 'true'],
      ),
    );
    expect(signingKeySource(facts)).toBe('committer');
  });
});

describe('signingPinArgs', () => {
  it('reads the configuration, runs nothing else when it need not, and pins the rest', async () => {
    const { run, calls } = scriptedRunner({
      config: { stdout: stream(['global', 'commit.gpgSign', 'true']), stderr: '', code: 0 },
    });

    expect(await signingPinArgs('/repo', run)).toEqual([
      ...ALWAYS_PINNED,
      '-c',
      'commit.gpgsign=true',
    ]);
    // Neither `git var` nor a key command: a repository that sets no key has nothing to decide.
    expect(calls.map((call) => call.args[0])).toEqual(['config']);
  });

  it('asks git for the committer identity only when the pin needs it', async () => {
    const { run, calls } = scriptedRunner({
      config: {
        stdout: stream(
          ['local', 'user.signingKey', 'REPO-KEY'],
          ['global', 'commit.gpgSign', 'true'],
        ),
        stderr: '',
        code: 0,
      },
    });

    expect(await signingPinArgs('/repo', run)).toContain('user.signingkey=Test <test@example.com>');
    expect(calls.map((call) => call.args[0])).toEqual(['config', 'var']);
    expect(calls[1].options.timeoutMs).toBeGreaterThan(0);
  });

  it("runs the operator's ssh key command the way git does, with no shell", async () => {
    const key = 'key::ssh-ed25519 AAAA fake';
    const { run, calls } = scriptedRunner({
      config: {
        stdout: stream(
          ['local', 'user.signingKey', 'REPO-KEY'],
          ['global', 'commit.gpgSign', 'true'],
          ['global', 'gpg.format', 'ssh'],
          ['global', 'gpg.ssh.defaultKeyCommand', 'ssh-add -L -t ed25519'],
        ),
        stderr: '',
        code: 0,
      },
      keyCommand: (command, args) =>
        command === 'ssh-add' && args.join(' ') === '-L -t ed25519'
          ? { stdout: `${key}\n`, stderr: '', code: 0 }
          : { stdout: '', stderr: '', code: 1 },
    });

    expect(await signingPinArgs('/repo', run)).toContain(`user.signingkey=${key}`);
    // Split on whitespace with no shell, in the repository, bounded, with no stdin to wait on.
    const keyCall = calls.find((call) => call.command === 'ssh-add');
    expect(keyCall?.args).toEqual(['-L', '-t', 'ed25519']);
    expect(keyCall?.options.cwd).toBe('/repo');
    expect(keyCall?.options.timeoutMs).toBeGreaterThan(0);
    expect(keyCall?.options.input).toBeUndefined();
  });

  it('pins the key empty when the key command fails or prints something that is not a key', async () => {
    const configuration = stream(
      ['local', 'user.signingKey', 'REPO-KEY'],
      ['global', 'commit.gpgSign', 'true'],
      ['global', 'gpg.format', 'ssh'],
      ['global', 'gpg.ssh.defaultKeyCommand', 'ssh-add -L'],
    );
    const failing = scriptedRunner({
      config: { stdout: configuration, stderr: '', code: 0 },
      keyCommand: () => {
        throw new Error('ssh-add: exit 1');
      },
    });
    expect(await signingPinArgs('/repo', failing.run)).toContain('user.signingkey=');

    // Output without git's `key::` prefix is not a key, whatever else it says.
    const unprefixed = scriptedRunner({
      config: { stdout: configuration, stderr: '', code: 0 },
      keyCommand: () => ({ stdout: 'ssh-ed25519 AAAA fake\n', stderr: '', code: 0 }),
    });
    expect(await signingPinArgs('/repo', unprefixed.run)).toContain('user.signingkey=');
  });

  it('fails with the version when this git is too old for --show-scope', async () => {
    const { run, calls } = scriptedRunner({
      config: { stdout: '', stderr: "error: unknown option `show-scope'\n", code: 129 },
      version: { stdout: 'git version 2.20.3\n', stderr: '', code: 0 },
    });

    await expect(signingPinArgs('/repo', run)).rejects.toThrow(
      "Applying an agent's result needs git 2.26 or later (for `git config --show-scope`); this git is git version 2.20.3",
    );
    expect(calls.map((call) => call.args[0])).toEqual(['config', '--version']);
  });

  it('fails with the version when the usage error arrives under another exit code', async () => {
    const { run } = scriptedRunner({
      config: { stdout: '', stderr: "error: unknown option `show-scope'\n", code: 1 },
    });
    await expect(signingPinArgs('/repo', run)).rejects.toThrow('needs git 2.26 or later');
  });

  it('treats a read that failed as a failure, and pins nothing', async () => {
    // A `maxBuffer` overrun or a missing git arrives with no exit code at all. The runner rejects
    // it, and it is never resolved as the "no match" that exit 1 means: a signing read that
    // resolved on a truncated answer would pin nothing and hand the apply straight to whatever the
    // repository had configured.
    const { run, calls } = scriptedRunner({
      failOn: (command, args) =>
        args[0] === 'config' ? 'git failed: ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : undefined,
    });
    await expect(signingPinArgs('/repo', run)).rejects.toThrow('ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    expect(calls).toHaveLength(1);
  });

  it('accepts an empty configuration, which is what a repository that configures none reports', async () => {
    const { run } = scriptedRunner({ config: { stdout: '', stderr: '', code: 1 } });
    expect(await signingPinArgs('/repo', run)).toEqual(ALWAYS_PINNED);
  });
});

describe('readSigningConfig', () => {
  it('resolves exit 1 as the empty answer it is, and exit 0 as the answer', async () => {
    const nothing = scriptedRunner({ config: { stdout: '', stderr: '', code: 1 } });
    expect(await readSigningConfig('/repo', nothing.run)).toEqual([]);

    const something = scriptedRunner({
      config: { stdout: stream(['local', 'gpg.program', '/tmp/evil.sh']), stderr: '', code: 0 },
    });
    expect(await readSigningConfig('/repo', something.run)).toEqual([
      { scope: 'local', key: 'gpg.program', value: '/tmp/evil.sh' },
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
    // and its worktree's: a repository value that were ever treated as a source would show up in
    // the pins here as the value that stands behind the default.
    const operator: SigningConfigEntry[] = entries(
      ['global', 'commit.gpgsign', 'true'],
      ['global', 'gpg.program', '/usr/bin/gpg2'],
      ['global', 'user.signingkey', 'MY-KEY'],
    );
    const repository: SigningConfigEntry[] = entries(
      ['local', 'commit.gpgsign', 'false'],
      ['worktree', 'gpg.program', '/tmp/evil.sh'],
      ['local', 'user.signingkey', 'REPOSITORY-KEY'],
    );

    expect(signingPins(repository, { committerIdent: IDENT, sshDefaultKey: '' })).toEqual([
      ...ALWAYS_PINNED,
      // Empty, not the committer identity: nothing in the operator's own configuration asks for
      // signing, so the effective `commit.gpgSign` is off and git never reads a key for this
      // commit. Pinning a committer identity here would be a key for a commit that is not signed.
      '-c',
      'user.signingkey=',
    ]);
    const fromBoth = signingPins([...operator, ...repository], {
      committerIdent: IDENT,
      sshDefaultKey: '',
    });
    expect(fromBoth).toEqual([
      ...ALWAYS_PINNED,
      '-c',
      'user.signingkey=',
      '-c',
      'commit.gpgsign=true',
      '-c',
      'gpg.program=/usr/bin/gpg2',
      '-c',
      'gpg.openpgp.program=/usr/bin/gpg2',
      '-c',
      'user.signingkey=MY-KEY',
    ]);
    expect(fromBoth.join('\n')).not.toContain('/tmp/evil.sh');
    expect(fromBoth.join('\n')).not.toContain('REPOSITORY-KEY');
  });
});
