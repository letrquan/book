import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyVerifiedCandidate,
  commitAgentWork,
  createAgentWorktree,
  createSyntheticSnapshot,
  currentWorkspaceFingerprint,
  findGitRoot,
} from './git-isolation.js';
import type { AgentRecord } from './types.js';

// A dotfiles repository at the home directory is no project (#567): taking it as the repository,
// a project under the home directory without its own `.git` snapshotted the whole home directory,
// untracked files included, and isolated patchers in worktrees of it.
describe('findGitRoot and a dotfiles ~/.git', () => {
  let root: string;
  let home: string;

  /** A real repository with one commit. */
  function repository(at: string): void {
    mkdirSync(at, { recursive: true });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: at, stdio: 'ignore' });
    git('init', '-q');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'base',
    );
  }

  beforeEach(() => {
    // The long form on Windows, as git reports it, not the runner's 8.3 temp path.
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-agent-home-')));
    home = join(root, 'home');
    repository(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('finds no repository for a project under the home directory without its own .git', async () => {
    const proj = join(home, 'proj');
    mkdirSync(proj);
    writeFileSync(join(proj, 'a.txt'), 'a\n');

    expect(await findGitRoot(proj)).toBeUndefined();
    await expect(createSyntheticSnapshot(proj)).rejects.toThrow(
      'Managed agents require a Git workspace',
    );
  });

  // The rule is for a project below the home directory (#579): a workspace that is the home
  // directory is in its repository, as git, which never stops at the directory it starts in, sees.
  it('finds the repository for a workspace that is the home directory', async () => {
    const top = await findGitRoot(home);
    expect(top).toBeDefined();
    expect(realpathSync(top!)).toBe(realpathSync(home));
  });

  it('keeps a project with its own .git under the home directory', async () => {
    const proj = join(home, 'proj');
    repository(proj);
    mkdirSync(join(proj, 'pkg'));

    const top = await findGitRoot(join(proj, 'pkg'));
    expect(top).toBeDefined();
    expect(realpathSync(top!)).toBe(realpathSync(proj));
  });

  // When the workspace is the home directory, its repository contains Book's own home directory
  // (`BOOK_HOME`, `~/.book` by default), which Book writes for as long as a run lasts: sessions,
  // agent records, and the agent worktrees themselves (#579). Isolation snapshots leave it out,
  // so the apply after such writes finds no drift.
  describe('a workspace that is the home directory', () => {
    let bookHome: string;
    const homeGit = (...args: string[]) => execFileSync('git', args, { cwd: home }).toString();

    /** A finished patcher's record for `worktree`. */
    function record(id: string, worktree: { path: string; branch: string }): AgentRecord {
      return {
        id,
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
    }

    beforeEach(() => {
      bookHome = join(home, '.book');
      vi.stubEnv('BOOK_HOME', bookHome);
      // The apply's cherry-pick commits as the operator.
      homeGit('config', 'user.name', 'Test');
      homeGit('config', 'user.email', 'test@example.com');
      // One file under it is tracked, as a dotfiles repository may track Book's settings.
      mkdirSync(join(bookHome, 'sessions'), { recursive: true });
      writeFileSync(join(bookHome, 'settings.json'), '{}\n');
      writeFileSync(join(home, 'notes.txt'), 'base\n');
      homeGit('add', '--', '.book/settings.json', 'notes.txt');
      homeGit('commit', '-q', '-m', 'dotfiles');
      writeFileSync(join(bookHome, 'sessions', 'before.jsonl'), '{}\n');
    });

    it('leaves Book’s home directory out, so a run writing there reports no drift', async () => {
      const snapshot = await createSyntheticSnapshot(home, true);
      // The default worktree root, `<BOOK_HOME>/worktrees`, inside the repository.
      const worktree = await createAgentWorktree(snapshot, 'patcher-home');
      expect(relative(bookHome, worktree.path).startsWith('..')).toBe(false);
      writeFileSync(join(worktree.path, 'notes.txt'), 'agent\n');
      const candidate = await commitAgentWork(record('patcher-home', worktree), snapshot);
      expect(candidate).toBeDefined();

      // The run goes on writing Book's state, the tracked file included.
      writeFileSync(join(bookHome, 'sessions', 'before.jsonl'), '{"more":true}\n');
      writeFileSync(join(bookHome, 'sessions', 'during.jsonl'), '{}\n');
      writeFileSync(join(bookHome, 'settings.json'), '{"changed":true}\n');

      const files = homeGit('ls-tree', '-r', '--name-only', snapshot.commit).split('\n');
      expect(files.filter((file) => file.startsWith('.book/'))).toEqual(['.book/settings.json']);
      expect(homeGit('show', `${snapshot.commit}:.book/settings.json`)).toBe('{}\n');
      expect(snapshot.dirty).toBe(false);
      expect(await currentWorkspaceFingerprint(snapshot.repoRoot, true)).toBe(snapshot.fingerprint);

      const applied = await applyVerifiedCandidate(snapshot, candidate!);
      expect(applied.status).toBe('applied');
      expect(readFileSync(join(home, 'notes.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('agent\n');
      // Book's state is left as the run wrote it.
      expect(readFileSync(join(bookHome, 'settings.json'), 'utf8')).toBe('{"changed":true}\n');
    });

    it('still reports drift outside Book’s home directory', async () => {
      const snapshot = await createSyntheticSnapshot(home, true);
      writeFileSync(join(home, 'notes.txt'), 'changed by hand\n');

      expect(await currentWorkspaceFingerprint(snapshot.repoRoot, true)).not.toBe(
        snapshot.fingerprint,
      );
    });
  });
});
