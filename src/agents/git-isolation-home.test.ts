import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyntheticSnapshot, findGitRoot } from './git-isolation.js';

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
    expect(await findGitRoot(home)).toBeUndefined();
    await expect(createSyntheticSnapshot(proj)).rejects.toThrow(
      'Managed agents require a Git workspace',
    );
  });

  it('keeps a project with its own .git under the home directory', async () => {
    const proj = join(home, 'proj');
    repository(proj);
    mkdirSync(join(proj, 'pkg'));

    const top = await findGitRoot(join(proj, 'pkg'));
    expect(top).toBeDefined();
    expect(realpathSync(top!)).toBe(realpathSync(proj));
  });
});
