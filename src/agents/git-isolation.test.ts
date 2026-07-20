import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from './types.js';
import {
  applyVerifiedCandidate,
  commitAgentWork,
  createAgentWorktree,
  createSyntheticSnapshot,
} from './git-isolation.js';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'book-agent-git-'));
  roots.push(root);
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

afterEach(() => {
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
});
