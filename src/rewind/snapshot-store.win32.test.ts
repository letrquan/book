import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Rewind snapshots on Windows ask the UNC guard before they open a workspace's
 * `.book/rewindignore` or follow its git pointers to `HEAD`: one that is, or reaches through a
 * link, a network path is not opened. Run on any host, as the other `*.win32.test.ts` suites are
 * (`src/test/windows-links.ts`).
 */
const links = vi.hoisted(() => ({
  map: new Map<string, string>(),
  posixHost: process.platform !== 'win32',
}));

vi.mock('fs', async (importOriginal) =>
  (await import('../test/windows-links.js')).withWindowsLinks(await importOriginal(), links),
);

import * as fs from 'fs';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearSpies, touches, windowsSpelling } from '../test/windows-links.js';
import { createRewindSnapshotStore } from './snapshot-store.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const HASH = 'a'.repeat(40);
let tmp: string;
let ws: string;

beforeEach(() => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-rewind-links-')));
  ws = join(tmp, 'ws');
  mkdirSync(join(ws, '.book'), { recursive: true });
  writeFileSync(join(ws, 'kept.txt'), 'kept');
  writeFileSync(join(ws, 'skipped.txt'), 'skipped');
  links.map.clear();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  rmSync(tmp, { recursive: true, force: true });
});

/** A store for `ws`, used on stubbed Windows, counting only the calls `use` makes. */
function onWindows<T>(use: (store: ReturnType<typeof createRewindSnapshotStore>) => T): T {
  const store = createRewindSnapshotStore(ws, join(tmp, 'store'));
  clearSpies(fs);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  try {
    return use(store);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
}

/** A `.git` file naming `gitDir`, which holds a detached `HEAD`. */
function gitFile(gitDir: string): void {
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), `${HASH}\n`);
  writeFileSync(join(ws, '.git'), `gitdir: ${gitDir}\n`);
}

const readers = () => [fs.readFileSync, fs.existsSync, fs.openSync, fs.statSync];

describe('rewind snapshots on Windows with links to a network path', () => {
  it('does not open a .book/rewindignore that links to a share, and reads a local one', () => {
    writeFileSync(join(ws, '.book', 'rewindignore'), 'skipped.txt\n');
    const local = onWindows((store) => store.capture());
    expect(local.ok && local.manifest.entries.map((entry) => entry.path)).not.toContain(
      'skipped.txt',
    );
    expect(touches(fs.readFileSync, join(ws, '.book', 'rewindignore'))).toBe(true);

    links.map.set(windowsSpelling(join(ws, '.book', 'rewindignore')), '\\\\host\\share\\ignore');
    onWindows((store) => store.capture());
    for (const spy of readers()) {
      expect(touches(spy, join(ws, '.book', 'rewindignore'))).toBe(false);
    }
  });

  it('reads HEAD through a local git dir (the control)', () => {
    gitFile(join(tmp, 'gitdir'));
    expect(onWindows((store) => store.getCurrentGitHead())).toBe(HASH);
    expect(touches(fs.readFileSync, join(tmp, 'gitdir', 'HEAD'))).toBe(true);
  });

  it('does not follow a .git or a git dir that links to a share', () => {
    gitFile(join(tmp, 'gitdir'));
    links.map.set(windowsSpelling(join(tmp, 'gitdir')), '\\\\host\\share\\gitdir');
    expect(onWindows((store) => store.getCurrentGitHead())).toBeUndefined();
    for (const spy of readers()) expect(touches(spy, join(tmp, 'gitdir'))).toBe(false);

    links.map.clear();
    links.map.set(windowsSpelling(join(ws, '.git')), '\\\\host\\share\\.git');
    expect(onWindows((store) => store.getCurrentGitHead())).toBeUndefined();
    for (const spy of readers()) expect(touches(spy, join(ws, '.git'))).toBe(false);
  });

  it('does not read refs under a commondir that leads to a share', () => {
    const gitDir = join(tmp, 'gitdir');
    gitFile(gitDir);
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(gitDir, 'commondir'), '../common\n');
    mkdirSync(join(tmp, 'common', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(tmp, 'common', 'refs', 'heads', 'main'), `${HASH}\n`);
    expect(onWindows((store) => store.getCurrentGitHead())).toBe(HASH);

    links.map.set(windowsSpelling(join(tmp, 'common')), '\\\\host\\share\\common');
    expect(onWindows((store) => store.getCurrentGitHead())).toBeUndefined();
    for (const spy of readers()) expect(touches(spy, join(tmp, 'common'))).toBe(false);
  });

  // Spelled as UNC, a git dir only resolves as one through Windows' own `path`.
  it.runIf(process.platform === 'win32')('does not follow a git dir spelled as UNC', () => {
    writeFileSync(join(ws, '.git'), 'gitdir: //host/share/x\n');
    expect(onWindows((store) => store.getCurrentGitHead())).toBeUndefined();
    for (const spy of readers()) expect(touches(spy, '\\\\host\\share')).toBe(false);
  });
});
