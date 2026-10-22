import { describe, expect, it, vi } from 'vitest';
import { createUncGuard, isUncSpelling, reachesUncPath } from './unc-path.js';

/**
 * A Windows file system as a map: a link's path to its target, and the plain entries. The walk is
 * judged on any host through the injected probe, which is also what shows it never resolves.
 */
function windows(links: Record<string, string>, plain: string[]) {
  const lstat = vi.fn((path: string) => {
    if (path in links) return { isSymbolicLink: () => true };
    if (plain.includes(path)) return { isSymbolicLink: () => false };
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  });
  const readlink = vi.fn((path: string) => {
    if (!(path in links)) throw new Error(`EINVAL: ${path}`);
    return links[path];
  });
  return { platform: 'win32' as const, lstat, readlink };
}

const workspace = ['C:\\ws', 'C:\\ws\\docs'];

describe('reachesUncPath (#567)', () => {
  it('refuses a UNC spelling in either separator, and the namespace prefixes, without a probe', () => {
    const probe = windows({}, []);
    for (const path of [
      '\\\\host\\share\\y.md',
      '//host/share/y.md',
      '\\\\?\\UNC\\host\\share\\y.md',
      '\\\\.\\UNC\\host\\share',
    ]) {
      expect(isUncSpelling(path)).toBe(true);
      expect(reachesUncPath(path, probe)).toBe(true);
    }
    expect(probe.lstat).not.toHaveBeenCalled();
    expect(isUncSpelling('C:\\ws\\docs')).toBe(false);
    expect(isUncSpelling('\\ws\\docs')).toBe(false);
  });

  it('refuses a committed link to a UNC target, in either spelling', () => {
    for (const target of ['\\\\host\\share\\y.md', '//host/share/y.md']) {
      const probe = windows({ 'C:\\ws\\docs\\x.md': target }, workspace);
      expect(reachesUncPath('C:\\ws\\docs\\x.md', probe)).toBe(true);
      expect(probe.readlink).toHaveBeenCalledWith('C:\\ws\\docs\\x.md');
    }
  });

  it('follows a directory link and a relative link to the UNC target behind them', () => {
    const probe = windows(
      {
        'C:\\ws\\docs': 'D:\\shared',
        'D:\\shared\\x.md': '..\\hop.md',
        'D:\\hop.md': '\\\\host\\share\\y.md',
      },
      ['C:\\ws', 'D:\\shared'],
    );
    expect(reachesUncPath('C:\\ws\\docs\\x.md', probe)).toBe(true);
  });

  it('passes a local path, a local link, and a path that does not exist', () => {
    const probe = windows({ 'C:\\ws\\docs\\x.md': '..\\README.md' }, [
      ...workspace,
      'C:\\ws\\README.md',
    ]);
    expect(reachesUncPath('C:\\ws\\docs\\x.md', probe)).toBe(false);
    expect(reachesUncPath('C:\\ws\\docs\\missing\\y.md', probe)).toBe(false);
  });

  it('fails closed on a link it cannot read and on a cycle', () => {
    const unreadable = windows({}, workspace);
    unreadable.lstat.mockImplementation(() => ({ isSymbolicLink: () => true }));
    expect(reachesUncPath('C:\\ws\\docs\\x.md', unreadable)).toBe(true);

    const cycle = windows({ 'C:\\ws\\a': 'C:\\ws\\b', 'C:\\ws\\b': 'C:\\ws\\a' }, workspace);
    expect(reachesUncPath('C:\\ws\\a\\x.md', cycle)).toBe(true);
  });

  it('is false off Windows, where two leading slashes are a local path', () => {
    const probe = { ...windows({}, []), platform: 'linux' as const };
    expect(reachesUncPath('//host/share/y.md', probe)).toBe(false);
    expect(probe.lstat).not.toHaveBeenCalled();
  });
});

/** How many times the probe was asked about each path. */
function probeCounts(probe: ReturnType<typeof windows>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [path] of [...probe.lstat.mock.calls, ...probe.readlink.mock.calls]) {
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

describe('the UNC guard memoizes per call (#579)', () => {
  it('probes a prefix once when a link sends the walk back through it', () => {
    // `x.md` links to an absolute path under the workspace, so the walk restarts at `C:\` and
    // passes `C:\ws` a second time: the second pass is answered from what the first one learned.
    const probe = windows({ 'C:\\ws\\docs\\x.md': 'C:\\ws\\README.md' }, [
      ...workspace,
      'C:\\ws\\README.md',
    ]);
    expect(reachesUncPath('C:\\ws\\docs\\x.md', probe)).toBe(false);
    expect(probe.lstat).toHaveBeenCalledWith('C:\\ws\\README.md');
    expect(Object.fromEntries(probeCounts(probe))).toEqual({
      'C:\\ws': 1,
      'C:\\ws\\docs': 1,
      // lstat, then readlink.
      'C:\\ws\\docs\\x.md': 2,
      'C:\\ws\\README.md': 1,
    });
  });

  it('shares one guard across paths with a common prefix, with the same answers', () => {
    const links = { 'C:\\ws\\docs\\x.md': '\\\\host\\share\\y.md' };
    const plain = [...workspace, 'C:\\ws\\docs\\a.md', 'C:\\ws\\docs\\b.md'];
    const paths = ['C:\\ws\\docs\\a.md', 'C:\\ws\\docs\\b.md', 'C:\\ws\\docs\\x.md'];
    const expected = paths.map((path) => reachesUncPath(path, windows(links, plain)));
    expect(expected).toEqual([false, false, true]);

    const probe = windows(links, plain);
    const reachesUnc = createUncGuard(probe);
    // Twice over: the second round is answered without a probe.
    expect([...paths, ...paths].map((path) => reachesUnc(path))).toEqual([
      ...expected,
      ...expected,
    ]);
    expect(Object.fromEntries(probeCounts(probe))).toEqual({
      'C:\\ws': 1,
      'C:\\ws\\docs': 1,
      'C:\\ws\\docs\\a.md': 1,
      'C:\\ws\\docs\\b.md': 1,
      'C:\\ws\\docs\\x.md': 2,
    });
  });

  it('keeps a missing component and an unreadable link in the memo too', () => {
    const probe = windows({}, workspace);
    probe.lstat.mockImplementation((path: string) => {
      if (path === 'C:\\ws\\bad') return { isSymbolicLink: () => true };
      if (workspace.includes(path)) return { isSymbolicLink: () => false };
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    });
    const reachesUnc = createUncGuard(probe);
    for (let round = 0; round < 2; round++) {
      expect(reachesUnc('C:\\ws\\gone\\y.md')).toBe(false);
      expect(reachesUnc('C:\\ws\\bad\\y.md')).toBe(true);
    }
    expect(Object.fromEntries(probeCounts(probe))).toEqual({
      'C:\\ws': 1,
      'C:\\ws\\gone': 1,
      'C:\\ws\\bad': 2,
    });
  });

  it('is false off Windows without a probe, as reachesUncPath is', () => {
    const probe = { ...windows({}, []), platform: 'linux' as const };
    expect(createUncGuard(probe)('//host/share/y.md')).toBe(false);
    expect(probe.lstat).not.toHaveBeenCalled();
  });
});

describe('a UNC guard with roots the user chose', () => {
  it('takes a trusted root as given, on a share or through a link to one', () => {
    const fileSystem = () =>
      windows(
        {
          'C:\\extra': '\\\\nas\\data',
          '\\\\nas\\data\\away': '\\\\other\\share',
          '\\\\nas\\data\\near': '..\\data\\x',
        },
        ['C:\\', '\\\\nas\\data\\x'],
      );
    const plain = createUncGuard(fileSystem());
    const probe = fileSystem();
    const chosen = createUncGuard(probe, { trusted: ['\\\\nas\\data', 'C:\\extra'] });

    expect(plain('\\\\nas\\data\\x')).toBe(true);
    expect(chosen('\\\\nas\\data\\x')).toBe(false);
    expect(plain('C:\\extra\\x')).toBe(true);
    expect(chosen('C:\\extra\\x')).toBe(false);
    // The root itself and what is above it are not probed.
    expect(probe.lstat).not.toHaveBeenCalledWith('C:\\extra');
    // A link below it is followed: to elsewhere on the same root is fine, to another share is not.
    expect(chosen('\\\\nas\\data\\near')).toBe(false);
    expect(chosen('\\\\nas\\data\\away\\y')).toBe(true);
    // Other UNC locations are refused as before.
    expect(chosen('\\\\other\\share\\y')).toBe(true);
  });
});
