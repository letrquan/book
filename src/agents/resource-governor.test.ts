import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWorktreeCapacity, formatBytes, freeDiskBytes } from './resource-governor.js';

const dirs: string[] = [];

function worktreeRootWith(repoHash: string, count: number): string {
  const root = mkdtempSync(join(tmpdir(), 'book-wt-'));
  dirs.push(root);
  for (let i = 0; i < count; i++) {
    mkdirSync(join(root, repoHash, `agent-${i}`), { recursive: true });
  }
  return root;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('checkWorktreeCapacity', () => {
  it('admits a spawn while under both limits', () => {
    const root = worktreeRootWith('repo', 2);
    const result = checkWorktreeCapacity({
      worktreeRoot: root,
      repoHash: 'repo',
      maxWorktrees: 8,
      minFreeDiskBytes: 1,
    });
    expect(result).toMatchObject({ ok: true, active: 2 });
  });

  it('refuses once the worktree count reaches the limit', () => {
    // Nothing reclaims worktrees outside the TUI, so on a long unattended run the
    // count only grows; this is the accumulation guard.
    const root = worktreeRootWith('repo', 3);
    const result = checkWorktreeCapacity({
      worktreeRoot: root,
      repoHash: 'repo',
      maxWorktrees: 3,
      minFreeDiskBytes: 0,
    });
    expect(result).toMatchObject({ ok: false, reason: 'worktree_limit', active: 3, limit: 3 });
    if (result.ok) return;
    expect(result.message).toContain('agents.maxWorktrees');
  });

  it('counts only the requesting repository', () => {
    const root = worktreeRootWith('repo-a', 3);
    mkdirSync(join(root, 'repo-b', 'agent-0'), { recursive: true });
    expect(
      checkWorktreeCapacity({
        worktreeRoot: root,
        repoHash: 'repo-b',
        maxWorktrees: 2,
        minFreeDiskBytes: 0,
      }),
    ).toMatchObject({ ok: true, active: 1 });
  });

  it('ignores stray files, counting only directories', () => {
    const root = worktreeRootWith('repo', 1);
    writeFileSync(join(root, 'repo', 'notes.txt'), 'x');
    expect(
      checkWorktreeCapacity({
        worktreeRoot: root,
        repoHash: 'repo',
        maxWorktrees: 2,
        minFreeDiskBytes: 0,
      }),
    ).toMatchObject({ ok: true, active: 1 });
  });

  it('refuses when free disk is below the floor', () => {
    // A worktree shares the filesystem with the workspace, so exhausting it breaks
    // the root agent's own Edit and Bash — not just the child's.
    const root = worktreeRootWith('repo', 0);
    const result = checkWorktreeCapacity({
      worktreeRoot: root,
      repoHash: 'repo',
      maxWorktrees: 0,
      minFreeDiskBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(result).toMatchObject({ ok: false, reason: 'disk_space' });
    if (result.ok) return;
    expect(result.message).toContain('free');
  });

  it('treats 0 as disabled for both checks', () => {
    const root = worktreeRootWith('repo', 50);
    expect(
      checkWorktreeCapacity({
        worktreeRoot: root,
        repoHash: 'repo',
        maxWorktrees: 0,
        minFreeDiskBytes: 0,
      }),
    ).toMatchObject({ ok: true });
  });

  it('does not refuse when free space cannot be read', () => {
    // Refusing every spawn because a platform did not answer would be a worse
    // failure than the one this guards against.
    expect(freeDiskBytes(join(tmpdir(), 'book-does-not-exist-xyz'))).toBeUndefined();
    expect(
      checkWorktreeCapacity({
        worktreeRoot: join(tmpdir(), 'book-does-not-exist-xyz'),
        repoHash: 'repo',
        maxWorktrees: 4,
        minFreeDiskBytes: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('formatBytes', () => {
  it('renders a readable magnitude', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});
