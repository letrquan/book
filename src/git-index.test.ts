import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGitIndex } from './git-index.js';

const GIT_IDENTITY = [
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.com',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'core.autocrlf=false',
];

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A repository at `root` that tracks `tracked` (relative path → content). */
function repository(root: string, tracked: Record<string, string>): void {
  git(root, ['init', '-q']);
  for (const [path, content] of Object.entries(tracked)) write(root, path, content);
  if (Object.keys(tracked).length > 0) git(root, ['add', '--', ...Object.keys(tracked)]);
}

/** Adds an index entry with no file behind it: `mode` 120000 a link, 160000 a submodule. */
function addIndexEntry(root: string, mode: string, path: string): void {
  const object =
    mode === '160000'
      ? 'a'.repeat(40)
      : git(root, ['hash-object', '-w', '--stdin'], 'target').trim();
  git(root, ['update-index', '--add', '--cacheinfo', `${mode},${object},${path}`]);
}

function lsFiles(root: string): Array<{ path: string; mode: number }> {
  return git(root, ['ls-files', '-s', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      return {
        mode: parseInt(record.slice(0, record.indexOf(' ')), 8),
        path: record.slice(tab + 1),
      };
    });
}

let dir: string;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-git-index-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readGitIndex', () => {
  const tracked = {
    '.a': 'a',
    '.book-x': 'b',
    '.book.x': 'c',
    '.book/agents/one.md': 'd',
    '.book/settings.json': 'e',
    '.book0': 'f',
    'src/deep/er/file.ts': 'g',
    'zz.txt': 'h',
  };

  for (const version of ['2', '3', '4']) {
    it(`lists what git lists in an index of version ${version}`, () => {
      repository(dir, tracked);
      // A name longer than the 12-bit length field records 0xFFF instead of its length.
      addIndexEntry(dir, '100644', Array.from({ length: 21 }, () => 'n'.repeat(200)).join('/'));
      addIndexEntry(dir, '120000', 'link');
      addIndexEntry(dir, '160000', 'module');
      git(dir, ['update-index', '--index-version', version]);
      if (version !== '2') git(dir, ['update-index', '--skip-worktree', '--', 'zz.txt']);

      expect(readGitIndex(join(dir, '.git', 'index'), 20)).toEqual(lsFiles(dir));
    });
  }

  it('stops before the first entry past the region asked for', () => {
    repository(dir, tracked);
    const entries = readGitIndex(join(dir, '.git', 'index'), 20, (path) => path >= '.book0');
    expect(entries?.map((entry) => entry.path)).toEqual([
      '.a',
      '.book-x',
      '.book.x',
      '.book/agents/one.md',
      '.book/settings.json',
    ]);
  });

  it('is undefined with no index, and throws on a file that is not one', () => {
    git(dir, ['init', '-q']);
    expect(readGitIndex(join(dir, '.git', 'index'), 20)).toBeUndefined();
    writeFileSync(join(dir, '.git', 'index'), 'DIRC\0\0\0\x09\0\0\0\x01');
    expect(() => readGitIndex(join(dir, '.git', 'index'), 20)).toThrow();
  });
});
