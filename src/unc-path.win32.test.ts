import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #567: on Windows, every containment check refuses a path that is, or reaches through a link, a
 * UNC location before anything resolves it, since `realpath` would open the share and could send
 * the user's credentials to the host a repository named. Run on any host: the platform is stubbed
 * and the file system is a map, so a `realpath` call is an error the assertions can see.
 */
const fake = vi.hoisted(() => ({
  links: new Map<string, string>(),
  plain: new Set<string>(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const refuse = (path: string) => {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  };
  return {
    ...actual,
    lstatSync: vi.fn((path: string) => {
      if (fake.links.has(path)) return { isSymbolicLink: () => true };
      if (fake.plain.has(path)) return { isSymbolicLink: () => false };
      return refuse(path);
    }),
    readlinkSync: vi.fn((path: string) => fake.links.get(path) ?? refuse(path)),
    existsSync: vi.fn(() => false),
    realpathSync: Object.assign(vi.fn(refuse), { native: vi.fn(refuse) }),
  };
});

import { existsSync, realpathSync } from 'fs';
import { findRepositoryRoot, tryRealPath } from './repo-containment.js';
import { resolveMentionReadablePath } from './tools/path-utils.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  fake.links.clear();
  fake.plain.clear();
  for (const path of ['C:\\ws', 'C:\\ws\\docs']) fake.plain.add(path);
  fake.links.set('C:\\ws\\docs\\x.md', '\\\\attacker\\share\\y.md');
  vi.mocked(realpathSync).mockClear();
  vi.mocked(realpathSync.native).mockClear();
  vi.mocked(existsSync).mockClear();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
});

describe('containment on Windows with a UNC link (#567)', () => {
  it('tryRealPath refuses it without a realpath call, and still resolves a local path', () => {
    expect(tryRealPath('C:\\ws\\docs\\x.md')).toBeUndefined();
    expect(tryRealPath('\\\\attacker\\share\\y.md')).toBeUndefined();
    expect(realpathSync.native).not.toHaveBeenCalled();
    expect(realpathSync).not.toHaveBeenCalled();

    // The control: a local path does reach realpath, so the guard is what stopped the calls above.
    tryRealPath('C:\\ws\\docs');
    expect(realpathSync.native).toHaveBeenCalledWith('C:\\ws\\docs');
  });

  it('findRepositoryRoot probes nothing under a UNC workspace', () => {
    expect(findRepositoryRoot('\\\\attacker\\share\\proj')).toBeUndefined();
    expect(existsSync).not.toHaveBeenCalled();
    expect(realpathSync.native).not.toHaveBeenCalled();
  });

  it('the mention boundary refuses it as unc without a realpath call', () => {
    expect(resolveMentionReadablePath({ workspaceRoot: 'C:\\ws' }, 'C:\\ws\\docs\\x.md')).toEqual({
      reason: 'unc',
    });
    expect(realpathSync.native).not.toHaveBeenCalled();
    expect(realpathSync).not.toHaveBeenCalled();
  });
});
