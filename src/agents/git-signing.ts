/**
 * What the cherry-pick that applies an agent's result is allowed to read as signing configuration
 * (#348).
 *
 * The decision is the owner's: that commit lands in the operator's branch under their committer
 * identity, so it keeps signing as they configured — but only from *their* configuration. A
 * checkout's `.git/config` is a file the checkout chooses, and it arrives with an archive, a shared
 * directory, or someone else's machine, so `commit.gpgSign` together with `gpg.program = <anything>`
 * is a way for a repository to have Book start a program while applying an agent's work, with no
 * prompt, in a flow nothing asked about. `hardenedGitArgs` closes the routes that need a command
 * of their own — hooks, `core.fsmonitor`, a diff driver — and a signing program is named by
 * configuration alone, so it needs this.
 *
 * The pins travel as `-c` overrides on the cherry-pick itself, which is where they belong: git
 * reads them in the order it reads anything else and the last one wins, so a value the operator
 * set is pinned *after* the value that would otherwise stand behind it.
 *
 * Every program and format key is pinned **unconditionally**, not only when a repository sets it.
 * Reading first and pinning only what was read makes safety depend on the read having been
 * complete and on the configuration not having changed between the read and the cherry-pick —
 * and both are properties of a checkout to decide. A pin costs nothing when nothing disagrees: for
 * a key the operator has set, the last `-c` is their own value, which is the configuration they
 * already had.
 */

/** One `git config` entry, in the order git reported it. */
export interface SigningConfigEntry {
  /**
   * Git's own name for where the value came from: `system`, `global`, `local`, `worktree` or
   * `command`. An entry a repository pulled in with `include`/`includeIf` carries the scope of
   * the file that included it, so it is a repository value (checked on git 2.43).
   */
  scope: string;
  /**
   * The key as git canonicalized it: the section and the variable name lower-cased, a subsection
   * left exactly as written — `gpg.ssh.program`, and `gpg.SSH.program` for a key that is not
   * this one at all.
   */
  key: string;
  /** The value, or `true` for a key written without one — `[commit] gpgsign` means what it says. */
  value: string;
}

/** What {@link HardenedRunner} is given, and what it is asked for. */
export interface RunOptions {
  cwd: string;
  /** Exit codes to resolve rather than reject. Only ever a real, numeric exit code. */
  allowExitCodes?: number[];
  /** Kill the child and reject after this long. */
  timeoutMs?: number;
  /** Write this to the child's stdin instead of leaving stdin closed. */
  input?: string;
  /** Added to Book's own environment and to the hardening every call carries. */
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * The one hardened way to run a command here, supplied by `git-isolation.ts` — the same argv and
 * environment hardening its own `git()` builds, applied in one place so a fix to it reaches every
 * call this module makes.
 *
 * It is a parameter rather than an import because that module imports this one, and a helper both
 * of them imported would be a cycle the architecture check rejects. It runs *commands*, not only
 * git: the operator's own ssh key command of {@link sshDefaultSigningKey} is not git, and runs
 * here for the same reason git would run it — the one program on this path that is not a
 * repository's.
 */
export type HardenedRunner = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<RunResult>;

/**
 * The keys to ask git about: every setting that names or chooses a signing program, plus every
 * `gpg.*` key whatever it is called, so that a key this file has never heard of is still seen and
 * neutralized rather than passed through.
 */
const SIGNING_KEY_PATTERN = '^(commit\\.gpgsign|gpg\\..*|user\\.signingkey)$';

/** Git before 2.26 has no `--show-scope`, and without it there is no way to tell the two apart. */
const MINIMUM_GIT = '2.26';

/** A read, a `git var`, and the operator's key command are all cheap; a minute is generous. */
const READ_TIMEOUT_MS = 30_000;

/** Scopes the operator's own machine supplies, `command` being `-c` and `GIT_CONFIG_PARAMETERS`. */
const USER_SCOPES: ReadonlySet<string> = new Set(['system', 'global', 'command']);

/** Scopes a checkout supplies: its own config, and every file that config includes. */
const REPOSITORY_SCOPES: ReadonlySet<string> = new Set(['local', 'worktree']);

/** Git's built-in value for a setting, for a key the operator has not set. */
const BUILT_IN = {
  'commit.gpgsign': 'false',
  'gpg.format': 'openpgp',
  gpg: 'gpg',
  'gpg.x509.program': 'gpgsm',
  'gpg.ssh.program': 'ssh-keygen',
} as const;

/**
 * One pin per program and format setting, always: its fallback first, then the operator's own
 * value where there is one.
 *
 * `fallback` is what stands behind the operator's value when they have none: git's built-in
 * default, or an empty value for a key that has none. The two `gpg.program` names are one setting
 * under two spellings, so they are one unit — one value for both, so the pair cannot disagree.
 *
 * Every fallback here was checked against a real git rather than read off the documentation. An
 * empty `gpg.ssh.defaultKeyCommand` never runs: where it is consulted the empty command is
 * `cannot run :` and nothing else, and git asks for a `user.signingKey` before it would consult
 * one. The ssh paths are only read to verify signatures, which a cherry-pick of an agent's own
 * commit never does.
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

/** Where a `user.signingkey` pin that the repository forced gets its value. */
type SigningKeySource = 'none' | 'operator' | 'committer' | 'ssh-default-key-command';

/** The values the pins can only be built from, and which cost a process each to obtain. */
export interface SigningPinsInputs {
  /** The output of `git var GIT_COMMITTER_IDENT`, when a pin needs it. */
  committerIdent: string;
  /** The key the operator's `gpg.ssh.defaultKeyCommand` printed, when one was run. */
  sshDefaultKey: string;
}

/**
 * The signing configuration as git reports it, in config order: system, then global, then the
 * repository's own files in the order git read them, then `command`.
 *
 * `129` is resolved rather than left to reject, because that is the code a git too old for
 * `--show-scope` exits with, and the operator is better served by being told that than by being
 * handed a usage message.
 */
export async function readSigningConfig(
  repoRoot: string,
  run: HardenedRunner,
): Promise<SigningConfigEntry[]> {
  const result = await run(
    'git',
    ['config', '--show-scope', '-z', '--get-regexp', SIGNING_KEY_PATTERN],
    { cwd: repoRoot, allowExitCodes: [1, 129], timeoutMs: READ_TIMEOUT_MS },
  );
  if (result.code === 129 || /unknown option/i.test(result.stderr)) {
    throw new Error(
      `Applying an agent's result needs git ${MINIMUM_GIT} or later (for \`git config --show-scope\`); this git is ${await gitVersion(run, repoRoot)}`,
    );
  }
  return parseSigningConfig(result.stdout);
}

async function gitVersion(run: HardenedRunner, repoRoot: string): Promise<string> {
  try {
    return (
      await run('git', ['--version'], { cwd: repoRoot, timeoutMs: READ_TIMEOUT_MS })
    ).stdout.trim();
  } catch {
    return 'of an unknown version';
  }
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
      key: canonicalConfigKey(
        separator === -1 ? fields[index + 1] : fields[index + 1].slice(0, separator),
      ),
      // Git's own reading of a key with no value: a boolean true.
      value: separator === -1 ? 'true' : fields[index + 1].slice(separator + 1),
    });
  }
  return entries;
}

/**
 * Canonicalize a config key the way git does, which is not by lower-casing all of it: the section
 * and the variable name are case-insensitive and git reports them folded, but a **subsection is
 * case-sensitive and git keeps it exactly as written** (checked on git 2.43: `[gpg "SSH"] program`
 * is reported as `gpg.SSH.program`).
 *
 * That matters because `gpg.SSH.program` is not `gpg.ssh.program`. Git does not use the former for
 * ssh signing, so treating it as the latter would read the operator's own key-setting program out
 * of their configuration and pin it where the repository's would otherwise have gone. As written
 * it is an unknown key, and an unknown key a repository sets is neutralized rather than honored.
 */
export function canonicalConfigKey(raw: string): string {
  const nameStart = raw.lastIndexOf('.');
  if (nameStart === -1) return raw.toLowerCase();
  const head = raw.slice(0, nameStart);
  const name = raw.slice(nameStart + 1).toLowerCase();
  const subsectionStart = head.indexOf('.');
  if (subsectionStart === -1) return `${head.toLowerCase()}.${name}`;
  // A subsection may itself contain dots, so only the section in front of the first one is folded.
  const section = head.slice(0, subsectionStart).toLowerCase();
  return `${section}.${head.slice(subsectionStart + 1)}.${name}`;
}

/** What the entries say, split the way every decision below needs it. Computed once, used once. */
export interface SigningFacts {
  /** The operator's own entries, in config order. */
  operatorEntries: SigningConfigEntry[];
  /** Every key a repository scope sets, first seen first. */
  repositoryKeys: Set<string>;
  /** Whether the operator has asked for commits to be signed at all. */
  signingOn: boolean;
  /** The format the applied commit will sign in, folded the way git compares it. */
  format: string;
}

/** Split the entries. A value from any other scope is a source for nothing, and a key for nothing. */
export function signingFacts(entries: readonly SigningConfigEntry[]): SigningFacts {
  const operatorEntries: SigningConfigEntry[] = [];
  const repositoryKeys = new Set<string>();
  for (const entry of entries) {
    if (USER_SCOPES.has(entry.scope)) operatorEntries.push(entry);
    else if (REPOSITORY_SCOPES.has(entry.scope)) repositoryKeys.add(entry.key);
  }
  return {
    operatorEntries,
    repositoryKeys,
    signingOn: configBool(operatorValue(operatorEntries, ['commit.gpgsign'])),
    format: (operatorValue(operatorEntries, ['gpg.format']) ?? BUILT_IN['gpg.format'])
      .trim()
      .toLowerCase(),
  };
}

/**
 * The operator's own value for a setting, where the setting has more than one name.
 *
 * The last entry in config order wins, not the first name in the list: git stores the two
 * `gpg.program` spellings in one slot, and whichever was written last is the one it reads
 * (checked on git 2.43 and 2.55). Asking for `gpg.program` first and falling back to
 * `gpg.openpgp.program` would hand back the wrong one whenever the operator wrote them the other
 * way round.
 */
function operatorValue(
  operatorEntries: readonly SigningConfigEntry[],
  keys: readonly string[],
): string | undefined {
  let value: string | undefined;
  for (const entry of operatorEntries) {
    if (keys.includes(entry.key)) value = entry.value;
  }
  return value;
}

/** {@link operatorValue} over facts that have already been split. */
function lastOperatorValue(facts: SigningFacts, keys: readonly string[]): string | undefined {
  return operatorValue(facts.operatorEntries, keys);
}

/** Git reads these as booleans; anything it would not accept counts as off, which is the safe side. */
function configBool(value: string | undefined): boolean {
  return ['true', 'yes', 'on', '1'].includes((value ?? '').trim().toLowerCase());
}

/**
 * Where a `user.signingkey` pin gets its value, which decides whether anything has to be run.
 *
 * `'none'` covers three cases that cost nothing: a repository that sets no key (nothing to pin),
 * signing that is effectively off (git never reads the key, so there is nothing to decide), and
 * an ssh operator who has neither a key nor a key command — the one shape that cannot be carried
 * across, pinned empty so that git fails rather than signing with a repository's key.
 */
export function signingKeySource(facts: SigningFacts): SigningKeySource {
  if (!facts.repositoryKeys.has('user.signingkey') || !facts.signingOn) return 'none';
  if (lastOperatorValue(facts, ['user.signingkey']) !== undefined) return 'operator';
  if (facts.format === 'ssh') {
    return lastOperatorValue(facts, ['gpg.ssh.defaultkeycommand']) === undefined
      ? 'none'
      : 'ssh-default-key-command';
  }
  return 'committer';
}

/**
 * The `-c` arguments that make the cherry-pick read signing configuration from the operator alone.
 *
 * Pure, and the whole of the decision: what git is told, in the order git will read it.
 * Neutralizers and defaults come first and the operator's own values after, so where both exist
 * the operator's is the one in force — the same ordering git applies to its own configuration,
 * where a later entry wins.
 */
export function signingPins(
  entries: readonly SigningConfigEntry[],
  inputs: SigningPinsInputs = { committerIdent: '', sshDefaultKey: '' },
): string[] {
  return pinsFor(signingFacts(entries), inputs);
}

function pinsFor(facts: SigningFacts, inputs: SigningPinsInputs): string[] {
  const fallbacks: string[] = [];
  const operatorValues: string[] = [];
  const pin = (into: string[], key: string, value: string): void => {
    into.push('-c', `${key}=${value}`);
  };

  const pinned = new Set<string>();
  for (const unit of PIN_UNITS) {
    for (const key of unit.keys) pinned.add(key);
    const operatorValue = lastOperatorValue(facts, unit.keys);
    for (const key of unit.keys) {
      pin(fallbacks, key, unit.fallback);
      if (operatorValue !== undefined) pin(operatorValues, key, operatorValue);
    }
  }

  // Only a repository that sets a key forces a decision about one, and a key with no neutral value
  // is the reason the rest of this function pins unconditionally: there is nothing to say about it
  // unless the repository has an opinion worth overruling.
  if (facts.repositoryKeys.has('user.signingkey')) {
    pin(fallbacks, 'user.signingkey', derivedSigningKey(facts, inputs));
    const operatorValue = lastOperatorValue(facts, ['user.signingkey']);
    if (operatorValue !== undefined) pin(operatorValues, 'user.signingkey', operatorValue);
  }

  // Any other `gpg.*` key a repository sets: this file does not know what it selects, and an
  // unknown key is exactly the one a repository would add to reach a program, so the empty value
  // is all it gets. The operator's own value still stands after it.
  for (const key of facts.repositoryKeys) {
    if (pinned.has(key) || !key.startsWith('gpg.')) continue;
    pin(fallbacks, key, '');
    const operatorValue = lastOperatorValue(facts, [key]);
    if (operatorValue !== undefined) pin(operatorValues, key, operatorValue);
  }

  return [...fallbacks, ...operatorValues];
}

function derivedSigningKey(facts: SigningFacts, inputs: SigningPinsInputs): string {
  switch (signingKeySource(facts)) {
    case 'operator':
      // The operator's own value is pinned after this, so what stands in front of it only has to
      // be harmless — and empty names no key at all.
      return '';
    case 'committer':
      return committerSigningIdentity(inputs.committerIdent);
    case 'ssh-default-key-command':
      return inputs.sshDefaultKey;
    default:
      return '';
  }
}

/**
 * `Test <test@example.com> 1790626018 +0700` → `Test <test@example.com>`, the date dropped because
 * it is a property of this commit rather than of the key.
 *
 * This is what git signs an openpgp or x509 commit with when `user.signingKey` is unset, and it
 * is the identity the cherry-pick is about to commit under in any case: `user.name` and
 * `user.email` come from configuration a repository can also set, so this adds nothing such a
 * repository had not already decided about that commit. It names no program — the program this key
 * is paired with is pinned separately, to the operator's own.
 */
export function committerSigningIdentity(ident: string): string {
  return ident.trim().replace(/\s+\d+\s+[+-]\d{4}$/, '');
}

/**
 * The `-c` arguments for a cherry-pick in this repository: its signing configuration, read through
 * the hardened runner, turned into pins.
 */
export async function signingPinArgs(repoRoot: string, run: HardenedRunner): Promise<string[]> {
  const entries = await readSigningConfig(repoRoot, run);
  const facts = signingFacts(entries);
  // Each of these is a process, and most applies need neither: a repository that sets no signing
  // key has nothing to decide, and an operator who has a key of their own has already answered it.
  const inputs: SigningPinsInputs = { committerIdent: '', sshDefaultKey: '' };
  const source = signingKeySource(facts);
  if (source === 'committer') {
    inputs.committerIdent = (
      await run('git', ['var', 'GIT_COMMITTER_IDENT'], {
        cwd: repoRoot,
        timeoutMs: READ_TIMEOUT_MS,
      })
    ).stdout;
  } else if (source === 'ssh-default-key-command') {
    inputs.sshDefaultKey = await sshDefaultSigningKey(facts, repoRoot, run);
  }
  return pinsFor(facts, inputs);
}

/**
 * The key the operator's own `gpg.ssh.defaultKeyCommand` produces, in the form git accepts.
 *
 * Git looks for no key of its own for ssh, so an operator whose global config relies on the key
 * command rather than on `user.signingKey` used to fail here, and the honest empty pin turned that
 * into a failed apply. The command is the operator's own — it is the one git would have run for
 * this commit — so it is run here the way git runs it: split on whitespace with no shell, through
 * the same hardened runner, with stdin closed so a command that waits for input cannot hang the
 * apply, and bounded by the same timeout the other reads carry.
 *
 * Git's contract for the output is a public key on the first line prefixed with `key::`, and a
 * line that is not that is not used: the pin is empty instead, which fails the apply rather than
 * signing with a key this never established was the operator's.
 */
export async function sshDefaultSigningKey(
  facts: SigningFacts,
  repoRoot: string,
  run: HardenedRunner,
): Promise<string> {
  const command = lastOperatorValue(facts, ['gpg.ssh.defaultkeycommand'])?.trim();
  if (!command) return '';
  // Git's own splitting: whitespace-separated words, the first the program, no shell.
  const [program, ...args] = command.split(/\s+/);
  try {
    const result = await run(program, args, { cwd: repoRoot, timeoutMs: READ_TIMEOUT_MS });
    const first = result.stdout.split(/\r?\n/)[0]?.trim() ?? '';
    return first.startsWith('key::') ? first : '';
  } catch {
    return '';
  }
}
