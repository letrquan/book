import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findRepositoryRoot,
  formatSkippedNotice,
  projectContainmentRoot,
  refusalFor,
  tryRealPath,
} from './repo-containment.js';

let dir: string;
// Roots are real paths; a Windows runner's temp directory has 8.3 short names in its logical path.
const real = (path: string) => realpathSync.native(path);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-repo-containment-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('findRepositoryRoot', () => {
  it('finds the nearest directory with a .git directory', () => {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    mkdirSync(join(dir, 'repo', 'packages', 'a'), { recursive: true });

    expect(findRepositoryRoot(join(dir, 'repo', 'packages', 'a'))).toBe(real(join(dir, 'repo')));
    expect(findRepositoryRoot(join(dir, 'repo'))).toBe(real(join(dir, 'repo')));
  });

  it('treats a .git file (linked worktree, submodule) as its own root, not the main checkout', () => {
    mkdirSync(join(dir, 'main', '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(join(dir, 'wt', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'wt', '.git'),
      `gitdir: ${join(dir, 'main', '.git', 'worktrees', 'wt')}\n`,
    );

    expect(findRepositoryRoot(join(dir, 'wt', 'src'))).toBe(real(join(dir, 'wt')));
  });

  it('prefers the nearest .git over an outer one', () => {
    mkdirSync(join(dir, 'outer', '.git'), { recursive: true });
    mkdirSync(join(dir, 'outer', 'inner', '.git'), { recursive: true });

    expect(findRepositoryRoot(join(dir, 'outer', 'inner'))).toBe(real(join(dir, 'outer', 'inner')));
  });

  it('returns undefined when no directory up the walk has a .git entry', () => {
    mkdirSync(join(dir, 'plain', 'sub'), { recursive: true });

    expect(findRepositoryRoot(join(dir, 'plain', 'sub'))).toBeUndefined();
  });

  // Like git, which starts from the real working directory: the root always holds the real path.
  it.skipIf(process.platform === 'win32')('walks the real path, not the logical one', () => {
    mkdirSync(join(dir, 'mono', '.git'), { recursive: true });
    mkdirSync(join(dir, 'mono', 'packages', 'a'), { recursive: true });
    mkdirSync(join(dir, 'outer', '.git'), { recursive: true });
    mkdirSync(join(dir, 'plain'), { recursive: true });
    // A workspace opened through a link finds the repository it is really in…
    symlinkSync(join(dir, 'mono', 'packages', 'a'), join(dir, 'pkg'));
    expect(findRepositoryRoot(join(dir, 'pkg'))).toBe(real(join(dir, 'mono')));
    // …and a link from inside a repository to a directory outside it is in no repository.
    symlinkSync(join(dir, 'plain'), join(dir, 'outer', 'ext'));
    expect(findRepositoryRoot(join(dir, 'outer', 'ext'))).toBeUndefined();
  });
});

// A dotfiles repository at the home directory would make every directory under it one repository,
// so a project without its own `.git` would be measured from the whole home directory.
describe('findRepositoryRoot and a dotfiles ~/.git', () => {
  let home: string;

  beforeEach(() => {
    home = join(dir, 'home');
    mkdirSync(join(home, '.git'), { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  it('is no repository: a project without its own .git under the home directory has none', () => {
    mkdirSync(join(home, 'proj', 'sub'), { recursive: true });

    expect(findRepositoryRoot(join(home, 'proj', 'sub'))).toBeUndefined();
    expect(findRepositoryRoot(home)).toBeUndefined();
    expect(projectContainmentRoot(join(home, 'proj'))).toBe(join(home, 'proj'));
  });

  it('leaves a project with its own .git under the home directory unaffected', () => {
    mkdirSync(join(home, 'repo', '.git'), { recursive: true });
    mkdirSync(join(home, 'repo', 'pkg'), { recursive: true });

    expect(findRepositoryRoot(join(home, 'repo', 'pkg'))).toBe(real(join(home, 'repo')));
    expect(projectContainmentRoot(join(home, 'repo', 'pkg'))).toBe(real(join(home, 'repo')));
  });

  it('takes the home directory as an argument', () => {
    mkdirSync(join(home, 'proj'), { recursive: true });
    mkdirSync(join(dir, 'other-home'), { recursive: true });

    expect(findRepositoryRoot(join(home, 'proj'), join(dir, 'other-home'))).toBe(real(home));
    expect(findRepositoryRoot(join(home, 'proj'), home)).toBeUndefined();
    expect(projectContainmentRoot(join(home, 'proj'), home)).toBe(join(home, 'proj'));
  });

  it.skipIf(process.platform === 'win32')('compares real paths: a home reached by a link', () => {
    mkdirSync(join(home, 'proj'), { recursive: true });
    symlinkSync(home, join(dir, 'home-link'));
    vi.stubEnv('HOME', join(dir, 'home-link'));

    expect(findRepositoryRoot(join(home, 'proj'))).toBeUndefined();
    expect(findRepositoryRoot(join(dir, 'home-link', 'proj'))).toBeUndefined();
  });
});

describe('projectContainmentRoot', () => {
  it('is the repository root, else the workspace itself', () => {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    mkdirSync(join(dir, 'repo', 'pkg'), { recursive: true });
    mkdirSync(join(dir, 'plain'), { recursive: true });

    expect(projectContainmentRoot(join(dir, 'repo', 'pkg'))).toBe(real(join(dir, 'repo')));
    expect(projectContainmentRoot(join(dir, 'plain'))).toBe(join(dir, 'plain'));
  });
});

describe('refusalFor', () => {
  it('refuses a target outside the root, and one that is not Markdown', () => {
    expect(refusalFor(join(dir, 'root'), join(dir, 'elsewhere', 'x.md'))).toBe('outside');
    expect(refusalFor(join(dir, 'root'), join(dir, 'root', '.env'))).toBe('not-markdown');
    expect(refusalFor(join(dir, 'root'), join(dir, 'root', 'docs', 'GUIDE.MD'))).toBeUndefined();
  });
});

describe('tryRealPath', () => {
  it('resolves an existing path and is undefined for a missing one', () => {
    writeFileSync(join(dir, 'a.md'), 'a');

    expect(tryRealPath(join(dir, 'a.md'))).toBe(realpathSync.native(join(dir, 'a.md')));
    expect(tryRealPath(join(dir, 'missing.md'))).toBeUndefined();
  });
});

describe('formatSkippedNotice', () => {
  const root = join(tmpdir(), 'ws-root');
  it('words an outside link and a non-Markdown target alike for every kind', () => {
    const entry = { path: join(root, 'REVIEW.md'), target: join(root, '..', 'y'), root };
    expect(formatSkippedNotice('review instructions', root, { ...entry, reason: 'outside' })).toBe(
      `⚠  Skipped review instructions REVIEW.md: it links to ${entry.target}, outside ${root}.`,
    );
    expect(formatSkippedNotice('project command', root, { ...entry, reason: 'not-markdown' })).toBe(
      `⚠  Skipped project command REVIEW.md: it links to ${entry.target}, which is not a Markdown (.md) file.`,
    );
  });

  it('strips control characters from repository-authored names', () => {
    const notice = formatSkippedNotice('project command', root, {
      path: join(root, 'a\u001b[31mb.md'),
      target: join(root, '..', 'y'),
      root,
      reason: 'outside',
    });

    expect(notice).not.toContain('\u001b');
  });
});
