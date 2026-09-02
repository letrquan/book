import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inspectBranches, inspectPlans, inspectState, prVerdict } from './inspect.mjs';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function write(repo, path, content) {
  const target = join(repo, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

function commit(repo, message) {
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', message);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'book-next-inspector-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'next-test@example.com');
  git(repo, 'config', 'user.name', 'Next Test');
  return { root, repo };
}

test('state drift starts at the commit that last changed the snapshot', () => {
  const { root, repo } = fixture();
  try {
    write(
      repo,
      'docs/current-state.md',
      '# Book Current State\n\nSnapshot for Book as of 2001-01-01.\n',
    );
    write(repo, 'src/initial.ts', 'export const initial = true;\n');
    commit(repo, 'docs: add snapshot');
    const snapshotCommit = git(repo, 'rev-parse', 'HEAD');

    const freshState = inspectState(repo);
    assert.equal(freshState.snapshot.audit.useSnapshotWithoutSurfaceAudit, true);
    assert.equal(freshState.snapshot.audit.maximumSurfacesToVerify, 0);

    write(repo, 'src/feature.ts', 'export const feature = true;\n');
    write(repo, 'src/feature.test.ts', 'export const covered = true;\n');
    commit(repo, 'feat: add feature');

    const state = inspectState(repo);
    assert.equal(state.snapshot.commit, snapshotCommit);
    assert.equal(state.snapshot.commitsSince, 1);
    assert.deepEqual(state.snapshot.changedNonTestSourceFiles, ['src/feature.ts']);
    assert.equal(state.snapshot.audit.useSnapshotWithoutSurfaceAudit, false);
    assert.equal(state.snapshot.audit.maximumSurfacesToVerify, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drift baselines on origin/main when the local main ref is stale', () => {
  const { root, repo } = fixture();
  try {
    write(
      repo,
      'docs/current-state.md',
      '# Book Current State\n\nSnapshot for Book as of 2001-01-01.\n',
    );
    commit(repo, 'docs: add snapshot');

    // Simulate a linked worktree: origin/main advances, local main stays behind.
    git(repo, 'switch', '-c', 'landed');
    write(repo, 'src/shipped.ts', 'export const shipped = true;\n');
    commit(repo, 'feat: shipped upstream');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'switch', 'main');
    git(repo, 'branch', '-D', 'landed');

    const state = inspectState(repo);
    assert.equal(state.baseline.ref, 'origin/main');
    assert.equal(state.baseline.localMain.behindBaseline, 1);
    assert.match(state.baseline.warning, /local main is 1 commits behind origin\/main/);
    // Against stale local main this would read zero drift; against origin/main it is real.
    assert.equal(state.snapshot.commitsSince, 1);
    assert.deepEqual(state.snapshot.changedNonTestSourceFiles, ['src/shipped.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a branch already contained in origin/main is not PR-ready', () => {
  const { root, repo } = fixture();
  try {
    write(repo, 'base.txt', 'base\n');
    commit(repo, 'chore: initial');

    git(repo, 'switch', '-c', 'merged-upstream');
    write(repo, 'merged.txt', 'merged\n');
    commit(repo, 'feat: merged upstream');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'switch', 'main');

    const result = inspectBranches(repo, { github: false });
    const branch = result.branches.find((candidate) => candidate.name === 'merged-upstream');
    // Stale local main would call this READY FOR PR; origin/main already has it.
    assert.equal(branch.verdict, 'CONTAINED');
    assert.equal(branch.aheadOfBaseline, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prVerdict passes skipped checks and reports running CI', () => {
  const green = {
    isDraft: false,
    mergeable: 'MERGEABLE',
    statusCheckRollup: [
      { name: 'Stability', conclusion: 'SUCCESS' },
      { name: 'Security advisories', conclusion: 'SKIPPED' },
    ],
  };
  assert.equal(prVerdict(green, null), 'MERGE');

  const running = {
    isDraft: false,
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ name: 'Stability', conclusion: '', status: 'IN_PROGRESS' }],
  };
  assert.equal(prVerdict(running, null), 'CI RUNNING');

  const blocked = {
    isDraft: false,
    mergeable: 'MERGEABLE',
    statusCheckRollup: [{ name: 'Stability', conclusion: 'FAILURE' }],
  };
  assert.equal(prVerdict(blocked, null), 'CI BLOCKED');

  const computing = {
    isDraft: false,
    mergeable: 'UNKNOWN',
    statusCheckRollup: [{ name: 'Stability', conclusion: 'SUCCESS' }],
  };
  assert.equal(prVerdict(computing, null), 'MERGEABILITY UNKNOWN');
});

test('plan inspection strips Markdown emphasis from status labels', () => {
  const { root, repo } = fixture();
  try {
    write(
      repo,
      'plans/bold.md',
      '# Bold plan\n\n- **Status:** Phase 1 complete; Phase 2\n  remains active\n- **Owner:** Team\n',
    );
    write(repo, 'plans/current.md', '# Current plan\n\n- **Current status:** Active\n');
    write(repo, 'MILESTONES.md', '# Milestones\n\n- [ ] Finish the first\n  useful slice.\n');

    const result = inspectPlans(repo);
    const byPath = new Map(result.plans.map((plan) => [plan.path, plan.status]));
    assert.equal(byPath.get('plans/bold.md'), 'Phase 1 complete; Phase 2 remains active');
    assert.equal(byPath.get('plans/current.md'), 'Active');
    assert.deepEqual(result.uncheckedMilestones, [
      { line: 3, text: 'Finish the first useful slice.' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('branch inspection distinguishes conflicts from PR-ready branches', () => {
  const { root, repo } = fixture();
  try {
    write(repo, 'shared.txt', 'base\n');
    commit(repo, 'chore: initial');

    git(repo, 'switch', '-c', 'conflict');
    write(repo, 'shared.txt', 'branch\n');
    commit(repo, 'feat: branch change');

    git(repo, 'switch', 'main');
    write(repo, 'shared.txt', 'main\n');
    commit(repo, 'feat: main change');

    git(repo, 'switch', '-c', 'ready');
    write(repo, 'ready.txt', 'ready\n');
    commit(repo, 'feat: ready change');
    git(repo, 'switch', 'main');
    git(repo, 'branch', 'contained');
    git(repo, 'update-ref', 'refs/remotes/origin/remote-conflict', 'refs/heads/conflict');
    git(repo, 'update-ref', 'refs/remotes/origin/remote-contained', 'refs/heads/main');

    const result = inspectBranches(repo, { github: false });
    const byName = new Map(result.branches.map((branch) => [branch.name, branch]));
    assert.equal(byName.get('conflict').verdict, 'CONFLICTS');
    assert.equal(byName.get('ready').verdict, 'READY FOR PR');
    assert.equal(byName.get('contained').verdict, 'CONTAINED');
    assert.equal(byName.get('origin/remote-conflict').remoteOnly, true);
    assert.equal(byName.get('origin/remote-conflict').verdict, 'CONFLICTS');
    assert.equal(byName.get('origin/remote-contained').verdict, 'CONTAINED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a dirty linked worktree is always in progress', () => {
  const { root, repo } = fixture();
  try {
    write(repo, 'base.txt', 'base\n');
    commit(repo, 'chore: initial');
    git(repo, 'branch', 'active');
    const worktree = join(root, 'active-worktree');
    git(repo, 'worktree', 'add', worktree, 'active');
    writeFileSync(join(worktree, 'base.txt'), 'dirty\n');

    const result = inspectBranches(repo, { github: false });
    const active = result.branches.find((branch) => branch.name === 'active');
    assert.equal(active.verdict, 'IN PROGRESS');
    assert.equal(active.dirty, true);
    assert.deepEqual(active.checkedOutWorktrees, [worktree]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
