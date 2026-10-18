import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findRepositoryRoot,
  formatSkippedNotice,
  projectContainmentRoot,
  refusalFor,
  tryRealPath,
} from './repo-containment.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-repo-containment-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('findRepositoryRoot', () => {
  it('finds the nearest directory with a .git directory', () => {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    mkdirSync(join(dir, 'repo', 'packages', 'a'), { recursive: true });

    expect(findRepositoryRoot(join(dir, 'repo', 'packages', 'a'))).toBe(join(dir, 'repo'));
    expect(findRepositoryRoot(join(dir, 'repo'))).toBe(join(dir, 'repo'));
  });

  it('treats a .git file (linked worktree, submodule) as its own root, not the main checkout', () => {
    mkdirSync(join(dir, 'main', '.git', 'worktrees', 'wt'), { recursive: true });
    mkdirSync(join(dir, 'wt', 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'wt', '.git'),
      `gitdir: ${join(dir, 'main', '.git', 'worktrees', 'wt')}\n`,
    );

    expect(findRepositoryRoot(join(dir, 'wt', 'src'))).toBe(join(dir, 'wt'));
  });

  it('prefers the nearest .git over an outer one', () => {
    mkdirSync(join(dir, 'outer', '.git'), { recursive: true });
    mkdirSync(join(dir, 'outer', 'inner', '.git'), { recursive: true });

    expect(findRepositoryRoot(join(dir, 'outer', 'inner'))).toBe(join(dir, 'outer', 'inner'));
  });

  it('returns undefined when no directory up the walk has a .git entry', () => {
    mkdirSync(join(dir, 'plain', 'sub'), { recursive: true });

    expect(findRepositoryRoot(join(dir, 'plain', 'sub'))).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('walks the logical path, not the real one', () => {
    mkdirSync(join(dir, 'real', 'ws'), { recursive: true });
    mkdirSync(join(dir, 'logical', '.git'), { recursive: true });
    symlinkSync(join(dir, 'real', 'ws'), join(dir, 'logical', 'ws'));

    expect(findRepositoryRoot(join(dir, 'logical', 'ws'))).toBe(join(dir, 'logical'));
  });
});

describe('projectContainmentRoot', () => {
  it('is the repository root, else the workspace itself', () => {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    mkdirSync(join(dir, 'repo', 'pkg'), { recursive: true });
    mkdirSync(join(dir, 'plain'), { recursive: true });

    expect(projectContainmentRoot(join(dir, 'repo', 'pkg'))).toBe(join(dir, 'repo'));
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
