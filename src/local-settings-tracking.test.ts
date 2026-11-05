import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  localSettingsRefusal,
  localSettingsTracking,
  unreadLocalSettingsReason,
} from './local-settings-tracking.js';

const LOCAL = join('.book', 'settings.local.json');

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();
}

function write(path: string, content = '{}'): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

let dir: string;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-local-tracking-')));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('localSettingsTracking', () => {
  it('is untracked outside any repository', () => {
    write(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL))).toEqual({ state: 'untracked' });
  });

  it('is untracked in a repository with no index yet', () => {
    git(dir, 'init', '-q');
    write(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL))).toEqual({ state: 'untracked' });
  });

  it('is untracked when the file is ignored or merely present', () => {
    git(dir, 'init', '-q');
    write(join(dir, 'README.md'));
    write(join(dir, '.gitignore'), '.book/settings.local.json\n');
    git(dir, 'add', 'README.md', '.gitignore');
    write(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL))).toEqual({ state: 'untracked' });
  });

  it('is tracked when the index lists it, ignored or not', () => {
    git(dir, 'init', '-q');
    write(join(dir, '.gitignore'), '.book/settings.local.json\n');
    write(join(dir, LOCAL));
    git(dir, 'add', '-f', '.gitignore', '.book/settings.local.json');
    expect(localSettingsTracking(join(dir, LOCAL))).toEqual({ state: 'tracked', direct: true });
  });

  it('asks the index, not the disk: a tracked file deleted from the work tree still counts', () => {
    git(dir, 'init', '-q');
    write(join(dir, LOCAL));
    git(dir, 'add', '-f', '.book/settings.local.json');
    rmSync(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL))).toEqual({ state: 'tracked', direct: true });
    expect(unreadLocalSettingsReason(join(dir, LOCAL))).toBeUndefined();
    expect(localSettingsRefusal(join(dir, LOCAL))).toContain('git rm --cached');
  });

  it('stops counting once `git rm --cached` takes it out of the index', () => {
    git(dir, 'init', '-q');
    write(join(dir, LOCAL));
    git(dir, 'add', '-f', '.book/settings.local.json');
    git(dir, 'rm', '-q', '--cached', '.book/settings.local.json');
    expect(localSettingsTracking(join(dir, LOCAL))).toEqual({ state: 'untracked' });
  });

  it('finds the repository above a workspace in a subdirectory', () => {
    git(dir, 'init', '-q');
    const workspace = join(dir, 'packages', 'app');
    write(join(workspace, LOCAL));
    git(dir, 'add', '-f', 'packages/app/.book/settings.local.json');
    expect(localSettingsTracking(join(workspace, LOCAL))).toEqual({
      state: 'tracked',
      direct: true,
    });
    // The same name at the root is another file.
    write(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL))).toEqual({ state: 'untracked' });
  });

  it('reads a path with bytes past ASCII as the index stores it', () => {
    git(dir, 'init', '-q');
    const workspace = join(dir, 'café');
    write(join(workspace, LOCAL));
    git(dir, '-c', 'core.quotepath=false', 'add', '-f', 'café/.book/settings.local.json');
    expect(localSettingsTracking(join(workspace, LOCAL)).state).toBe('tracked');
  });

  for (const version of ['2', '3', '4']) {
    it(`reads an index of version ${version}, stopping at the region it needs`, () => {
      git(dir, 'init', '-q');
      write(join(dir, LOCAL));
      write(join(dir, 'src', 'a.ts'));
      write(join(dir, '.a'));
      git(dir, 'add', '-f', '.');
      git(dir, 'update-index', '--index-version', version);
      expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('tracked');
    });
  }

  it('reads a repository whose object names are SHA-256', () => {
    git(dir, 'init', '-q', '--object-format=sha256');
    write(join(dir, LOCAL));
    write(join(dir, 'a.txt'));
    git(dir, 'add', '-f', 'a.txt', '.book/settings.local.json');
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('tracked');
  });

  it('reads a split index, whose own file lists only what changed', () => {
    git(dir, 'init', '-q');
    write(join(dir, LOCAL));
    git(dir, 'add', '-f', '.book/settings.local.json');
    git(dir, 'update-index', '--split-index');
    write(join(dir, 'other.txt'));
    git(dir, 'add', 'other.txt');
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('tracked');
  });

  it('reads a linked worktree through its `.git` file, from that worktree’s own index', () => {
    git(dir, 'init', '-q');
    write(join(dir, 'README.md'));
    git(dir, 'add', 'README.md');
    git(dir, 'commit', '-q', '-m', 'base');
    const linked = join(dir, 'linked');
    git(dir, 'worktree', 'add', '-q', linked);
    write(join(linked, LOCAL));
    expect(localSettingsTracking(join(linked, LOCAL)).state).toBe('untracked');
    git(linked, 'add', '-f', '.book/settings.local.json');
    expect(localSettingsTracking(join(linked, LOCAL)).state).toBe('tracked');
    write(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('untracked');
  });

  it('asks a nested repository, whose file its parent never lists', () => {
    git(dir, 'init', '-q');
    const nested = join(dir, 'vendor', 'nested');
    mkdirSync(nested, { recursive: true });
    git(nested, 'init', '-q');
    write(join(nested, LOCAL));
    expect(localSettingsTracking(join(nested, LOCAL)).state).toBe('untracked');
    git(nested, 'add', '-f', '.book/settings.local.json');
    expect(localSettingsTracking(join(nested, LOCAL)).state).toBe('tracked');
  });

  it('asks the repository above a nested one too: the file is shipped by whichever lists it', () => {
    git(dir, 'init', '-q');
    const nested = join(dir, 'nested');
    write(join(nested, LOCAL));
    git(dir, 'add', '-f', 'nested/.book/settings.local.json');
    git(nested, 'init', '-q');
    expect(localSettingsTracking(join(nested, LOCAL)).state).toBe('tracked');
  });

  it('counts `.book` itself being a submodule whose index lists the file', () => {
    const module = join(dir, 'module');
    mkdirSync(module);
    git(module, 'init', '-q');
    write(join(module, 'settings.local.json'));
    git(module, 'add', '-f', 'settings.local.json');
    git(module, 'commit', '-q', '-m', 'base');
    const parent = join(dir, 'parent');
    mkdirSync(parent);
    git(parent, 'init', '-q');
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', module, '.book');
    expect(localSettingsTracking(join(parent, LOCAL)).state).toBe('tracked');
  });

  it('keeps a workspace inside a submodule reading its own untracked file', () => {
    const module = join(dir, 'module');
    mkdirSync(module);
    git(module, 'init', '-q');
    write(join(module, 'README.md'));
    git(module, 'add', 'README.md');
    git(module, 'commit', '-q', '-m', 'base');
    const parent = join(dir, 'parent');
    mkdirSync(parent);
    git(parent, 'init', '-q');
    git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', module, 'sub');
    write(join(parent, 'sub', LOCAL));
    expect(localSettingsTracking(join(parent, 'sub', LOCAL)).state).toBe('untracked');
  });

  it('counts a submodule that is not initialized, since nothing below it can vouch for the file', () => {
    git(dir, 'init', '-q');
    git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},.book`);
    write(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('tracked');
  });

  it('counts a directory a sparse index folds, which may hold the file', () => {
    git(dir, 'init', '-q');
    write(join(dir, 'kept', 'a.txt'));
    write(join(dir, '.book', 'settings.json'));
    git(dir, 'add', '-f', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'sparse-checkout', 'set', '--cone', '--sparse-index', 'kept');
    write(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('tracked');
  });

  it('folds ASCII case, since a file system may', () => {
    git(dir, 'init', '-q');
    write(join(dir, LOCAL));
    const blob = git(dir, 'hash-object', '-w', '.book/settings.local.json').trim();
    git(dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},.BOOK/Settings.Local.JSON`);
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('tracked');
  });

  describe.skipIf(process.platform === 'win32')('links', () => {
    it('follows a tracked `.book` link to the file the index lists', () => {
      git(dir, 'init', '-q');
      write(join(dir, 'config', 'settings.local.json'));
      symlinkSync('config', join(dir, '.book'));
      git(dir, 'add', '-f', '.book', 'config/settings.local.json');
      expect(localSettingsTracking(join(dir, LOCAL))).toEqual({ state: 'tracked', direct: false });
    });

    it('counts a tracked link in the file’s own place', () => {
      git(dir, 'init', '-q');
      write(join(dir, 'x.json'));
      mkdirSync(join(dir, '.book'));
      symlinkSync('../x.json', join(dir, LOCAL));
      git(dir, 'add', '-f', '.book/settings.local.json');
      expect(localSettingsTracking(join(dir, LOCAL))).toEqual({ state: 'tracked', direct: true });
    });

    it('counts an untracked link to a file the repository tracks', () => {
      git(dir, 'init', '-q');
      write(join(dir, 'x.json'));
      git(dir, 'add', 'x.json');
      mkdirSync(join(dir, '.book'));
      symlinkSync('../x.json', join(dir, LOCAL));
      expect(localSettingsTracking(join(dir, LOCAL))).toEqual({ state: 'tracked', direct: false });
    });

    it('leaves a tracked `.book` link to a folder holding the user’s own untracked file', () => {
      git(dir, 'init', '-q');
      write(join(dir, 'shared', 'settings.json'));
      symlinkSync('shared', join(dir, '.book'));
      git(dir, 'add', '-f', '.book', 'shared/settings.json');
      write(join(dir, 'shared', 'settings.local.json'));
      expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('untracked');
    });

    it('leaves an untracked link to a file outside the repository', () => {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      git(repo, 'init', '-q');
      write(join(dir, 'mine.json'));
      mkdirSync(join(repo, '.book'));
      symlinkSync(join(dir, 'mine.json'), join(repo, LOCAL));
      expect(localSettingsTracking(join(repo, LOCAL)).state).toBe('untracked');
    });

    it('asks the repository a link lands in', () => {
      const other = join(dir, 'other');
      mkdirSync(other);
      git(other, 'init', '-q');
      write(join(other, 'settings.local.json'));
      git(other, 'add', '-f', 'settings.local.json');
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      git(repo, 'init', '-q');
      symlinkSync(other, join(repo, '.book'));
      expect(localSettingsTracking(join(repo, LOCAL)).state).toBe('tracked');
    });

    it('reads through a workspace reached by a link', () => {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      git(repo, 'init', '-q');
      write(join(repo, LOCAL));
      git(repo, 'add', '-f', '.book/settings.local.json');
      symlinkSync(repo, join(dir, 'alias'));
      expect(localSettingsTracking(join(dir, 'alias', LOCAL)).state).toBe('tracked');
    });
  });

  describe('what it cannot read counts as tracked', () => {
    it('a corrupt index', () => {
      git(dir, 'init', '-q');
      write(join(dir, LOCAL));
      writeFileSync(join(dir, '.git', 'index'), 'not an index');
      expect(localSettingsTracking(join(dir, LOCAL))).toEqual({
        state: 'unknown',
        repository: dir,
      });
    });

    it('an index cut short', () => {
      git(dir, 'init', '-q');
      write(join(dir, 'a.txt'));
      git(dir, 'add', 'a.txt');
      write(join(dir, LOCAL));
      writeFileSync(join(dir, '.git', 'index'), 'DIRC\0\0\0\x02\0\0\0\x05');
      expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('unknown');
    });

    it('an index of a version it does not know', () => {
      git(dir, 'init', '-q');
      write(join(dir, LOCAL));
      writeFileSync(join(dir, '.git', 'index'), 'DIRC\0\0\0\x09\0\0\0\x01');
      expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('unknown');
    });

    it('a `.git` file that names no git directory', () => {
      writeFileSync(join(dir, '.git'), 'this is not a pointer\n');
      write(join(dir, LOCAL));
      expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('unknown');
    });

    it('a `.git` file whose git directory is gone', () => {
      writeFileSync(join(dir, '.git'), `gitdir: ${join(dir, 'gone')}\n`);
      write(join(dir, LOCAL));
      expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('unknown');
    });

    it('but not a repository above the nearest one, which has nothing to say about it', () => {
      git(dir, 'init', '-q');
      writeFileSync(join(dir, '.git', 'index'), 'not an index');
      const nested = join(dir, 'nested');
      mkdirSync(nested);
      git(nested, 'init', '-q');
      write(join(nested, LOCAL));
      expect(localSettingsTracking(join(nested, LOCAL)).state).toBe('untracked');
    });
  });

  it('takes a `.git` directory git would not take as a repository as none', () => {
    mkdirSync(join(dir, '.git'));
    write(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('untracked');
  });

  it('takes no direction from GIT_DIR', () => {
    git(dir, 'init', '-q');
    write(join(dir, LOCAL));
    git(dir, 'add', '-f', '.book/settings.local.json');
    vi.stubEnv('GIT_DIR', join(dir, 'elsewhere'));
    try {
      expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('tracked');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('the reasons', () => {
  it('names the remedy for a tracked file, and nothing for an untracked one', () => {
    git(dir, 'init', '-q');
    write(join(dir, LOCAL));
    expect(unreadLocalSettingsReason(join(dir, LOCAL))).toBeUndefined();
    expect(localSettingsRefusal(join(dir, LOCAL))).toBeUndefined();
    git(dir, 'add', '-f', '.book/settings.local.json');
    const reason = unreadLocalSettingsReason(join(dir, LOCAL));
    expect(reason).toContain('git tracks it');
    expect(reason).toContain('`git rm --cached .book/settings.local.json`');
    expect(reason).not.toMatch(/\.$/);
    expect(localSettingsRefusal(join(dir, LOCAL))).toBe(reason);
  });

  it('says why it cannot tell when the index cannot be read', () => {
    git(dir, 'init', '-q');
    write(join(dir, LOCAL));
    writeFileSync(join(dir, '.git', 'index'), 'not an index');
    const reason = unreadLocalSettingsReason(join(dir, LOCAL));
    expect(reason).toContain('could not read the git index');
    expect(reason).toContain(dir);
    expect(reason).not.toContain('git rm');
  });

  it('asks nothing of an absent file when reading', () => {
    expect(unreadLocalSettingsReason(join(dir, LOCAL))).toBeUndefined();
    expect(unreadLocalSettingsReason('\0absent-settings-layer')).toBeUndefined();
  });
});
