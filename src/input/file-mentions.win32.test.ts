import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #579: on Windows the `@` candidate walk must not open a network share a repository named with a
 * committed link. tinyglobby follows links: fdir `realpath`s each link entry, `stat`s what it
 * resolved to and lists a linked directory, and on Windows resolving `\\host\share` sends an SMB
 * request (and the user's NTLM credentials) to `host`. Run on any host: the platform is stubbed,
 * the walk runs over a real directory, and the UNC guard sees the links the map below declares,
 * keyed by their Windows spelling. `realpath`, the one call that follows a link, is spied, so a
 * call that reached a share is an assertion failure, and a local link that still resolves is the
 * control; what a refused link would have listed is absent from the answer.
 */
const fake = vi.hoisted(() => {
  // Read before any test stubs the platform.
  const posixHost = process.platform !== 'win32';
  return {
    /** A path's Windows spelling, to the target the guard is told it links to. */
    links: new Map<string, string>(),
    /**
     * The host's own spelling of a path the guard asks about. On a POSIX host it asks about
     * `\tmp\…`, the Windows spelling of `/tmp/…`; on Windows the two are the same.
     */
    onHost: (path: string) =>
      posixHost && /^\\(?!\\)/.test(path) ? path.replace(/\\/g, '/') : path,
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const stats = (link: boolean) => ({
    isSymbolicLink: () => link,
    isDirectory: () => false,
    isFile: () => false,
  });
  return {
    ...actual,
    lstatSync: vi.fn((path: string) =>
      fake.links.has(path) ? stats(true) : actual.lstatSync(fake.onHost(path)),
    ),
    readlinkSync: vi.fn(
      (path: string) => fake.links.get(path) ?? actual.readlinkSync(fake.onHost(path)),
    ),
    existsSync: vi.fn(actual.existsSync),
    realpath: vi.fn(actual.realpath),
  };
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpath,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, win32 } from 'path';
import { getFileMentionCandidates } from './file-mentions.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const windows = (path: string) => win32.resolve(path);

/** The paths a spied `fs` call was handed, as strings. */
function calledWith(spy: unknown): string[] {
  return (spy as { mock: { calls: unknown[][] } }).mock.calls.map(([path]) => String(path));
}

const touches = (paths: string[], dir: string) =>
  paths.some(
    (path) => windows(path) === windows(dir) || windows(path).startsWith(`${windows(dir)}\\`),
  );

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'book-unc-mentions-'));
  fake.links.clear();
  for (const spy of [existsSync, realpath]) vi.mocked(spy).mockClear();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  rmSync(tmp, { recursive: true, force: true });
});

describe('the @ candidate walk on Windows with a UNC link (#579)', () => {
  it('neither resolves nor lists a link to a share, and still follows a local link', async () => {
    const ws = join(tmp, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'app.ts'), 'app');
    // What the share would serve, and a local directory a committed link may name.
    for (const [dir, file] of [
      ['share', 'secret.ts'],
      ['local', 'lib.ts'],
    ]) {
      mkdirSync(join(tmp, dir));
      writeFileSync(join(tmp, dir, file), dir);
    }
    // Real links on disk, so the walk meets link entries (a junction needs no privilege on Windows).
    symlinkSync(join(tmp, 'share'), join(ws, 'share'), 'junction');
    symlinkSync(join(tmp, 'local'), join(ws, 'local'), 'junction');

    fake.links.set(windows(join(ws, 'share')), '\\\\attacker\\share');
    fake.links.set(windows(join(ws, 'local')), windows(join(tmp, 'local')));

    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const paths = (await getFileMentionCandidates(ws, '')).map((candidate) => candidate.path);

    expect(paths).toEqual(expect.arrayContaining(['src/app.ts', 'local/', 'local/lib.ts']));
    expect(paths.filter((path) => path.startsWith('share'))).toEqual([]);

    expect(touches(calledWith(realpath), join(ws, 'share'))).toBe(false);
    // The control: the walk resolves links through the spied `realpath`, and the local one does.
    expect(touches(calledWith(realpath), join(ws, 'local'))).toBe(true);
  });

  it('walks nothing under a UNC workspace, and reads none of its files', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    expect(await getFileMentionCandidates('\\\\attacker\\share\\proj', '')).toEqual([]);
    for (const spy of [existsSync, realpath]) {
      expect(calledWith(spy).filter((path) => path.includes('attacker'))).toEqual([]);
    }
  });
});
