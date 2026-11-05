import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #579: nothing that is, or reaches through a link, a UNC location is touched, so no read sends a
 * request to a host a checkout named. The guard only answers on Windows, so it is stubbed here for
 * the one path under test, which any host can then run.
 */
const guard = vi.hoisted(() => ({ refused: (_path: string): boolean => false }));

vi.mock('./unc-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./unc-path.js')>()),
  reachesUncPath: (path: string) => guard.refused(path),
}));

const { localSettingsTracking } = await import('./local-settings-tracking.js');

let dir: string;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-local-unc-')));
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.book'));
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, '.book', 'settings.local.json'), '{}');
});

afterEach(() => {
  guard.refused = () => false;
  rmSync(dir, { recursive: true, force: true });
});

describe('a repository that reaches a share', () => {
  it('reads a repository whose files reach none', () => {
    expect(localSettingsTracking(join(dir, '.book', 'settings.local.json')).state).toBe(
      'untracked',
    );
  });

  it('counts as unreadable when HEAD reaches one, and is not opened', () => {
    guard.refused = (path) => path.endsWith('HEAD');
    expect(localSettingsTracking(join(dir, '.book', 'settings.local.json'))).toEqual({
      state: 'unknown',
      repository: dir,
    });
  });

  it('counts as unreadable when a link to the file reaches one', () => {
    guard.refused = (path) => path.endsWith('settings.local.json');
    expect(localSettingsTracking(join(dir, '.book', 'settings.local.json')).state).toBe('unknown');
  });
});
