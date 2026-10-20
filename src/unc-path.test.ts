import { describe, expect, it, vi } from 'vitest';
import { isUncSpelling, reachesUncPath } from './unc-path.js';

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
