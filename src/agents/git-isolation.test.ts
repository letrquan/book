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
import type { AgentRecord } from './types.js';
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

beforeEach(() => {
  bookHome = mkdtempSync(join(tmpdir(), 'book-home-'));
  roots.push(bookHome);
  process.env.BOOK_HOME = bookHome;
});

afterEach(() => {
  if (savedBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = savedBookHome;
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
  const sh = (path: string) => path.replace(/\\/g, '/');
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
    const sh = (path: string) => path.replace(/\\/g, '/');
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
