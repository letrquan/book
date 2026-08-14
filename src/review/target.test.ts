import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReviewTarget } from './target.js';

const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function scope(overrides: Record<string, unknown> = {}) {
  return { deep: false, fix: false, help: false, ...overrides } as {
    deep: boolean;
    fix: boolean;
    help: boolean;
    base?: string;
    target?: string;
  };
}

describe('resolveReviewTarget', () => {
  let root: string;
  let initial: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'book-review-target-'));
    roots.push(root);
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'book-tests@example.invalid');
    git(root, 'config', 'user.name', 'Book Tests');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'tracked.txt'), 'one\n', 'utf8');
    writeFileSync(join(root, 'src', 'module.ts'), 'export const value = 1;\n', 'utf8');
    writeFileSync(join(root, 'deleted.txt'), 'remove me\n', 'utf8');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'initial');
    initial = git(root, 'rev-parse', 'HEAD');
  });

  afterEach(() => {
    for (const path of roots.splice(0).reverse()) rmSync(path, { recursive: true, force: true });
  });

  it('captures staged, unstaged, and untracked changes from one working-tree snapshot', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'two\n', 'utf8');
    writeFileSync(join(root, 'src', 'module.ts'), 'export const value = 2;\n', 'utf8');
    git(root, 'add', 'src/module.ts');
    writeFileSync(join(root, 'new.txt'), 'new file\n', 'utf8');

    const target = await resolveReviewTarget(root, scope());

    expect(target.kind).toBe('working-tree');
    expect(target.baseSha).toBe(initial);
    expect(new Set(target.changedFiles)).toEqual(
      new Set(['tracked.txt', 'src/module.ts', 'new.txt']),
    );
    expect(target.diff).toContain('+two');
    expect(target.diff).toContain('+export const value = 2;');
    expect(target.diff).toContain('+new file');
  });

  it('honors path filters and includes a deleted path', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'outside\n', 'utf8');
    writeFileSync(join(root, 'src', 'module.ts'), 'export const value = 3;\n', 'utf8');

    const scoped = await resolveReviewTarget(root, scope({ target: 'src' }));
    expect(scoped.changedFiles).toEqual(['src/module.ts']);
    expect(scoped.diff).toContain('src/module.ts');
    expect(scoped.diff).not.toContain('tracked.txt');

    unlinkSync(join(root, 'deleted.txt'));
    const deleted = await resolveReviewTarget(root, scope({ target: 'deleted.txt' }));
    expect(deleted.changedFiles).toEqual(['deleted.txt']);
    expect(deleted.diff).toContain('deleted.txt');
    expect(deleted.diff).toContain('-remove me');
  });

  it('resolves --base against the merge base while preserving the current head snapshot', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'committed change\n', 'utf8');
    git(root, 'add', 'tracked.txt');
    git(root, 'commit', '-qm', 'second');
    const head = git(root, 'rev-parse', 'HEAD');
    writeFileSync(join(root, 'tracked.txt'), 'working change\n', 'utf8');

    const target = await resolveReviewTarget(root, scope({ base: initial }));

    expect(target.baseSha).toBe(initial);
    expect(target.kind).toBe('working-tree');
    expect(target.diff).toContain('+working change');
    expect(target.diff).not.toContain('+committed change');
    expect(head).not.toBe(initial);
  });

  it('resolves a committed base...head range and rejects invalid refs', async () => {
    writeFileSync(join(root, 'tracked.txt'), 'range change\n', 'utf8');
    git(root, 'add', 'tracked.txt');
    git(root, 'commit', '-qm', 'range');
    const head = git(root, 'rev-parse', 'HEAD');

    const target = await resolveReviewTarget(root, scope({ target: `${initial}...${head}` }));
    expect(target.kind).toBe('committed-range');
    expect(target.baseSha).toBe(initial);
    expect(target.headSha).toBe(head);
    expect(target.changedFiles).toEqual(['tracked.txt']);
    expect(target.diff).toContain('+range change');

    await expect(resolveReviewTarget(root, scope({ base: 'does-not-exist' }))).rejects.toThrow();
    await expect(
      resolveReviewTarget(root, scope({ target: `${initial}...does-not-exist` })),
    ).rejects.toThrow();
  });
});
