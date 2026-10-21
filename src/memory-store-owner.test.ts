import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, type Stats } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findGitRoot } from './memory-store.js';

// Files another user owns cannot be made without root, so `lstatSync` and `statSync` report a
// different uid for the paths listed here; every other call passes through.
const { foreign } = vi.hoisted(() => ({ foreign: new Set<string>() }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const withOwner =
    <A extends unknown[]>(stat: (path: string, ...rest: A) => Stats) =>
    (path: string, ...rest: A): Stats => {
      const st = stat(path, ...rest);
      if (!foreign.has(String(path))) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as Stats, st, {
        uid: st.uid + 1,
      });
    };
  return {
    ...actual,
    lstatSync: withOwner(actual.lstatSync as (path: string) => Stats),
    statSync: withOwner(actual.statSync as (path: string) => Stats),
  };
});

let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'book-memory-owner-')));
});
afterEach(() => {
  foreign.clear();
  rmSync(scratch, { recursive: true, force: true });
});

/** `main` with a linked worktree `wt`, laid out as `git worktree add` writes it. */
function linkedWorktree(): { main: string; worktree: string } {
  const main = join(scratch, 'main');
  const entry = join(main, '.git', 'worktrees', 'wt');
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, 'commondir'), '../..\n');
  const worktree = join(scratch, 'wt');
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), `gitdir: ${entry}\n`);
  writeFileSync(join(entry, 'gitdir'), `${join(worktree, '.git')}\n`);
  return { main, worktree };
}

// #575: a removed worktree stays listed until it is pruned, and another user could plant a
// `.git` at its old path (a shared directory, `/tmp`) that passes the round trip.
describe('findGitRoot and the owner of a linked worktree', () => {
  it('maps a worktree whose .git and listing share an owner to its main checkout', () => {
    const { main, worktree } = linkedWorktree();

    expect(findGitRoot(worktree)).toBe(main);
  });

  it("keys a .git another user planted at a listed worktree's path by itself", () => {
    const { worktree } = linkedWorktree();
    foreign.add(join(worktree, '.git'));

    expect(findGitRoot(worktree)).toBe(worktree);
  });
});
