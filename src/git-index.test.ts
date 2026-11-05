import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGitIndex, visitGitIndex } from './git-index.js';

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
    maxBuffer: 64 * 1024 * 1024,
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

  it('reads an index larger than its read window, through all of it', () => {
    repository(dir, {});
    const object = git(dir, ['hash-object', '-w', '--stdin'], 'x').trim();
    const name = 'n'.repeat(200);
    const lines = Array.from(
      { length: 12_000 },
      (_, index) => `100644 ${object}\t${String(index).padStart(6, '0')}/${name}`,
    );
    git(dir, ['update-index', '--add', '--index-info'], `${lines.join('\n')}\n`);
    expect(statSync(join(dir, '.git', 'index')).size).toBeGreaterThan(2 * 1024 * 1024);

    const entries = readGitIndex(join(dir, '.git', 'index'), 20);
    expect(entries).toEqual(lsFiles(dir));
    expect(entries).toHaveLength(12_000);
  });

  it('is undefined with no index, and throws on a file that is not one', () => {
    git(dir, ['init', '-q']);
    expect(readGitIndex(join(dir, '.git', 'index'), 20)).toBeUndefined();
    writeFileSync(join(dir, '.git', 'index'), 'DIRC\0\0\0\x09\0\0\0\x01');
    expect(() => readGitIndex(join(dir, '.git', 'index'), 20)).toThrow();
  });
});

describe('visitGitIndex', () => {
  const walked = (gitDir: string): Array<{ path: string; mode: number }> => {
    const entries: Array<{ path: string; mode: number }> = [];
    visitGitIndex(gitDir, (path, mode) => {
      entries.push({ path, mode });
      return false;
    });
    return entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  };

  it('stops at the entry the visitor returns true for', () => {
    repository(dir, { a: '1', b: '2', c: '3' });
    const seen: string[] = [];
    visitGitIndex(join(dir, '.git'), (path) => {
      seen.push(path);
      return path === 'b';
    });
    expect(seen).toEqual(['a', 'b']);
  });

  it('visits nothing with no index', () => {
    git(dir, ['init', '-q']);
    expect(walked(join(dir, '.git'))).toEqual([]);
  });

  it('reads a SHA-256 repository, whatever its config holds', () => {
    git(dir, ['init', '-q', '--object-format=sha256']);
    write(dir, 'a.txt', '1');
    write(dir, 'b/c.txt', '2');
    git(dir, ['add', '.']);
    expect(walked(join(dir, '.git'))).toEqual(lsFiles(dir));
    // The config is not what says, so its contents and size are not the reader's concern.
    writeFileSync(join(dir, '.git', 'config'), `${'#'.repeat(2 * 1024 * 1024)}\n`);
    expect(walked(join(dir, '.git')).map((entry) => entry.path)).toEqual(['a.txt', 'b/c.txt']);
  });

  it('reads a SHA-1 repository whose config is larger than anything worth bounding', () => {
    repository(dir, { a: '1' });
    const config = join(dir, '.git', 'config');
    writeFileSync(config, `${'#'.repeat(2 * 1024 * 1024)}\n`);
    expect(walked(join(dir, '.git')).map((entry) => entry.path)).toEqual(['a']);
  });

  it('throws when neither object name length makes sense of the index', () => {
    repository(dir, { a: '1' });
    writeFileSync(join(dir, '.git', 'index'), 'DIRC\0\0\0\x02\0\0\0\x05');
    expect(() => walked(join(dir, '.git'))).toThrow();
  });

  it('lists what git lists for a split index, across deletes and replacements', () => {
    const tracked: Record<string, string> = {};
    for (let i = 0; i < 600; i++) tracked[`dir/f${String(i).padStart(4, '0')}`] = String(i);
    repository(dir, tracked);
    git(dir, ['update-index', '--split-index']);
    // Scattered deletes, so the bitmap holds runs of zeros and literal words. Each git process is
    // a slow start on Windows (this test timed out there at 15 of them), so the deletes go in one
    // `git rm`, the two additions in one `git add`, and there is no commit, which the split needs not.
    const deleted = [0, 1, 63, 64, 65, 200, 201, 599].map(
      (i) => `dir/f${String(i).padStart(4, '0')}`,
    );
    git(dir, ['rm', '-q', '--cached', '--', ...deleted]);
    write(dir, 'dir/f0300', 'changed');
    write(dir, 'new.txt', 'new');
    git(dir, ['add', '--', 'dir/f0300', 'new.txt']);

    expect(walked(join(dir, '.git')).map((entry) => entry.path)).toEqual(
      lsFiles(dir).map((entry) => entry.path),
    );
  });
});
