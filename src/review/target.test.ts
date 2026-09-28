import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

  /**
   * #324: a ref that starts with `-` is an option to git, not a ref, so a ref may not start with
   * one. These refs are typed by the user rather than by a model, which makes this defense in depth
   * rather than the fix itself, so it is rejected at the door: before the path check that shells
   * out, and before any ref reaches argv.
   */
  it('rejects a ref that git would read as an option, before any git call', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'book-review-plain-'));
    roots.push(plain);
    // `plain` is not a repository, so a git call from there fails with "not a git repository":
    // an error that is not that one says the ref never reached argv.
    await expect(resolveReviewTarget(plain, scope({ base: '--is-ancestor' }))).rejects.toThrow(
      'Invalid git ref: --is-ancestor',
    );
    await expect(
      resolveReviewTarget(root, scope({ target: '--is-ancestor...HEAD' })),
    ).rejects.toThrow('Invalid git ref: --is-ancestor');
    await expect(resolveReviewTarget(root, scope({ target: 'HEAD...-x' }))).rejects.toThrow(
      'Invalid git ref: -x',
    );
  });

  /**
   * The same threat the read-only Git tools are hardened against (#305, #324), on the path
   * `/review` takes to its diff: `.git/config` comes with the clone, so a checkout that sets
   * `core.fsmonitor` or `diff.external` to a program had that program run the moment a review
   * resolved its target — no prompt, because nothing here is a tool call. Checked against a real
   * git rather than by reading the flag list; the bare `git` calls in this test's own fixture are
   * what prove the config is capable of starting the program at all.
   */
  it.skipIf(process.platform === 'win32')(
    'resolves a target without running a program the repository config names',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'book-review-program-'));
      roots.push(outside);
      const program = (name: string) => join(outside, `${name}.sh`);
      const marker = (name: string) => join(outside, name);
      for (const name of ['fsmonitor', 'external']) {
        writeFileSync(program(name), `#!/bin/sh\ntouch "${marker(name)}"\nexit 0\n`, 'utf8');
        chmodSync(program(name), 0o755);
      }
      // `core.fsmonitor` is a command git runs to check whether the tree changed; `diff.external`
      // names the program that produces a diff. Both are settings the clone brings with it.
      git(root, 'config', 'core.fsmonitor', program('fsmonitor'));
      git(root, 'config', 'diff.external', program('external'));
      writeFileSync(join(root, 'tracked.txt'), 'changed under a hostile config\n', 'utf8');

      // Each setting is genuinely capable of running its program, or this asserts nothing. These
      // are the two calls the review itself makes, unhardened, in the same repository — so a
      // marker appearing here says the review would have run it too.
      git(root, 'diff', '--name-only');
      expect(existsSync(marker('fsmonitor'))).toBe(true);
      git(root, 'diff');
      expect(existsSync(marker('external'))).toBe(true);
      for (const name of ['fsmonitor', 'external']) rmSync(marker(name), { force: true });

      const target = await resolveReviewTarget(root, scope());

      expect(existsSync(marker('fsmonitor'))).toBe(false);
      expect(existsSync(marker('external'))).toBe(false);
      // And the review still is what it was: the change it is for is in the diff.
      expect(target.changedFiles).toEqual(['tracked.txt']);
      expect(target.diff).toContain('+changed under a hostile config');
    },
  );

  it('does not read an untracked symlink, only names it', async (ctx) => {
    // Every untracked entry was read whole, and a symlink resolves through itself: an
    // untracked link to a file outside the repository pasted that file's contents into the
    // review diff. The link is reported as a link, with the target it names.
    const outside = mkdtempSync(join(tmpdir(), 'book-review-secret-'));
    roots.push(outside);
    const secret = join(outside, 'credentials.txt');
    writeFileSync(secret, 'SECRET-CONTENT\n', 'utf8');
    try {
      symlinkSync(secret, join(root, 'link.txt'));
    } catch (error) {
      // Windows only lets an unprivileged process create a file symlink with Developer Mode on
      // or elevated; junction targets are exempt, which is why the other fixtures use them. The
      // assertion below needs a real file link, so skip where the privilege is missing rather
      // than fail at setup — CI's Windows runners are Developer Mode machines, so it runs there.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') ctx.skip();
      throw error;
    }

    const target = await resolveReviewTarget(root, scope());

    expect(target.changedFiles).toEqual(['link.txt']);
    expect(target.diff).not.toContain('SECRET-CONTENT');
    expect(target.diff).toContain('symlink');
    expect(target.diff).toContain(secret);
  });

  it.skipIf(process.platform === 'win32')('does not hang on an untracked FIFO', async () => {
    // A FIFO blocks a synchronous open until a writer arrives, so one must never be opened to
    // build a diff. It cannot be reproduced end to end: the list the review reads is git's, and
    // git's untracked listing names regular files and links only, so the FIFO never reaches the
    // read (it is absent from the diff below for that reason, not because it was opened). What
    // the timer holds is the property that matters — a read that blocked would fail here rather
    // than stall the suite — and what guards it is the same `lstat` the symlink case above is
    // decided by, on an entry that stopped being a regular file after git listed it.
    execFileSync('mkfifo', [join(root, 'pipe')], { stdio: ['ignore', 'pipe', 'pipe'] });
    expect(existsSync(join(root, 'pipe'))).toBe(true);

    const hung = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('resolveReviewTarget hung on a FIFO')), 5000),
    );
    const target = await Promise.race([resolveReviewTarget(root, scope()), hung]);

    expect(target.changedFiles).toEqual([]);
    expect(target.diff).not.toContain('pipe');
  });
});
