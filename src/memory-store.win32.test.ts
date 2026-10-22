import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Memory keying on Windows (`findGitRoot`) asks the UNC guard before it opens a git pointer: a
 * `.git`, git dir, `commondir` or worktree back-pointer that links to a network path is not
 * opened, and the directory is then keyed by itself. Run on any host, as the other
 * `*.win32.test.ts` suites are (`src/test/windows-links.ts`).
 */
const links = vi.hoisted(() => ({
  map: new Map<string, string>(),
  posixHost: process.platform !== 'win32',
}));

vi.mock('fs', async (importOriginal) =>
  (await import('./test/windows-links.js')).withWindowsLinks(await importOriginal(), links),
);

import * as fs from 'fs';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findGitRoot } from './memory-store.js';
import { clearSpies, touches, windowsSpelling } from './test/windows-links.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let tmp: string;
let ws: string;
let main: string;

/** A main checkout and a linked worktree `ws` that it lists back, as `git worktree add` writes them. */
function linkedWorktree(): string {
  const entry = join(main, '.git', 'worktrees', 'wt');
  mkdirSync(entry, { recursive: true });
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(entry, 'commondir'), '../..\n');
  writeFileSync(join(entry, 'gitdir'), `${join(ws, '.git')}\n`);
  writeFileSync(join(ws, '.git'), `gitdir: ${entry}\n`);
  return entry;
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'book-memory-links-')));
  ws = join(tmp, 'ws');
  main = join(tmp, 'main');
  links.map.clear();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  rmSync(tmp, { recursive: true, force: true });
});

/** Key `ws` on stubbed Windows, counting only the calls this makes. */
function keyOnWindows(): string {
  clearSpies(fs);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    return findGitRoot(ws);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
}

const readers = () => [fs.openSync, fs.readFileSync, fs.statSync, fs.realpathSync, fs.existsSync];

describe('memory keying on Windows with git pointers that link to a network path', () => {
  it('maps a listed worktree to its main checkout (the control)', () => {
    const entry = linkedWorktree();
    expect(windowsSpelling(keyOnWindows())).toBe(windowsSpelling(main));
    expect(touches(fs.openSync, join(entry, 'commondir'))).toBe(true);
    expect(touches(fs.openSync, join(entry, 'gitdir'))).toBe(true);
  });

  it('does not open a .git that links to a share', () => {
    linkedWorktree();
    links.map.set(windowsSpelling(join(ws, '.git')), '\\\\host\\share\\.git');
    expect(windowsSpelling(keyOnWindows())).toBe(windowsSpelling(ws));
    for (const spy of readers()) expect(touches(spy, join(ws, '.git'))).toBe(false);
  });

  it('does not open a git dir that links to a share', () => {
    const entry = linkedWorktree();
    links.map.set(windowsSpelling(entry), '\\\\host\\share\\wt');
    expect(windowsSpelling(keyOnWindows())).toBe(windowsSpelling(ws));
    for (const spy of readers()) expect(touches(spy, entry)).toBe(false);
  });

  it('does not open a commondir that links to a share, nor a common dir there', () => {
    const entry = linkedWorktree();
    links.map.set(windowsSpelling(join(entry, 'commondir')), '\\\\host\\share\\commondir');
    expect(windowsSpelling(keyOnWindows())).toBe(windowsSpelling(ws));
    for (const spy of readers()) expect(touches(spy, join(entry, 'commondir'))).toBe(false);

    links.map.clear();
    writeFileSync(join(entry, 'commondir'), '../../../../common-link\n');
    mkdirSync(join(tmp, 'common-link'));
    links.map.set(windowsSpelling(join(tmp, 'common-link')), '\\\\host\\share\\.git');
    expect(windowsSpelling(keyOnWindows())).toBe(windowsSpelling(ws));
    for (const spy of readers()) expect(touches(spy, join(tmp, 'common-link'))).toBe(false);
  });

  it('does not open a worktree back-pointer that links to a share', () => {
    const entry = linkedWorktree();
    links.map.set(windowsSpelling(join(entry, 'gitdir')), '\\\\host\\share\\gitdir');
    expect(windowsSpelling(keyOnWindows())).toBe(windowsSpelling(ws));
    for (const spy of readers()) expect(touches(spy, join(entry, 'gitdir'))).toBe(false);
  });

  // Spelled as UNC, a git dir only resolves as one through Windows' own `path`.
  it.runIf(process.platform === 'win32')('does not open a git dir spelled as UNC', () => {
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, '.git'), 'gitdir: \\\\host\\share\\wt\n');
    expect(windowsSpelling(keyOnWindows())).toBe(windowsSpelling(ws));
    for (const spy of readers()) expect(touches(spy, '\\\\host\\share')).toBe(false);
  });
});
