import { execFileSync } from 'child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentApplyResult, AgentRecord } from './types.js';
import type { RunResult } from './git-signing.js';
import {
  applyVerifiedCandidate,
  commitAgentWork,
  createAgentWorktree,
  createSyntheticSnapshot,
  removeAgentWorktree,
  removeSnapshotRef,
} from './git-isolation.js';
import { cherryPickFailureResult, gitForTest } from './git-isolation-internal.js';

const roots: string[] = [];

/**
 * Config values name files on this machine, and a backslash in a git config value is an escape
 * sequence rather than a path separator. Forward slashes are what Git for Windows and every other
 * git take, and every test below writes its config values through this.
 */
function forwardSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(at?: string): string {
  const root = at ?? mkdtempSync(join(tmpdir(), 'book-agent-git-'));
  if (!at) roots.push(root);
  mkdirSync(root, { recursive: true });
  git(root, 'init');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n');
  for (const name of ['staged.txt', 'unstaged.txt', 'old-name.txt', 'deleted.txt']) {
    writeFileSync(join(root, name), `base ${name}\n`);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  return root;
}

function agentRecord(id: string, worktree: { path: string; branch: string }): AgentRecord {
  return {
    id,
    name: id,
    role: 'patcher',
    description: 'test',
    status: 'completed',
    applicationStatus: 'not_applied',
    worktree: worktree.path,
    branch: worktree.branch,
    prompt: 'patch',
    referencedEvidenceIds: [],
    transcript: [],
    pendingMessages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// `resolveBookHome()` reads BOOK_HOME when it is called, not when this module loads, so a
// file-level override redirects every default worktree root away from the real `~/.book`.
const savedBookHome = process.env.BOOK_HOME;
let bookHome: string;

// Every test in this file runs git, and git reads `~/.gitconfig` and the system config for all of
// it unless it is told otherwise. A developer or CI machine may have `commit.gpgSign` set, may
// name a `gpg.program`, and may have no identity at all: a test that then signs, or fails to
// sign, proves nothing about Book, and one that failed only on that machine would be a mystery.
// So each test is pointed at config files it controls — the previous values are restored
// afterwards — and a test that wants signing config writes it here itself.
const savedGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
const savedGitConfigSystem = process.env.GIT_CONFIG_SYSTEM;
let globalConfig = '';
let systemConfig = '';

/** Write the operator's own git config for the test that is running. */
function writeGlobalConfig(body: string): void {
  writeFileSync(globalConfig, body);
}

/**
 * The rest of git's environment, which is the rest of the ways a host can decide what a test
 * observes, and each of them decides something the tests below are asserting about.
 *
 * `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_COUNT` with its `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`
 * pairs are `-c` overrides, which git reports in the `command` scope — the one scope this change
 * counts as the operator's own, so a stray pair on a developer's or CI machine's environment would
 * be a source for a signing pin, and the tests would be measuring their own machine's signing
 * setup rather than Book's. The rest name the repository, worktree, index, object and common
 * directory git operates on: a `GIT_DIR` pointing anywhere would redirect every call in the file at
 * another checkout. Deleted for the test and put back after it; a test that wants one sets it in
 * its own body, where it is a deliberate part of the fixture.
 */
const GIT_ENV_TO_SCRUB = [
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
];

let scrubbedGitEnv = new Map<string, string | undefined>();

function scrubGitEnv(): Map<string, string | undefined> {
  const named = new Set<string>(GIT_ENV_TO_SCRUB);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('GIT_CONFIG_KEY_') || name.startsWith('GIT_CONFIG_VALUE_')) named.add(name);
  }
  const saved = new Map<string, string | undefined>();
  for (const name of named) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  return saved;
}

function restoreGitEnv(saved: Map<string, string | undefined>): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeEach(() => {
  bookHome = mkdtempSync(join(tmpdir(), 'book-home-'));
  roots.push(bookHome);
  process.env.BOOK_HOME = bookHome;
  const gitConfig = mkdtempSync(join(tmpdir(), 'book-gitconfig-'));
  roots.push(gitConfig);
  globalConfig = join(gitConfig, 'global.gitconfig');
  systemConfig = join(gitConfig, 'system.gitconfig');
  // Empty files rather than no files: git reads both, and an empty one says "configured, with
  // nothing in it" in a way no test can read the host's configuration through.
  writeFileSync(globalConfig, '');
  writeFileSync(systemConfig, '');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  scrubbedGitEnv = scrubGitEnv();
});

afterEach(() => {
  if (savedBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = savedBookHome;
  if (savedGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
  if (savedGitConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = savedGitConfigSystem;
  restoreGitEnv(scrubbedGitEnv);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('synthetic agent snapshots', () => {
  it('captures staged, unstaged, renamed, deleted, and visible untracked files without touching the parent index', async () => {
    const root = repository();
    writeFileSync(join(root, 'staged.txt'), 'staged value\n');
    git(root, 'add', 'staged.txt');
    writeFileSync(join(root, 'unstaged.txt'), 'unstaged value\n');
    git(root, 'mv', 'old-name.txt', 'new-name.txt');
    rmSync(join(root, 'deleted.txt'));
    writeFileSync(join(root, 'visible.txt'), 'visible\n');
    writeFileSync(join(root, 'ignored.txt'), 'secret\n');

    const statusBefore = git(root, 'status', '--short');
    const branchBefore = git(root, 'branch', '--show-current');
    const indexBefore = readFileSync(join(root, '.git', 'index'));
    const snapshot = await createSyntheticSnapshot(root, true);

    expect(git(root, 'show', `${snapshot.commit}:staged.txt`)).toBe('staged value');
    expect(git(root, 'show', `${snapshot.commit}:unstaged.txt`)).toBe('unstaged value');
    expect(git(root, 'show', `${snapshot.commit}:new-name.txt`)).toBe('base old-name.txt');
    expect(git(root, 'show', `${snapshot.commit}:visible.txt`)).toBe('visible');
    expect(() => git(root, 'show', `${snapshot.commit}:deleted.txt`)).toThrow();
    expect(() => git(root, 'show', `${snapshot.commit}:ignored.txt`)).toThrow();
    expect(snapshot.manifest.map((item) => item.path)).toContain('visible.txt');
    expect(git(root, 'status', '--short')).toBe(statusBefore);
    expect(git(root, 'branch', '--show-current')).toBe(branchBefore);
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(indexBefore);
  });

  it('applies only the agent delta to an unchanged dirty parent and rejects later drift', async () => {
    const root = repository();
    writeFileSync(join(root, 'unstaged.txt'), 'parent dirty value\n');
    const snapshot = await createSyntheticSnapshot(root, true);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-managed-wt-'));
    roots.push(worktreeRoot);
    const worktree = await createAgentWorktree(snapshot, 'patcher-test', worktreeRoot);
    writeFileSync(join(worktree.path, 'staged.txt'), 'agent value\n');
    const record = {
      id: 'patcher-test',
      name: 'patcher',
      role: 'patcher',
      description: 'test',
      status: 'completed',
      applicationStatus: 'not_applied',
      worktree: worktree.path,
      branch: worktree.branch,
      prompt: 'patch',
      referencedEvidenceIds: [],
      transcript: [],
      pendingMessages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies AgentRecord;
    const candidate = await commitAgentWork(record, snapshot);
    expect(candidate).toBeDefined();

    const applied = await applyVerifiedCandidate(snapshot, candidate!);
    expect(applied.status).toBe('applied');
    expect(readFileSync(join(root, 'staged.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'agent value\n',
    );
    expect(readFileSync(join(root, 'unstaged.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'parent dirty value\n',
    );
    expect(git(root, 'status', '--short')).toContain('staged.txt');

    const secondSnapshot = await createSyntheticSnapshot(root, true);
    const secondWorktree = await createAgentWorktree(secondSnapshot, 'patcher-drift', worktreeRoot);
    writeFileSync(join(secondWorktree.path, 'staged.txt'), 'second agent value\n');
    const secondCandidate = await commitAgentWork(
      {
        ...record,
        id: 'patcher-drift',
        worktree: secondWorktree.path,
        branch: secondWorktree.branch,
      },
      secondSnapshot,
    );
    writeFileSync(join(root, 'unstaged.txt'), 'drifted after snapshot\n');
    const rejected = await applyVerifiedCandidate(secondSnapshot, secondCandidate!);
    expect(rejected.status).toBe('conflicted');
    expect(readFileSync(join(root, 'staged.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'agent value\n',
    );
  });

  it('cherry-picks a validated candidate into a clean unchanged parent', async () => {
    const root = repository();
    const snapshot = await createSyntheticSnapshot(root, true);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-clean-wt-'));
    roots.push(worktreeRoot);
    const worktree = await createAgentWorktree(snapshot, 'clean-patcher', worktreeRoot);
    writeFileSync(join(worktree.path, 'staged.txt'), 'clean candidate\n');
    const record = {
      id: 'clean-patcher',
      name: 'patcher',
      role: 'patcher',
      description: 'test',
      status: 'completed',
      applicationStatus: 'not_applied',
      worktree: worktree.path,
      branch: worktree.branch,
      prompt: 'patch',
      referencedEvidenceIds: [],
      transcript: [],
      pendingMessages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies AgentRecord;
    const candidate = await commitAgentWork(record, snapshot);
    const applied = await applyVerifiedCandidate(snapshot, candidate!);

    expect(applied.status).toBe('applied');
    expect(applied.commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(git(root, 'status', '--short')).toBe('');
  });

  it('removes managed worktrees, branches, and snapshot refs', async () => {
    const root = repository();
    const snapshot = await createSyntheticSnapshot(root, true);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-cleanup-wt-'));
    roots.push(worktreeRoot);
    const worktree = await createAgentWorktree(snapshot, 'cleanup-agent', worktreeRoot);
    const record = {
      id: 'cleanup-agent',
      name: 'patcher',
      role: 'patcher',
      description: 'cleanup',
      status: 'completed',
      applicationStatus: 'not_applied',
      worktree: worktree.path,
      branch: worktree.branch,
      prompt: 'cleanup',
      referencedEvidenceIds: [],
      transcript: [],
      pendingMessages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies AgentRecord;

    await removeAgentWorktree(record, root);
    expect(existsSync(worktree.path)).toBe(false);
    expect(() => git(root, 'show-ref', '--verify', `refs/heads/${worktree.branch}`)).toThrow();
    await removeSnapshotRef(snapshot);
    expect(() => git(root, 'show-ref', '--verify', snapshot.ref)).toThrow();
  });
});

/** The hooks this shape of flow can reach: worktree creation, a commit, a cherry-pick, a ref. */
const HOOKS = [
  'post-checkout',
  'pre-commit',
  'commit-msg',
  'post-commit',
  'prepare-commit-msg',
  'reference-transaction',
] as const;

/**
 * A checkout able to run a program on its own, built the way a clone builds one: the settings
 * arrive with the `.git` directory, so none of this is Book's doing.
 *
 * `core.fsmonitor` names a command `git status` executes, and each hook is a `#!/bin/sh` script
 * writing its own marker into a directory outside the checkout — Git for Windows runs a hook
 * through its own sh, so the shebang and `touch` are what have to be portable, not the
 * executable bit. A marker is the only evidence used: one that exists means a program ran, one
 * that does not mean none did.
 */
function armedRepository(): {
  root: string;
  markers: string;
  markerFor: (name: string) => string;
  disarm: () => void;
} {
  const sandbox = mkdtempSync(join(tmpdir(), 'book-agent-hooks-'));
  roots.push(sandbox);
  const root = repository(join(sandbox, 'repo'));
  const markers = join(sandbox, 'markers');
  mkdirSync(markers);
  const markerFor = (name: string) => join(markers, name);
  // `core.hooksPath` is set to the ABSOLUTE path of this repository's own hooks directory. A
  // developer or CI machine with a global `core.hooksPath` (husky, pre-commit) otherwise makes
  // git ignore `.git/hooks` entirely, and the control below fails for a reason that has nothing
  // to do with Book. Relative would be worse: git would resolve it against the agent worktree's
  // own root, where these scripts do not live, and every marker assertion would be vacuous.
  const sh = forwardSlashes;
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  git(root, 'config', 'core.hooksPath', sh(join(root, '.git', 'hooks')));
  for (const hook of HOOKS) {
    const script = join(root, '.git', 'hooks', hook);
    writeFileSync(script, `#!/bin/sh\ntouch '${sh(markerFor(hook))}'\n`);
    chmodSync(script, 0o755);
  }
  // A version 1 fsmonitor hook prints nothing and exits non-zero, the shape that leaves git
  // scanning the working tree itself. A hook reporting a clean tree instead would make the flow
  // tests below pass for the wrong reason: the markers would be right and every fingerprint
  // under them would be about a tree git had stopped looking at.
  const fsmonitor = join(sandbox, 'fsmonitor.sh');
  writeFileSync(fsmonitor, `#!/bin/sh\ntouch '${sh(markerFor('fsmonitor'))}'\nexit 1\n`);
  chmodSync(fsmonitor, 0o755);
  git(root, 'config', 'core.fsmonitor', sh(fsmonitor));
  return {
    root,
    markers,
    markerFor,
    disarm: () => {
      for (const hook of HOOKS) rmSync(join(root, '.git', 'hooks', hook), { force: true });
    },
  };
}

function markersPresent(markers: string): string[] {
  return existsSync(markers) ? readdirSync(markers).sort() : [];
}

describe('hooks and fsmonitor in the internal git flow (#348)', () => {
  it('lets a plain commit in the checkout run its own hooks, so the markers below mean something', () => {
    const { root, markerFor, disarm } = armedRepository();

    // The control. Without it "no marker" would also be satisfied by a fixture whose hooks never
    // worked, and the two tests under this one would assert nothing at all.
    git(root, 'commit', '--allow-empty', '-m', 'control');

    for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
      expect(existsSync(markerFor(hook)), `${hook} should have run for a plain commit`).toBe(true);
    }
    expect(existsSync(markerFor('reference-transaction'))).toBe(true);
    expect(git(root, 'config', '--get', 'core.fsmonitor')).toContain('fsmonitor.sh');

    // Removed here so no marker can leak from the control into a flow. The two flows below build
    // their own armed repository and measure it with the hooks still installed: a hook that has
    // been taken out is a hook nothing could have run.
    disarm();
  });

  it('runs no hook and no fsmonitor across the whole flow on a clean parent', async () => {
    const { root, markers, markerFor } = armedRepository();

    const snapshot = await createSyntheticSnapshot(root, true);
    expect(snapshot.dirty).toBe(false);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-hook-clean-wt-'));
    roots.push(worktreeRoot);
    const worktree = await createAgentWorktree(snapshot, 'clean-agent', worktreeRoot);
    writeFileSync(join(worktree.path, 'staged.txt'), 'agent value\n');
    const candidate = await commitAgentWork(agentRecord('clean-agent', worktree), snapshot);
    expect(candidate).toBeDefined();
    const applied = await applyVerifiedCandidate(snapshot, candidate!);

    // The flow still has to do its job: a hardening that simply stopped the flow would satisfy a
    // marker assertion as readily as the fix does.
    expect(applied.status).toBe('applied');
    expect(applied.commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(readFileSync(join(root, 'staged.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'agent value\n',
    );
    expect(markersPresent(markers)).toEqual([]);
    expect(existsSync(markerFor('post-checkout'))).toBe(false);
    expect(existsSync(markerFor('fsmonitor'))).toBe(false);
  });

  it('runs no hook and no fsmonitor across the whole flow on a dirty parent', async () => {
    const { root, markers, markerFor } = armedRepository();
    // A dirty parent takes the `git apply` branch of `applyVerifiedCandidate` instead of the
    // cherry-pick: a different set of commands, and a different set of hooks behind them.
    writeFileSync(join(root, 'unstaged.txt'), 'parent dirty value\n');

    const snapshot = await createSyntheticSnapshot(root, true);
    expect(snapshot.dirty).toBe(true);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-hook-dirty-wt-'));
    roots.push(worktreeRoot);
    const worktree = await createAgentWorktree(snapshot, 'dirty-agent', worktreeRoot);
    writeFileSync(join(worktree.path, 'staged.txt'), 'agent value\n');
    const candidate = await commitAgentWork(agentRecord('dirty-agent', worktree), snapshot);
    expect(candidate).toBeDefined();
    const applied = await applyVerifiedCandidate(snapshot, candidate!);

    expect(applied.status).toBe('applied');
    expect(readFileSync(join(root, 'staged.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'agent value\n',
    );
    expect(readFileSync(join(root, 'unstaged.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'parent dirty value\n',
    );
    // Uncommitted parent work is applied as a patch, so the parent keeps the commit it had.
    expect(git(root, 'rev-parse', 'HEAD')).toBe(snapshot.baseHead);
    expect(markersPresent(markers)).toEqual([]);
    expect(existsSync(markerFor('post-checkout'))).toBe(false);
    expect(existsSync(markerFor('fsmonitor'))).toBe(false);
  });
});

describe('a patch git never reads (#351)', () => {
  it('rejects the promise instead of raising the write failure on the host', async () => {
    // `git apply --cached` outside a repository exits before it reads stdin, so the write of a
    // patch larger than any pipe buffer fails with EPIPE. With no `error` listener on
    // `child.stdin` that failure is raised on the host's event loop: an uncaught exception in
    // whatever session was mid-flow, over a patch that was simply not applicable. The `close`
    // handler has rejected this promise by then, and the two must not disagree about it.
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);
    try {
      const notARepository = mkdtempSync(join(tmpdir(), 'book-not-a-repo-'));
      roots.push(notARepository);
      const patch = 'x'.repeat(4 * 1024 * 1024);

      await expect(
        gitForTest(notARepository, ['apply', '--cached', '-'], {
          input: patch,
          // The message is matched, so it must not be git's own translation of it, and the
          // directory must not be inside a repository just because `tmpdir()` happens to sit
          // under one on this machine — a home directory kept in version control for dotfiles
          // makes every path below it one. Stopping the walk at the parent is what makes
          // "not a repository" a property of the fixture rather than of the host.
          env: {
            LC_ALL: 'C',
            LANGUAGE: 'C',
            GIT_CEILING_DIRECTORIES: dirname(notARepository),
          },
        }),
      ).rejects.toThrow(/outside a repository/);

      // The write is still in flight when the promise settles and a broken pipe lands a tick
      // later. A wait long enough to cover a slow host is what makes "nothing was raised" a
      // claim about the whole tail rather than about the next hundred milliseconds.
      await new Promise((done) => setTimeout(done, 1000));
      expect(uncaught).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });
});

describe('the agent commit signs nothing (#348)', () => {
  it('neither runs gpg.program nor fails for want of a key', async () => {
    // A separate repository from the hook flows above, and deliberately so: the cherry-pick that
    // applies an agent's result onto the operator's branch signs as the operator configured,
    // because that commit lands in their history under their identity. The commit in the agent's
    // worktree is Book's own, authored as `Book Agent <agents@book.local>`, which has no key on
    // any machine — so with `commit.gpgSign` set anywhere, every patcher commit fails outright,
    // and a repository-configured `gpg.program` runs in place of failing.
    const sandbox = mkdtempSync(join(tmpdir(), 'book-agent-gpg-'));
    roots.push(sandbox);
    const root = repository(join(sandbox, 'repo'));
    const markers = join(sandbox, 'markers');
    mkdirSync(markers);
    const marker = join(markers, 'gpg');
    const sh = forwardSlashes;
    const program = join(sandbox, 'gpg.sh');
    writeFileSync(program, `#!/bin/sh\ntouch '${sh(marker)}'\nexit 1\n`);
    chmodSync(program, 0o755);
    git(root, 'config', 'commit.gpgSign', 'true');
    git(root, 'config', 'gpg.program', sh(program));

    // The control, and it is a failing commit that proves the config is armed: the script exits
    // 1, so a plain commit under this configuration cannot succeed. That is the same failure
    // every patcher commit would have had on any machine where the signing key is missing, and
    // `expect(candidate).toBeDefined()` below is the assertion that it no longer happens. Marker
    // paths are removed afterwards, because repository config that could start this program is
    // re-checked per test rather than assumed to have been set.
    expect(() => git(root, 'commit', '--allow-empty', '-m', 'control')).toThrow();
    expect(existsSync(marker), 'the control commit should have started gpg.program').toBe(true);
    rmSync(marker);

    const snapshot = await createSyntheticSnapshot(root, true);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-gpg-wt-'));
    roots.push(worktreeRoot);
    const worktree = await createAgentWorktree(snapshot, 'signing-agent', worktreeRoot);
    writeFileSync(join(worktree.path, 'staged.txt'), 'agent value\n');
    const candidate = await commitAgentWork(agentRecord('signing-agent', worktree), snapshot);

    expect(candidate).toBeDefined();
    expect(existsSync(marker), 'gpg.program should not have run').toBe(false);
    expect(markersPresent(markers)).toEqual([]);
  });
});

/**
 * The signing program git starts for an openpgp commit: a `#!/bin/sh` script that reads the commit
 * git wrote to it, writes a marker, tells git a signature was created on the status fd git watches,
 * and prints a dummy armored signature.
 *
 * The status line is what git actually looks for — the literal `"\n[GNUPG:] SIG_CREATED "` on
 * `--status-fd=2` — and the marker is what says this program ran, so a commit carrying a
 * `gpgsig` header built from it is a commit this program signed. No gpg is involved, and none is
 * needed: git accepts what the program writes, and no test here verifies the signature. Git for
 * Windows runs a `#!` script through its own sh, so the shebang is what makes this portable
 * rather than the executable bit.
 *
 * `openpgp` is the format it stands in for, and the reading of stdin is what that means: git
 * signs ssh by handing the program a path to sign and writing nothing at all, so a program that
 * waits for a commit to arrive waits forever.
 */
function fakeSigner(at: string, name: string): { path: string; marker: string } {
  const marker = join(at, `${name}.marker`);
  const path = join(at, `${name}.sh`);
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'cat > /dev/null',
      `: > '${forwardSlashes(marker)}'`,
      `printf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 FAKE\\n' >&2`,
      `printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZS1zaWduYXR1cmU=\\n-----END PGP SIGNATURE-----\\n'`,
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return { path, marker };
}

/**
 * A signing program that would be a failure if it ran: it writes its own marker and exits
 * non-zero, so the apply it was reached from fails as well. Two signals rather than one, because
 * a program that exits 0 with a signature would let a flow look intact while the wrong program
 * signed it.
 *
 * It reads nothing from stdin, and that is not an oversight. Git signs openpgp by writing the
 * commit to the program, but signs ssh by handing it a path to sign as an argument
 * (`-Y sign -n git -f <key> <file>`) and writing nothing at all — so a script that reads stdin to
 * the end hangs there forever, holding up the very cherry-pick whose failure it was written to
 * report.
 */
function markerProgram(at: string, name: string): { path: string; marker: string } {
  const marker = join(at, `${name}.marker`);
  const path = join(at, `${name}.sh`);
  writeFileSync(path, `#!/bin/sh\n: > '${forwardSlashes(marker)}'\nexit 1\n`);
  chmodSync(path, 0o755);
  return { path, marker };
}

/**
 * The full clean flow, the one `cherry-picks a validated candidate into a clean unchanged parent`
 * uses: snapshot, worktree, a file the agent changes, the agent's commit, and the apply that
 * cherry-picks it onto an unchanged clean parent.
 */
async function applyCleanCandidate(root: string, id: string): Promise<AgentApplyResult> {
  const snapshot = await createSyntheticSnapshot(root, true);
  expect(snapshot.dirty).toBe(false);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-signing-wt-'));
  roots.push(worktreeRoot);
  const worktree = await createAgentWorktree(snapshot, id, worktreeRoot);
  writeFileSync(join(worktree.path, 'staged.txt'), 'agent value\n');
  const candidate = await commitAgentWork(agentRecord(id, worktree), snapshot);
  expect(candidate).toBeDefined();
  return applyVerifiedCandidate(snapshot, candidate!);
}

describe('signing of the commit the cherry-pick applies (#348)', () => {
  it('signs as the global signer and never starts a program the repository named', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'book-apply-signing-'));
    roots.push(sandbox);
    const root = repository(join(sandbox, 'repo'));

    // The operator's own signer: the one program this cherry-pick is allowed to start, and the one
    // that has to sign — the applied commit lands in the operator's history.
    const signer = fakeSigner(sandbox, 'global-signer');
    writeGlobalConfig(
      `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${forwardSlashes(signer.path)}\n`,
    );

    // The repository's own signing configuration, every program it names armed to write its own
    // marker. The last one is reached only through a file `.git/config` includes, which is the
    // case a check reading `.git/config` alone would miss: git reports an included entry with
    // the scope of the file that included it.
    const program = markerProgram(sandbox, 'repo-gpg-program');
    const openpgp = markerProgram(sandbox, 'repo-gpg-openpgp-program');
    const ssh = markerProgram(sandbox, 'repo-gpg-ssh-program');
    const defaultKeyCommand = markerProgram(sandbox, 'repo-gpg-ssh-defaultkeycommand');
    const x509 = markerProgram(sandbox, 'repo-gpg-x509-program');
    const included = join(sandbox, 'included-signing.cfg');
    writeFileSync(included, `[gpg "x509"]\n\tprogram = ${forwardSlashes(x509.path)}\n`);
    git(root, 'config', 'gpg.program', forwardSlashes(program.path));
    git(root, 'config', 'gpg.openpgp.program', forwardSlashes(openpgp.path));
    git(root, 'config', 'gpg.format', 'ssh');
    git(root, 'config', 'gpg.ssh.program', forwardSlashes(ssh.path));
    git(root, 'config', 'gpg.ssh.defaultKeyCommand', forwardSlashes(defaultKeyCommand.path));
    git(root, 'config', 'user.signingKey', 'REPOSITORY-CHOSEN-KEY');
    git(root, 'config', '--add', 'include.path', forwardSlashes(included));

    // The control, and it is what makes the `gpg.ssh.program` marker mean something: with the
    // operator's `commit.gpgSign` and this repository's `gpg.format=ssh`, a plain commit in this
    // checkout does sign with the repository's ssh program, and fails. It says nothing about the
    // other two — see the loop below.
    expect(() => git(root, 'commit', '--allow-empty', '-m', 'control')).toThrow();
    expect(
      existsSync(ssh.marker),
      'the control commit should have started the repository gpg.ssh.program',
    ).toBe(true);
    rmSync(ssh.marker, { force: true });

    const applied = await applyCleanCandidate(root, 'repo-signing-agent');

    // The flow still has to do its job: a cherry-pick that refused to sign for a reason of its
    // own would satisfy every marker assertion as readily as the fix does.
    expect(applied.status).toBe('applied');
    expect(readFileSync(join(root, 'staged.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'agent value\n',
    );
    // `gpg.program` and `gpg.openpgp.program` are the programs a plain openpgp commit in this
    // checkout would start, so those two are a plain tripwire; `gpg.ssh.program` is the one the
    // control above is seen to start.
    for (const armed of [program, openpgp, ssh]) {
      expect(existsSync(armed.marker), `${armed.path} should not have run`).toBe(false);
    }
    // These two are assertions, not proof: no commit in this configuration can reach them. The
    // format in force is `ssh` for the control above and `openpgp` for the applied commit, so the
    // x509 program is only read for a third format, and `gpg.ssh.defaultKeyCommand` only when git
    // looks for an ssh key of its own — which this repository's `user.signingKey` answers, so it is
    // never consulted. They are kept because a pin that stopped neutralizing either would be a
    // defect worth seeing; what proves the include is live is the case below.
    for (const unreachable of [defaultKeyCommand, x509]) {
      expect(existsSync(unreachable.marker), `${unreachable.path} should not have run`).toBe(false);
    }
    // And the signing that does happen is the operator's, not the repository's: the global
    // signer ran, and what it produced is in the applied commit.
    expect(
      existsSync(signer.marker),
      'the global signer should have signed the applied commit',
    ).toBe(true);
    expect(git(root, 'cat-file', '-p', 'HEAD')).toContain('gpgsig -----BEGIN PGP SIGNATURE-----');
  });

  it('signs the applied commit with the signer the operator configured globally', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'book-apply-global-signing-'));
    roots.push(sandbox);
    const root = repository(join(sandbox, 'repo'));
    const signer = fakeSigner(sandbox, 'global-signer');
    writeGlobalConfig(
      `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${forwardSlashes(signer.path)}\n`,
    );
    // The repository configures nothing: this is the shape the cherry-pick had before any of it
    // was pinned, and the result has to be the same commit it always was.

    const applied = await applyCleanCandidate(root, 'globally-signed-agent');

    expect(applied.status).toBe('applied');
    expect(existsSync(signer.marker), 'the global signer should have run').toBe(true);
    const commit = git(root, 'cat-file', '-p', 'HEAD');
    expect(commit).toContain('gpgsig -----BEGIN PGP SIGNATURE-----');
    expect(commit).toContain('ZmFrZS1zaWduYXR1cmU=');
  });

  it('leaves the applied commit unsigned when the operator has configured no signing', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'book-apply-unsigned-'));
    roots.push(sandbox);
    const root = repository(join(sandbox, 'repo'));
    // The global config is the empty file every test in this file starts from, so there is no
    // signing program to run even in principle: git's own default is one this machine has no
    // reason to have a key for.
    const program = markerProgram(sandbox, 'repo-gpg-program');
    git(root, 'config', 'commit.gpgSign', 'true');
    git(root, 'config', 'gpg.program', forwardSlashes(program.path));

    // The control again: under this configuration a plain commit in the checkout is a signing
    // commit that starts the repository's program and fails.
    expect(() => git(root, 'commit', '--allow-empty', '-m', 'control')).toThrow();
    expect(
      existsSync(program.marker),
      'the control commit should have started the repository gpg.program',
    ).toBe(true);
    rmSync(program.marker, { force: true });

    const applied = await applyCleanCandidate(root, 'unsigned-agent');

    expect(applied.status).toBe('applied');
    expect(existsSync(program.marker), 'the repository gpg.program should not have run').toBe(
      false,
    );
    expect(git(root, 'cat-file', '-p', 'HEAD')).not.toContain('gpgsig');
  });

  it('never signs from a file the repository config includes', async () => {
    // The include case, live, and separate from the case above for the reason that case's own
    // comment now gives: there, the format in force is the operator's, so the included program is
    // never the one that would run and its marker proves nothing. Here nothing is in the
    // repository's `.git/config` at all — no `git config --local` ever wrote a signing key — and
    // everything comes from a file the config pulls in, which is how a clone arrives with its
    // signing already armed. Git reports an entry read that way with the scope of the file that
    // included it, so a check that only ever read `.git/config` itself would find nothing here.
    const sandbox = mkdtempSync(join(tmpdir(), 'book-apply-include-'));
    roots.push(sandbox);
    const root = repository(join(sandbox, 'repo'));
    const program = markerProgram(sandbox, 'included-gpg-program');
    const included = join(sandbox, 'included-signing.cfg');
    writeFileSync(
      included,
      `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${forwardSlashes(program.path)}\n`,
    );
    git(root, 'config', '--add', 'include.path', forwardSlashes(included));
    // The global config is the empty one every test in this file starts from, so the operator has
    // configured no signing at all and git's own default would leave the applied commit unsigned.
    expect(git(root, 'config', '--global', '--list')).toBe('');

    // The control, and here it is exact rather than partial: a plain commit in this checkout reads
    // the included file, starts the program it names, and fails, and `git config --show-scope`
    // reports the key in the `local` scope. Both halves are read back from a real git, so the
    // assertions below are about this fix rather than about a fixture that was never armed.
    expect(() => git(root, 'commit', '--allow-empty', '-m', 'control')).toThrow();
    expect(
      existsSync(program.marker),
      'the control commit should have started the included gpg.program',
    ).toBe(true);
    expect(git(root, 'config', '--show-scope', '--get', 'gpg.program')).toBe(
      `local\t${forwardSlashes(program.path)}`,
    );
    rmSync(program.marker, { force: true });

    const applied = await applyCleanCandidate(root, 'included-signing-agent');

    expect(applied.status).toBe('applied');
    expect(existsSync(program.marker), 'the included gpg.program should not have run').toBe(false);
    expect(git(root, 'cat-file', '-p', 'HEAD')).not.toContain('gpgsig');
  });
});

describe('a cherry-pick Book did not start (#348)', () => {
  it("refuses to apply over a pending one and leaves the operator's pick in place", async () => {
    // The pick in progress is the operator's: it owns the working tree and the index this would
    // write to, and Book starts a pick only so that it can abort the one it started. So the
    // refusal comes before anything is written, and the `--abort` that cleans up a failed apply
    // never runs — a rollback that reached this repository would destroy the operator's own
    // unfinished work.
    const root = repository();
    const snapshot = await createSyntheticSnapshot(root, true);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-pending-pick-wt-'));
    roots.push(worktreeRoot);
    const worktree = await createAgentWorktree(snapshot, 'pending-pick-agent', worktreeRoot);
    writeFileSync(join(worktree.path, 'staged.txt'), 'agent value\n');
    const candidate = await commitAgentWork(agentRecord('pending-pick-agent', worktree), snapshot);
    expect(candidate).toBeDefined();

    // The operator interrupts their own cherry-pick. The conflict is the point: it is what leaves
    // `CHERRY_PICK_HEAD` behind with the file in a conflicted state, which is exactly the state
    // Book has to recognize rather than write over.
    git(root, 'branch', 'operator-side');
    git(root, 'checkout', 'operator-side');
    writeFileSync(join(root, 'staged.txt'), 'operator value\n');
    git(root, 'commit', '-am', 'operator side');
    git(root, 'checkout', '-');
    writeFileSync(join(root, 'staged.txt'), 'agent value\n');
    git(root, 'commit', '-am', 'agent side');
    expect(() => git(root, 'cherry-pick', 'operator-side')).toThrow();
    expect(git(root, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).toBe(
      git(root, 'rev-parse', 'operator-side'),
    );
    const headBefore = git(root, 'rev-parse', 'HEAD');

    const applied = await applyVerifiedCandidate(snapshot, candidate!);

    expect(applied.status).toBe('conflicted');
    expect(applied.error).toContain('A cherry-pick is already in progress');
    // Still the operator's, still theirs to finish, and still mid-conflict: Book neither continued
    // it nor aborted it, the conflict markers it was left with are untouched, and nothing was
    // committed.
    expect(git(root, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).toBe(
      git(root, 'rev-parse', 'operator-side'),
    );
    expect(readFileSync(join(root, 'staged.txt'), 'utf8')).toContain('<<<<<<<');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
  });
});

describe('a signing configuration that cannot be read whole (#348)', () => {
  it('refuses to apply, and starts no cherry-pick, when the read is truncated', async () => {
    // The read fails open if a truncated answer is taken for an empty configuration, and
    // `git config --get-regexp` exits 1 for both "no match" and "nothing useful came back". A
    // repository can reach the second one: pad `.git/config` past the buffer the answer is read
    // into, with the signing keys after the padding, and truncation loses exactly the two keys
    // that would have been pinned. Resolving that as an empty answer would pin nothing and hand
    // the cherry-pick straight to the program the padding was there to hide.
    const sandbox = mkdtempSync(join(tmpdir(), 'book-apply-oversized-'));
    roots.push(sandbox);
    const root = repository(join(sandbox, 'repo'));
    const program = markerProgram(sandbox, 'oversized-gpg-program');

    const snapshot = await createSyntheticSnapshot(root, true);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-oversized-wt-'));
    roots.push(worktreeRoot);
    const worktree = await createAgentWorktree(snapshot, 'oversized-agent', worktreeRoot);
    writeFileSync(join(worktree.path, 'staged.txt'), 'agent value\n');
    const candidate = await commitAgentWork(agentRecord('oversized-agent', worktree), snapshot);
    expect(candidate).toBeDefined();

    // Padded after the candidate exists, so the only calls that pay to parse a 50+ MiB config
    // are the ones the apply itself makes. `MAX_BUFFER` is the size that answer is read into, so
    // the padding has to exceed it and the keys have to follow the padding, where a truncated
    // answer would never have seen them.
    appendFileSync(
      join(root, '.git', 'config'),
      `[gpg]\n\tpad = ${'x'.repeat(51 * 1024 * 1024)}\n\tprogram = ${forwardSlashes(
        program.path,
      )}\n[commit]\n\tgpgsign = true\n`,
    );
    // Read back rather than assumed: the fixture really does arm the program, so "no marker"
    // below is about Book.
    expect(git(root, 'config', '--show-scope', '--get', 'gpg.program')).toBe(
      `local\t${forwardSlashes(program.path)}`,
    );

    const applied = await applyVerifiedCandidate(snapshot, candidate!);

    // The security claim first, because it is the one that is not a nicety: no pick ran, so the
    // program the repository named never started, and there is nothing in the working tree for a
    // rollback to have rolled back.
    expect(applied.status).toBe('conflicted');
    expect(existsSync(program.marker), 'the repository gpg.program should not have run').toBe(
      false,
    );
    // Reported as what it is — a read that failed, before any pick started — rather than as a
    // cherry-pick that failed and was rolled back, which is what the same failure reported while
    // the read sat inside the pick's own `try`.
    expect(applied.error).toContain('Could not read the signing configuration');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(snapshot.baseHead);
    expect(() => git(root, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).toThrow();
    expect(readFileSync(join(root, 'staged.txt'), 'utf8')).toContain('base staged.txt');
    // Every git call in the apply re-reads and re-parses the whole padded config, which is about a
    // second a call here and eleven calls; the budget above is for that parse, not for a wait, and
    // every assertion above is about what the apply did.
  }, 120_000);
});

/**
 * A `git` on `PATH` that never exits: a shell script that records its own pid and then sleeps for
 * far longer than any test here will wait.
 *
 * The pid is what makes the kill observable. A timeout or an abort that rejects the promise while
 * the child lives on has not bounded anything — it has only stopped waiting — and on a busy
 * session that child is still holding a worktree, a lock, or a `.git/index.lock`.
 *
 * The shebang and `sleep` are what have to be portable rather than the executable bit: Git for
 * Windows runs a `#!` script through its own sh, but `execvp` finds a program on `PATH` by
 * extension there, which a file named `git` never gains, so the tests that use this are skipped
 * on win32 rather than quietly passing.
 */
function sleepingGit(name = 'git'): { dir: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'book-sleeping-git-'));
  roots.push(dir);
  const pidFile = join(dir, 'pid');
  writeFileSync(
    join(dir, name),
    [
      '#!/bin/sh',
      `printf '%s' "$$" > ${forwardSlashes(pidFile)}`,
      // `exec`, so the recorded pid is the sleeping process rather than a shell that has a child of
      // its own. A kill aimed at the shell would leave `sleep` alive and holding the output pipes,
      // which is a child nobody in this codebase ever waits on.
      'exec sleep 120',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, name), 0o755);
  return { dir, pidFile };
}

/**
 * A `git` on `PATH` that fails without saying anything: a command that exits with a code and no
 * output is the only way to see the message this code composes rather than git's own.
 */
function silentGit(exitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-silent-git-'));
  roots.push(dir);
  writeFileSync(join(dir, 'git'), ['#!/bin/sh', `exit ${exitCode}`, ''].join('\n'));
  chmodSync(join(dir, 'git'), 0o755);
  return dir;
}

/** Whether a process is still there, which is a claim about the OS and not about a promise. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Wait for a killed process to actually be gone, because a kill is a signal rather than a fact.
 *
 * The rejection and the kill are near-simultaneous, so asserting liveness the instant the promise
 * rejects is asserting about the scheduler rather than about the code. A second is far longer than
 * a killed process needs and far shorter than anything here is willing to wait for a hung one.
 */
async function waitForExit(pid: number, withinMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (processAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

describe('the internal git runner is bounded (#357)', () => {
  it.skipIf(process.platform === 'win32')(
    'kills a git that never exits, on both paths, and says which subcommand',
    async () => {
      for (const input of [undefined, 'a patch git never reads\n']) {
        const fake = sleepingGit();
        const previousPath = process.env.PATH;
        process.env.PATH = `${fake.dir}${delimiter}${previousPath ?? ''}`;
        try {
          const settled: { resolved?: RunResult; rejected?: Error } = await gitForTest(
            fake.dir,
            ['status'],
            {
              timeoutMs: 300,
              ...(input === undefined ? {} : { input }),
            },
          ).then(
            (result) => ({ resolved: result }),
            (error: Error) => ({ rejected: error }),
          );

          expect(
            settled.resolved,
            'the call must reject, not resolve on a hung child',
          ).toBeUndefined();
          const error = settled.rejected!;
          // The subcommand, not the flag in front of it: every argv here is the hardening's
          // `-c` pairs first, and `args[0]` is `-c`, so an error naming `args[0]` says nothing
          // about which command failed.
          expect(error.message).toMatch(/git status/);
          expect(error.message).toMatch(/timed out|timeout/i);
          const pid = Number(readFileSync(fake.pidFile, 'utf8'));
          expect(Number.isInteger(pid)).toBe(true);
          expect(await waitForExit(pid), `the hung git (pid ${pid}) should have been killed`).toBe(
            true,
          );
        } finally {
          process.env.PATH = previousPath;
        }
      }
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'stops a call when the signal it was given aborts',
    async () => {
      const fake = sleepingGit();
      const previousPath = process.env.PATH;
      process.env.PATH = `${fake.dir}${delimiter}${previousPath ?? ''}`;
      const controller = new AbortController();
      try {
        const pending = gitForTest(fake.dir, ['rev-parse', 'HEAD'], {
          signal: controller.signal,
          timeoutMs: 60_000,
        });
        const rejection = expect(pending).rejects.toThrow();
        setTimeout(() => controller.abort(), 150);
        await rejection;
        // Liveness again, not the rejection alone: a signal that rejected the promise and left
        // the child running has cancelled the wait rather than the work.
        await new Promise((done) => setTimeout(done, 200));
        const pid = Number(readFileSync(fake.pidFile, 'utf8'));
        expect(await waitForExit(pid), `the aborted git (pid ${pid}) should have been killed`).toBe(
          true,
        );
      } finally {
        process.env.PATH = previousPath;
      }
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'reports a killed child as a failure even where exit 1 would be accepted',
    async () => {
      // `removeAgentWorktree` accepts exit 1 and 128, because that is how `worktree remove` and
      // `branch -D` answer "already gone". A signalled child has no exit code at all, so reading
      // it as `codeValue ?? 1` made a killed git indistinguishable from one that said so — and a
      // signal-kill therefore read as a successful cleanup.
      const fake = sleepingGit();
      const previousPath = process.env.PATH;
      process.env.PATH = `${fake.dir}${delimiter}${previousPath ?? ''}`;
      try {
        await expect(
          gitForTest(fake.dir, ['-c', 'core.quotepath=false', 'branch', '-D', 'book-agent/x/y'], {
            timeoutMs: 300,
            allowExitCodes: [1, 128],
          }),
        ).rejects.toThrow(/git branch/);
      } finally {
        process.env.PATH = previousPath;
      }
    },
    20_000,
  );

  it.skipIf(process.platform === 'win32')(
    'names the subcommand behind the -c overrides a failed call carries',
    async () => {
      // A silent failing `git`, because that is the only call whose message this code composes: a
      // real git writes what went wrong to stderr, and Book prefers git's own words. Every argv here
      // carries the hardening's `-c key=value` pairs first, so a message built from `args[0]` names
      // `-c` — which is what the manifest read did, saying `git -c failed` and naming a flag rather
      // than the command (#357).
      const previousPath = process.env.PATH;
      process.env.PATH = `${silentGit(3)}${delimiter}${previousPath ?? ''}`;
      try {
        await expect(
          gitForTest(process.cwd(), [
            '-c',
            'core.quotepath=false',
            '-c',
            'core.abbrev=12',
            'rev-list',
            '--objects',
            'HEAD',
          ]),
        ).rejects.toThrow('git rev-list failed (3)');
      } finally {
        process.env.PATH = previousPath;
      }
    },
    20_000,
  );

  it('names a global option as well, and still reaches the subcommand past it', async () => {
    // The same argv hardening can carry `-C <path>`, whose value is a path rather than a setting,
    // and a value must never be mistaken for the command.
    const previousPath = process.env.PATH;
    process.env.PATH = `${silentGit(1)}${delimiter}${previousPath ?? ''}`;
    try {
      await expect(
        gitForTest(process.cwd(), ['-C', '.', 'diff', '--cached', '--quiet']),
      ).rejects.toThrow('git diff failed (1)');
    } finally {
      process.env.PATH = previousPath;
    }
  });
});

describe('a worktree add that fails after creating its branch (#357)', () => {
  it('leaves no branch behind, so the retry succeeds', async () => {
    const root = repository();
    const snapshot = await createSyntheticSnapshot(root, true);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-wt-retry-'));
    roots.push(worktreeRoot);
    const branch = `book-agent/${snapshot.repoHash}/retried-agent`;
    // A directory with something already in it, which is what `worktree add` refuses: it creates the
    // branch first and only then declines the checkout, and that ordering is what leaves the branch
    // behind.
    const path = join(worktreeRoot, snapshot.repoHash, 'retried-agent');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'occupied.txt'), 'not mine\n');

    await expect(createAgentWorktree(snapshot, 'retried-agent', worktreeRoot)).rejects.toThrow();
    // Read the branch back from a real git, and expect the branch to be gone: a failure that
    // leaves it is what makes every later attempt fail with "already exists".
    expect(() => git(root, 'show-ref', '--verify', `refs/heads/${branch}`)).toThrow();
    expect(git(root, 'worktree', 'list')).not.toContain('retried-agent');

    rmSync(path, { recursive: true, force: true });
    const worktree = await createAgentWorktree(snapshot, 'retried-agent', worktreeRoot);
    expect(worktree.branch).toBe(branch);
    expect(existsSync(worktree.path)).toBe(true);
    // And the branch it created is really there, which is the other half: the fix must not delete
    // the branch of a worktree add that succeeded.
    expect(git(root, 'rev-parse', `refs/heads/${branch}`)).toBe(snapshot.commit);
  });

  it('never deletes a branch that existed before the add', async () => {
    const root = repository();
    const snapshot = await createSyntheticSnapshot(root, true);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-wt-preexisting-'));
    roots.push(worktreeRoot);
    const branch = `book-agent/${snapshot.repoHash}/collides`;
    // The operator's own branch, with a commit of their own on it, under the name Book would use.
    git(root, 'branch', branch, 'HEAD');
    writeFileSync(join(root, 'operator.txt'), 'the operator\n');
    git(root, 'add', 'operator.txt');
    git(root, 'commit', '-m', 'operator work');
    git(root, 'branch', '-f', branch, 'HEAD');
    const operatorCommit = git(root, 'rev-parse', branch);
    const path = join(worktreeRoot, snapshot.repoHash, 'collides');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'occupied.txt'), 'not mine\n');

    await expect(createAgentWorktree(snapshot, 'collides', worktreeRoot)).rejects.toThrow();
    // Book did not create this one, so it is not Book's to delete: `branch -D` would destroy a
    // branch an operator had made, and the operator's own commit on it.
    expect(git(root, 'rev-parse', `refs/heads/${branch}`)).toBe(operatorCommit);
  });
});

describe('a cherry-pick that failed (#357)', () => {
  it('reports an infrastructure failure as a failure, not as a conflict', async () => {
    // The signer here is the operator's own global configuration, so the cherry-pick really does
    // sign and really does fail — the one apply failure that reaches this path routinely. Nothing
    // about the repository is wrong and no file conflicts; the pick dies creating its commit.
    const sandbox = mkdtempSync(join(tmpdir(), 'book-apply-sign-fail-'));
    roots.push(sandbox);
    const root = repository(join(sandbox, 'repo'));
    // Where HEAD has to be after a rolled-back pick: the pick never committed, so the rollback has
    // to leave the commit it started from rather than move it.
    const baseHead = git(root, 'rev-parse', 'HEAD');
    const signer = markerProgram(sandbox, 'operator-signer');
    writeGlobalConfig(
      `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${forwardSlashes(signer.path)}\n`,
    );

    const applied = await applyCleanCandidate(root, 'sign-failure-agent');

    // The control that makes this a signing failure rather than some other one: the program ran.
    expect(existsSync(signer.marker), 'the operator signer should have been started').toBe(true);
    expect(applied.status).not.toBe('applied');
    // A conflict is a claim about the working tree, and this one has none: git exited 128 with
    // nothing unmerged, so calling it a conflict would send the operator looking for markers that
    // are not there.
    expect(applied.status).not.toBe('conflicted');
    expect(applied.error).toContain('failed');
    // The rollback did happen, so nothing is left mid-pick, and the message may say so.
    expect(() => git(root, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD')).toThrow();
    expect(git(root, 'status', '--short')).toBe('');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(baseHead);
  });

  it('reads a real conflict as a conflict, and says the pick was rolled back', () => {
    // Unmerged paths are what makes a failure a conflict, and only that: the pick stopped with
    // files git could not merge and markers in them. Everything else that stops a cherry-pick is
    // the machinery failing, not the content.
    const conflicted = cherryPickFailureResult({
      pickError: 'error: could not apply 1a2b3c4... agent value',
      unmergedPaths: ['staged.txt'],
    });
    expect(conflicted.status).toBe('conflicted');
    expect(conflicted.error).toContain('rolled back');

    // A signing failure leaves the same CHERRY_PICK_HEAD behind and no unmerged paths, so the
    // pick is over and nothing about the working tree is a conflict.
    const signing = cherryPickFailureResult({
      pickError: 'gpg failed to sign the data',
      unmergedPaths: [],
    });
    expect(signing.status).not.toBe('conflicted');
    expect(signing.error).toContain('rolled back');
  });

  it('says the repository may be mid-pick when the rollback itself fails', () => {
    // The abort is a git call too, and it can fail: a repository that is no longer a repository,
    // a lock it cannot take, a filter that fails on the way out. Reporting that as a rollback
    // would leave an operator believing the working tree is clean when a pick is still in it, and
    // the next `git commit` of theirs would become part of the agent's.
    const failed = cherryPickFailureResult({
      pickError: 'error: could not apply',
      unmergedPaths: ['staged.txt'],
      abortError: 'git cherry-pick --abort failed (128)',
    });
    expect(failed.error).not.toMatch(/rolled back/);
    expect(failed.error).toMatch(/mid-cherry-pick/);
    expect(failed.error).toContain('git cherry-pick --abort');
    expect(failed.error).toContain('could not apply');
    // The status still reflects the conflict, which is a fact about the content; only the
    // rollback claim changed.
    expect(failed.status).toBe('conflicted');
  });
});

describe('ambient GIT_* variables in the internal git environment (#357)', () => {
  it('neither a GIT_DIR nor a GIT_INDEX_FILE redirects a snapshot or a worktree', async () => {
    const root = repository();
    const other = repository();
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-env-wt-'));
    roots.push(worktreeRoot);

    // Another checkout entirely, named the way the environment names one: `GIT_DIR` is where git
    // finds its repository, `GIT_INDEX_FILE` where it finds the index, and both outrank the
    // directory Book starts it in. A shell that exported them, a hook, or a CI step is enough.
    process.env.GIT_DIR = join(other, '.git');
    process.env.GIT_INDEX_FILE = join(other, 'book-index');
    writeFileSync(join(other, 'staged.txt'), 'other repository value\n');

    const snapshot = await createSyntheticSnapshot(root, true);
    const worktree = await createAgentWorktree(snapshot, 'env-agent', worktreeRoot);
    expect(readFileSync(join(worktree.path, 'staged.txt'), 'utf8').trim()).toBe('base staged.txt');
    writeFileSync(join(worktree.path, 'staged.txt'), 'agent value\n');
    const candidate = await commitAgentWork(agentRecord('env-agent', worktree), snapshot);
    expect(candidate).toBeDefined();

    // Every assertion below runs with the ambient variables gone, because the test's own `git` is a
    // plain child of this process and would otherwise read the same `GIT_DIR` the fixture set: a
    // failure here would then be about the assertion's own environment rather than about Book's.
    delete process.env.GIT_DIR;
    delete process.env.GIT_INDEX_FILE;

    expect(git(root, 'show', `${snapshot.commit}:staged.txt`)).toBe('base staged.txt');
    // Nothing of Book's landed in the other repository: no index, no ref, no worktree.
    expect(existsSync(join(other, 'book-index'))).toBe(false);
    expect(readFileSync(join(other, 'staged.txt'), 'utf8')).toBe('other repository value\n');
    // `worktree list` names every worktree with its commit and branch, so the claim is about how
    // many there are and which directory they are in: one, and `other` itself.
    const worktrees = git(other, 'worktree', 'list').split('\n').filter(Boolean);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toContain(join(other, ''));
    // The only change in the other repository is the one this fixture made to its own file; nothing
    // of Book's is staged there, and there is no index Book wrote to sit alongside it.
    expect(git(other, 'status', '--short')).toBe('M staged.txt');
  });

  it('still lets Book set GIT_INDEX_FILE for the calls that need a temporary one', async () => {
    // The scrub above is about the ambient environment. A call site that names an index of its
    // own — the snapshot's temporary index, the pre-check's — is Book's own decision and has to
    // survive, or the snapshot would stage into the parent index.
    const root = repository();
    const before = readFileSync(join(root, '.git', 'index'));
    const snapshot = await createSyntheticSnapshot(root, true);
    expect(snapshot.tree).toBe(git(root, 'rev-parse', `${snapshot.baseHead}^{tree}`));
    expect(readFileSync(join(root, '.git', 'index'))).toEqual(before);
  });
});

describe('removing a worktree the workspace no longer holds (#357)', () => {
  it('deletes the branch from outside the worktree, even when it is no longer a repository', async () => {
    const root = repository();
    const snapshot = await createSyntheticSnapshot(root, true);
    // Nested inside the repository, so the worktree's parent is a directory git can resolve a
    // repository from even after the worktree's own `.git` is gone.
    const nested = join(root, 'nested');
    const worktree = await createAgentWorktree(snapshot, 'orphaned-agent', nested);
    expect(existsSync(worktree.path)).toBe(true);
    const branch = `refs/heads/${worktree.branch}`;

    // The worktree's own repository is destroyed: its pointer file and the administrative
    // directory git keeps for it are both gone, which is what a worktree directory copied
    // elsewhere, or restored from a partial backup, looks like.
    rmSync(join(worktree.path, '.git'), { force: true });
    rmSync(join(root, '.git', 'worktrees', 'orphaned-agent'), { recursive: true, force: true });
    expect(existsSync(join(worktree.path, '.git'))).toBe(false);

    // No `repoRoot` given, which is the call that used to run git inside the directory it was
    // deleting: from there, git found no repository at all and the branch survived the cleanup
    // that was supposed to remove it.
    await removeAgentWorktree(agentRecord('orphaned-agent', worktree));

    expect(() => git(root, 'show-ref', '--verify', branch)).toThrow();
  });

  it('names the repository a live worktree points at, rather than the worktree itself', async () => {
    const root = repository();
    const snapshot = await createSyntheticSnapshot(root, true);
    const nested = join(root, 'nested');
    const worktree = await createAgentWorktree(snapshot, 'pointed-agent', nested);
    // The pointer a linked worktree keeps is how a cleanup with no `repoRoot` finds the
    // repository it belongs to, and that directory is outside the one it is about to delete.
    expect(readFileSync(join(worktree.path, '.git'), 'utf8')).toContain('gitdir:');

    await removeAgentWorktree(agentRecord('pointed-agent', worktree));

    expect(existsSync(worktree.path)).toBe(false);
    expect(() => git(root, 'show-ref', '--verify', `refs/heads/${worktree.branch}`)).toThrow();
  });

  it('removes both the worktree and the branch when the workspace is still there', async () => {
    const root = repository();
    const snapshot = await createSyntheticSnapshot(root, true);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'book-remove-wt-'));
    roots.push(worktreeRoot);
    const worktree = await createAgentWorktree(snapshot, 'removed-agent', worktreeRoot);

    await removeAgentWorktree(agentRecord('removed-agent', worktree), root);

    expect(existsSync(worktree.path)).toBe(false);
    expect(() => git(root, 'show-ref', '--verify', `refs/heads/${worktree.branch}`)).toThrow();
  });
});
