import { execFileSync } from 'child_process';
import {
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
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentApplyResult, AgentRecord } from './types.js';
import {
  applyVerifiedCandidate,
  commitAgentWork,
  createAgentWorktree,
  createSyntheticSnapshot,
  gitForTest,
  removeAgentWorktree,
  removeSnapshotRef,
} from './git-isolation.js';

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
});

afterEach(() => {
  if (savedBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = savedBookHome;
  if (savedGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedGitConfigGlobal;
  if (savedGitConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
  else process.env.GIT_CONFIG_SYSTEM = savedGitConfigSystem;
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

    // The control, and it is what makes the markers below mean something: with the operator's
    // `commit.gpgSign` and this repository's `gpg.format=ssh`, a plain commit in this checkout
    // signs with the repository's ssh program and fails. Without it, "no marker" would also be
    // true of a repository whose signing configuration was never live in the first place.
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
    for (const armed of [program, openpgp, ssh, defaultKeyCommand, x509]) {
      expect(existsSync(armed.marker), `${armed.path} should not have run`).toBe(false);
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
});
