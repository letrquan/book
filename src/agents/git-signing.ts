import { execFile } from 'child_process';
import { buildChildEnv } from '../child-env.js';
import { hardenedGitArgs, hardenedGitEnv } from '../tools/git.js';

/**
 * What the cherry-pick that applies an agent's result is allowed to read as signing configuration
 * (#348).
 *
 * The decision here is the owner's: that commit lands in the operator's branch under their
 * committer identity, so it keeps signing exactly as they configured — but only from *their*
 * configuration. A checkout's `.git/config` is a file the checkout chooses, and it arrives with an
 * archive, a shared directory, or someone else's machine, so `commit.gpgSign` together with
 * `gpg.program = <anything>` is a way for a repository to have Book start a program while applying
 * an agent's work, with no prompt, in a flow nothing asked about. `hardenedGitArgs` closes the
 * routes that need a command of their own — hooks, `core.fsmonitor`, a diff driver — but a signing
 * program is named by configuration alone, so it needs this.
 *
 * The result is a list of `-c` overrides carried by the cherry-pick itself, which is where they
 * belong: git reads them in the same order it reads anything else, and the last one wins, so a
 * value the operator set is pinned *after* the value that would otherwise stand behind it. A key
 * the repository does not set is not pinned at all, and that commit is signed exactly as it was
 * before this existed.
 */

/** One `git config` entry, in the order git reported it. */
export interface SigningConfigEntry {
  /**
   * Git's own name for where the value came from: `system`, `global`, `local`, `worktree` or
   * `command`. An entry a repository pulled in with `include`/`includeIf` carries the scope of
   * the file that included it, so it is a repository value (checked on git 2.43).
   */
  scope: string;
  /** The canonical, lower-cased key: `gpg.ssh.program`. */
  key: string;
  /** The value, or `true` for a key written without one — `[commit] gpgsign` means what it says. */
  value: string;
}

/**
 * The keys to ask git about: every setting that names or chooses a signing program, plus every
 * `gpg.*` key whatever it is called, so that a key this file has never heard of is still seen and
 * neutralized rather than passed through.
 */
const SIGNING_KEY_PATTERN = '^(commit\\.gpgsign|gpg\\..*|user\\.signingkey)$';

/**
 * One hardened git call, run in the repository.
 *
 * It is not `git-isolation.ts`'s own `git()`: that module imports this one, and a helper both of
 * them imported would be a cycle the architecture check rejects. The argv and the environment are
 * the same ones that module builds — {@link hardenedGitArgs}, {@link hardenedGitEnv} merged into
 * Book's own environment — and this module makes one read-only call with no stdin, so the whole of
 * that function's `input` handling (#351) has no counterpart here.
 *
 * `allowExitCodes` is per call because it is per call that it means something: for
 * `git config --get-regexp`, exit 1 is git's "nothing matched" and is the ordinary case for a
 * repository that configures no signing at all, while for `git var` the same code is a failure to
 * produce the identity the pin is about to be built from.
 */
function git(cwd: string, args: string[], allowExitCodes: number[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      hardenedGitArgs(args),
      {
        cwd,
        env: buildChildEnv(process.env, hardenedGitEnv()),
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
        if (!error || allowExitCodes.includes(code)) resolve(stdout);
        else reject(new Error(stderr.trim() || error.message));
      },
    );
  });
}

/**
 * The signing configuration as git reports it, in config order: system, then global, then the
 * repository's own files in the order git read them, then `command`.
 */
export async function readSigningConfig(repoRoot: string): Promise<SigningConfigEntry[]> {
  // `--show-scope` is what makes this answerable at all — a repository's values and the
  // operator's values are in the same file format, and only the scope says which is which.
  return parseSigningConfig(
    await git(repoRoot, ['config', '--show-scope', '-z', '--get-regexp', SIGNING_KEY_PATTERN], [1]),
  );
}

/**
 * Parse `git config --show-scope -z --get-regexp` output.
 *
 * The `-z` layout, read off a real git, is a NUL-separated stream of pairs: the scope, then the
 * key, then the value — `scope\0key\nvalue\0` — and a key written without a value has neither the
 * newline nor the value, `scope\0key\0`, because git is about to read it as a boolean. A value may
 * itself contain newlines, so the key is what the first newline ends, and the rest is the value.
 */
export function parseSigningConfig(stdout: string): SigningConfigEntry[] {
  const fields = stdout.split('\0');
  const entries: SigningConfigEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const separator = fields[index + 1].indexOf('\n');
    entries.push({
      scope: fields[index].toLowerCase(),
      key: (separator === -1
        ? fields[index + 1]
        : fields[index + 1].slice(0, separator)
      ).toLowerCase(),
      // Git's own reading of a key with no value: a boolean true.
      value: separator === -1 ? 'true' : fields[index + 1].slice(separator + 1),
    });
  }
  return entries;
}

/** Scopes the operator's own machine supplies, `command` being `-c` and `GIT_CONFIG_PARAMETERS`. */
const USER_SCOPES: ReadonlySet<string> = new Set(['system', 'global', 'command']);

/** Scopes a checkout supplies: its own config, and every file that config includes. */
const REPOSITORY_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree']);

/** Git's built-in value for a setting, for a key the repository sets and the operator has not. */
const BUILT_IN = {
  'commit.gpgsign': 'false',
  'gpg.format': 'openpgp',
  gpg: 'gpg',
  'gpg.x509.program': 'gpgsm',
  'gpg.ssh.program': 'ssh-keygen',
} as const;

/**
 * One pin per setting the repository sets, and nothing at all for a setting it leaves alone.
 *
 * `fallback` is what stands behind the operator's own value when they have none: git's built-in
 * default, or an empty value for a key that has none. The two `gpg.program` names are one setting
 * under two spellings, so they are one unit — pinning only the one the repository happened to
 * spell would leave the other reading the repository's value straight back out of the same file.
 *
 * Every fallback here was checked against a real git rather than read off the documentation. An
 * empty `gpg.ssh.defaultKeyCommand` never runs: git stops at "user.signingKey needs to be set for
 * ssh signing" before it would consult one, and where it is consulted the empty command is
 * `cannot run :` and nothing else. The ssh paths are only read to verify signatures, which a
 * cherry-pick of an agent's own commit never does.
 */
const PIN_UNITS: readonly { keys: readonly string[]; fallback: string }[] = [
  { keys: ['commit.gpgsign'], fallback: BUILT_IN['commit.gpgsign'] },
  { keys: ['gpg.format'], fallback: BUILT_IN['gpg.format'] },
  { keys: ['gpg.program', 'gpg.openpgp.program'], fallback: BUILT_IN.gpg },
  { keys: ['gpg.x509.program'], fallback: BUILT_IN['gpg.x509.program'] },
  { keys: ['gpg.ssh.program'], fallback: BUILT_IN['gpg.ssh.program'] },
  { keys: ['gpg.ssh.defaultkeycommand'], fallback: '' },
  { keys: ['gpg.ssh.allowedsignersfile'], fallback: '' },
  { keys: ['gpg.ssh.revocationfile'], fallback: '' },
];

/**
 * The `-c` arguments that make the cherry-pick read signing configuration from the operator alone,
 * for the entries {@link readSigningConfig} reported.
 *
 * Pure, and the whole of the decision: what git is told, in the order git will read it. Defaults
 * and empty values come first and the operator's own values after, so where both exist the
 * operator's is the one in force — the same ordering git applies to its own configuration, where a
 * later entry wins. A key no repository scope sets produces no arguments at all, which is the
 * whole of why an operator who has configured nothing here is unaffected.
 *
 * `committerIdent` is the output of `git var GIT_COMMITTER_IDENT`, and is only read in the one
 * case {@link committerIdentityRequired} describes; the caller that does not need it passes an
 * empty string, which is never used.
 */
export function signingPins(entries: SigningConfigEntry[], committerIdent: string): string[] {
  const { userValues, repositoryKeys } = collectSigningFacts(entries);
  const fallbacks: string[] = [];
  const operatorValues: string[] = [];
  const pin = (into: string[], key: string, value: string): void => {
    into.push('-c', `${key}=${value}`);
  };

  const pinned = new Set<string>();
  for (const unit of PIN_UNITS) {
    for (const key of unit.keys) pinned.add(key);
    if (!unit.keys.some((key) => repositoryKeys.has(key))) continue;
    // Both, in that order: the fallback is always stated, and the operator's own value is always
    // after it, so which of the two is in force is a property of the argument order rather than
    // of a branch that was taken. One value for the whole unit, so the two spellings of
    // `gpg.program` cannot disagree.
    const operatorValue = lastOperatorValue(unit.keys, userValues);
    for (const key of unit.keys) {
      pin(fallbacks, key, unit.fallback);
      if (operatorValue !== undefined) pin(operatorValues, key, operatorValue);
    }
  }

  if (repositoryKeys.has('user.signingkey')) {
    const operatorValue = userValues.get('user.signingkey');
    pin(fallbacks, 'user.signingkey', defaultSigningKey(userValues, committerIdent));
    if (operatorValue !== undefined) pin(operatorValues, 'user.signingkey', operatorValue);
  }

  // Any other `gpg.*` key a repository sets: this file does not know what it selects, and an
  // unknown key is exactly the one a repository would add to reach a program, so the empty value
  // is all it gets. The operator's own value still stands after it.
  for (const key of repositoryKeys) {
    if (pinned.has(key) || !key.startsWith('gpg.')) continue;
    pin(fallbacks, key, '');
    const operatorValue = userValues.get(key);
    if (operatorValue !== undefined) pin(operatorValues, key, operatorValue);
  }

  return [...fallbacks, ...operatorValues];
}

/**
 * The `-c` arguments for a cherry-pick in this repository: its signing configuration, read
 * through a hardened call, turned into pins.
 */
export async function signingPinArgs(repoRoot: string): Promise<string[]> {
  const entries = await readSigningConfig(repoRoot);
  // `git var` is another process for a value most applies never need, so it is only asked for
  // where a pin below depends on it.
  if (!committerIdentityRequired(collectSigningFacts(entries))) return signingPins(entries, '');
  return signingPins(entries, await git(repoRoot, ['var', 'GIT_COMMITTER_IDENT']));
}

function collectSigningFacts(entries: readonly SigningConfigEntry[]): {
  /** The last value the operator's own configuration gave each key, in config order. */
  userValues: Map<string, string>;
  /** Every key a repository scope sets, first seen first. */
  repositoryKeys: Set<string>;
} {
  const userValues = new Map<string, string>();
  const repositoryKeys = new Set<string>();
  for (const entry of entries) {
    if (USER_SCOPES.has(entry.scope)) userValues.set(entry.key, entry.value);
    // Anything else is not a source for anything: git names the five scopes above and no others,
    // so a value from one the repository did not set cannot be the operator's either.
    else if (REPOSITORY_SCOPES.has(entry.scope)) repositoryKeys.add(entry.key);
  }
  return { userValues, repositoryKeys };
}

function lastOperatorValue(keys: readonly string[], userValues: Map<string, string>) {
  for (const key of keys) {
    const value = userValues.get(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Whether a pin can depend on the committer identity, which is the only reason to ask git for it.
 */
function committerIdentityRequired({
  userValues,
  repositoryKeys,
}: {
  userValues: Map<string, string>;
  repositoryKeys: Set<string>;
}): boolean {
  return (
    repositoryKeys.has('user.signingkey') &&
    !userValues.has('user.signingkey') &&
    effectiveFormat(userValues) !== 'ssh'
  );
}

/** The format the applied commit will sign in: the operator's choice, never the repository's. */
function effectiveFormat(userValues: Map<string, string>): string {
  return userValues.get('gpg.format') ?? BUILT_IN['gpg.format'];
}

/**
 * What git signs an openpgp or x509 commit with when `user.signingKey` is unset: the committer
 * identity, which is how the backend finds the key. Pinning that keeps a repository's choice of
 * key out of the commit, and the commit lands as the operator's own signing would have.
 *
 * ssh is the case git itself is strict about, and it is a real limitation: it looks for no key at
 * all, so the honest pin is an empty value and the commit fails with "user.signingKey needs to be
 * set for ssh signing" (checked on git 2.43). An operator affected by that is an ssh signer who
 * relies on `gpg.ssh.defaultKeyCommand` to produce the key instead of setting `user.signingKey`,
 * in a repository that sets `user.signingKey` of its own. Their fix is to set `user.signingKey`
 * in their global config, which is where this reads it.
 */
function defaultSigningKey(userValues: Map<string, string>, committerIdent: string): string {
  if (effectiveFormat(userValues) === 'ssh') return '';
  return committerSigningIdentity(committerIdent);
}

/**
 * `Test <test@example.com> 1790626018 +0700` → `Test <test@example.com>`, the date dropped because
 * it is a property of this commit rather than of the key.
 *
 * The identity is the one the cherry-pick is about to commit under in any case: `user.name` and
 * `user.email` are read from configuration a repository can also set, so this adds nothing such a
 * repository had not already decided about that commit. It names no program — the program this key
 * is paired with is pinned separately, to the operator's own.
 */
export function committerSigningIdentity(ident: string): string {
  return ident.trim().replace(/\s+\d+\s+[+-]\d{4}$/, '');
}
