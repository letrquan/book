import { execFileSync, execSync } from 'child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
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
    expect(localSettingsTracking(join(dir, LOCAL))).toEqual({
      state: 'tracked',
      repository: dir,
      path: '.book/settings.local.json',
      direct: true,
    });
  });

  it('asks the index, not the disk: a tracked file deleted from the work tree still counts', () => {
    git(dir, 'init', '-q');
    write(join(dir, LOCAL));
    git(dir, 'add', '-f', '.book/settings.local.json');
    rmSync(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('tracked');
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
      repository: dir,
      path: 'packages/app/.book/settings.local.json',
      direct: false,
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

  it('is not put off by a large repository config, which `.gitmodules` can fill', () => {
    git(dir, 'init', '-q');
    write(join(dir, LOCAL));
    writeFileSync(join(dir, '.git', 'config'), `${'#'.repeat(2 * 1024 * 1024)}\n`);
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('untracked');
    git(dir, 'add', '-f', '.book/settings.local.json');
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('tracked');
  });

  it('reads a repository whose object names are SHA-256', () => {
    git(dir, 'init', '-q', '--object-format=sha256');
    write(join(dir, LOCAL));
    write(join(dir, 'a.txt'));
    git(dir, 'add', '-f', 'a.txt', '.book/settings.local.json');
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('tracked');
  });

  describe('a split index', () => {
    /** A repository whose tracked files are all in its shared index, the file among the last. */
    function splitRepository(): string {
      git(dir, 'init', '-q');
      for (let i = 0; i < 200; i++) write(join(dir, 'files', `f${String(i).padStart(3, '0')}.txt`));
      const workspace = join(dir, 'zz');
      write(join(workspace, LOCAL));
      git(dir, 'add', '-f', '.');
      git(dir, 'commit', '-q', '-m', 'base');
      git(dir, 'update-index', '--split-index');
      expect(readdirSync(join(dir, '.git')).some((n) => n.startsWith('sharedindex.'))).toBe(true);
      return workspace;
    }

    it('counts a path its shared index holds', () => {
      const workspace = splitRepository();
      expect(localSettingsTracking(join(workspace, LOCAL)).state).toBe('tracked');
    });

    it('counts a path only its own file lists', () => {
      git(dir, 'init', '-q');
      write(join(dir, 'a.txt'));
      git(dir, 'add', 'a.txt');
      git(dir, 'update-index', '--split-index');
      write(join(dir, LOCAL));
      git(dir, 'add', '-f', '.book/settings.local.json');
      expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('tracked');
    });

    it('counts a path whose shared entry was replaced', () => {
      const workspace = splitRepository();
      write(join(workspace, LOCAL), '{ "model": "changed" }');
      git(dir, 'add', '-f', 'zz/.book/settings.local.json');
      expect(git(dir, 'ls-files', 'zz').trim()).toBe('zz/.book/settings.local.json');
      expect(localSettingsTracking(join(workspace, LOCAL)).state).toBe('tracked');
    });

    it('stops counting a path `git rm --cached` deleted from it, as git does', () => {
      const workspace = splitRepository();
      git(dir, 'rm', '-q', '--cached', 'zz/.book/settings.local.json');
      expect(git(dir, 'ls-files', 'zz').trim()).toBe('');
      expect(localSettingsTracking(join(workspace, LOCAL)).state).toBe('untracked');
      git(dir, 'commit', '-q', '-m', 'untrack');
      expect(localSettingsTracking(join(workspace, LOCAL)).state).toBe('untracked');
    });

    it('ignores a leftover shared index its link does not name', () => {
      const workspace = splitRepository();
      git(dir, 'rm', '-q', '--cached', 'zz/.book/settings.local.json');
      git(dir, 'update-index', '--no-split-index');
      expect(readdirSync(join(dir, '.git')).some((n) => n.startsWith('sharedindex.'))).toBe(true);
      expect(localSettingsTracking(join(workspace, LOCAL)).state).toBe('untracked');
    });

    it('counts as unreadable when the shared index it names is missing', () => {
      const workspace = splitRepository();
      for (const name of readdirSync(join(dir, '.git'))) {
        if (name.startsWith('sharedindex.')) rmSync(join(dir, '.git', name));
      }
      write(join(dir, '.git', 'sharedindex.leftover'), 'x');
      expect(localSettingsTracking(join(workspace, LOCAL)).state).toBe('unknown');
    });

    it('reads one in a linked worktree', () => {
      git(dir, 'init', '-q');
      write(join(dir, 'README.md'));
      git(dir, 'add', 'README.md');
      git(dir, 'commit', '-q', '-m', 'base');
      const linked = join(dir, 'linked');
      git(dir, 'worktree', 'add', '-q', linked);
      write(join(linked, LOCAL));
      git(linked, 'add', '-f', '.book/settings.local.json');
      git(linked, 'update-index', '--split-index');
      expect(localSettingsTracking(join(linked, LOCAL)).state).toBe('tracked');
      git(linked, 'rm', '-q', '--cached', '.book/settings.local.json');
      expect(localSettingsTracking(join(linked, LOCAL)).state).toBe('untracked');
    });
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

  it('leaves the user’s file under a submodule entry nothing checked out', () => {
    // A submodule entry ships nothing into its folder until the submodule has its own `.git`.
    git(dir, 'init', '-q');
    git(dir, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},.book`);
    write(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('untracked');
  });

  it('leaves the user’s file under a directory a sparse index folds', () => {
    // A folded directory is one the checkout left out, so a file on disk there is not its doing.
    // The entry exists as soon as the repository tracks anything in that directory.
    git(dir, 'init', '-q');
    write(join(dir, 'kept', 'a.txt'));
    write(join(dir, '.book', 'settings.json'));
    git(dir, 'add', '-f', '.');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'sparse-checkout', 'set', '--cone', '--sparse-index', 'kept');
    write(join(dir, LOCAL));
    expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('untracked');
  });

  describe('another spelling of the path', () => {
    function listSpelling(spelling: string): void {
      git(dir, 'init', '-q');
      write(join(dir, LOCAL));
      const blob = git(dir, 'hash-object', '-w', '.book/settings.local.json').trim();
      git(dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},${spelling}`);
    }

    /** Runs `body` with `process.platform` saying `platform`. */
    function onPlatform(platform: NodeJS.Platform, body: () => void): void {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: platform });
      try {
        body();
      } finally {
        Object.defineProperty(process, 'platform', { value: original });
      }
    }

    it('is another file, unless the file system says it reaches this one', () => {
      listSpelling('.BOOK/settings.local.json');
      // Decided by the file system under test: Linux here, a folding one on other CI legs.
      const folds = existsSync(join(dir, '.BOOK', 'settings.local.json'));
      expect(localSettingsTracking(join(dir, LOCAL)).state).toBe(folds ? 'tracked' : 'untracked');
    });

    it('leaves the user’s file alone beside a different one in another case', () => {
      listSpelling('.book/SETTINGS.LOCAL.JSON');
      write(join(dir, '.book', 'SETTINGS.LOCAL.JSON'), '{ "model": "theirs" }');
      const folds = readdirSync(join(dir, '.book')).length === 1;
      expect(localSettingsTracking(join(dir, LOCAL)).state).toBe(folds ? 'tracked' : 'untracked');
    });

    it('says nothing about a save when the other spelling is another file', () => {
      listSpelling('.BOOK/settings.local.json');
      if (existsSync(join(dir, '.BOOK', 'settings.local.json'))) return;
      expect(localSettingsRefusal(join(dir, LOCAL))).toBeUndefined();
    });

    // Where spellings may alias, an entry reaching this file on disk counts however it reads. A
    // hard link stands in for what a folding file system does, so every leg runs these, on a
    // platform whose file systems are taken to fold. A real casefold mount was run by hand too.
    describe('where spellings may alias', () => {
      for (const spelling of [
        '.BOOK/settings.local.json',
        '.book/\u017Fettings.local.json',
        '.book/settings.local.j\u017Fon',
        '.boo\u212A/settings.local.json',
        '.bo\u200Cok/settings.local.json',
        'BOOK~1/settings.local.json',
      ]) {
        it(`counts ${JSON.stringify(spelling)} when it reaches this file`, () => {
          listSpelling(spelling);
          const alias = join(dir, spelling);
          if (!existsSync(alias)) {
            mkdirSync(dirname(alias), { recursive: true });
            linkSync(join(dir, LOCAL), alias);
          }
          onPlatform('darwin', () => {
            expect(localSettingsTracking(join(dir, LOCAL))).toMatchObject({
              state: 'tracked',
              path: spelling,
              direct: false,
            });
          });
        });

        it(`leaves ${JSON.stringify(spelling)} when it reaches another file`, () => {
          listSpelling(spelling);
          const alias = join(dir, spelling);
          // Only meaningful where the two really are different files.
          if (existsSync(alias)) return;
          mkdirSync(dirname(alias), { recursive: true });
          writeFileSync(alias, '{ "model": "theirs" }');
          onPlatform('darwin', () => {
            expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('untracked');
          });
        });
      }

      it('is not fooled by a spelling at another depth, or that sorts after the file', () => {
        listSpelling('zz/.book/\u017Fettings.local.json');
        onPlatform('darwin', () => {
          expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('untracked');
        });
      });
    });

    it.skipIf(process.platform === 'win32')(
      'does not take a tracked link in the other case for a folding file system',
      () => {
        git(dir, 'init', '-q');
        write(join(dir, LOCAL));
        symlinkSync('.book', join(dir, '.BOOK'));
        git(dir, 'add', '-f', '.BOOK');
        if (readdirSync(dir).filter((name) => name.toLowerCase() === '.book').length !== 2) return;
        expect(localSettingsTracking(join(dir, LOCAL)).state).toBe('untracked');
      },
    );
  });

  describe.skipIf(process.platform === 'win32')('links', () => {
    it('follows a tracked `.book` link to the file the index lists', () => {
      git(dir, 'init', '-q');
      write(join(dir, 'config', 'settings.local.json'));
      symlinkSync('config', join(dir, '.book'));
      git(dir, 'add', '-f', '.book', 'config/settings.local.json');
      expect(localSettingsTracking(join(dir, LOCAL))).toEqual({
        state: 'tracked',
        repository: dir,
        path: 'config/settings.local.json',
        direct: false,
      });
    });

    it('counts a tracked link in the file’s own place', () => {
      git(dir, 'init', '-q');
      write(join(dir, 'x.json'));
      mkdirSync(join(dir, '.book'));
      symlinkSync('../x.json', join(dir, LOCAL));
      git(dir, 'add', '-f', '.book/settings.local.json');
      expect(localSettingsTracking(join(dir, LOCAL))).toMatchObject({
        state: 'tracked',
        direct: true,
      });
    });

    it('counts an untracked link to a file the repository tracks', () => {
      git(dir, 'init', '-q');
      write(join(dir, 'x.json'));
      git(dir, 'add', 'x.json');
      mkdirSync(join(dir, '.book'));
      symlinkSync('../x.json', join(dir, LOCAL));
      expect(localSettingsTracking(join(dir, LOCAL))).toMatchObject({
        state: 'tracked',
        path: 'x.json',
        direct: false,
      });
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

    it('asks the repository a tracked link lands in, wherever that is', () => {
      const other = join(dir, 'other');
      mkdirSync(other);
      git(other, 'init', '-q');
      write(join(other, 'settings.local.json'));
      git(other, 'add', '-f', 'settings.local.json');
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      git(repo, 'init', '-q');
      symlinkSync('../other', join(repo, '.book'));
      git(repo, 'add', '-f', '.book');
      expect(localSettingsTracking(join(repo, LOCAL))).toMatchObject({
        state: 'tracked',
        repository: other,
        path: 'settings.local.json',
      });
    });

    it('leaves the user’s own link to a file another repository tracks: their dotfiles', () => {
      const dotfiles = join(dir, 'dotfiles');
      mkdirSync(dotfiles);
      git(dotfiles, 'init', '-q');
      write(join(dotfiles, 'book-local.json'));
      git(dotfiles, 'add', 'book-local.json');
      const repo = join(dir, 'repo');
      mkdirSync(join(repo, '.book'), { recursive: true });
      git(repo, 'init', '-q');
      symlinkSync(join(dotfiles, 'book-local.json'), join(repo, LOCAL));
      expect(localSettingsTracking(join(repo, LOCAL)).state).toBe('untracked');
    });

    it('leaves the user’s own `.book` link to a folder another repository tracks', () => {
      const dotfiles = join(dir, 'dotfiles');
      mkdirSync(dotfiles);
      git(dotfiles, 'init', '-q');
      write(join(dotfiles, 'settings.local.json'));
      git(dotfiles, 'add', '-f', 'settings.local.json');
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      git(repo, 'init', '-q');
      symlinkSync(dotfiles, join(repo, '.book'));
      expect(localSettingsTracking(join(repo, LOCAL)).state).toBe('untracked');
    });

    it('leaves a link in no repository at all', () => {
      const dotfiles = join(dir, 'dotfiles');
      mkdirSync(dotfiles);
      git(dotfiles, 'init', '-q');
      write(join(dotfiles, 'book-local.json'));
      git(dotfiles, 'add', 'book-local.json');
      const plain = join(dir, 'plain');
      mkdirSync(join(plain, '.book'), { recursive: true });
      symlinkSync(join(dotfiles, 'book-local.json'), join(plain, LOCAL));
      expect(localSettingsTracking(join(plain, LOCAL)).state).toBe('untracked');
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

  describe('the printed remedy works, run as printed', () => {
    /** Runs the command in the reason from the workspace, as a user would paste it. */
    function runRemedy(workspace: string): void {
      const reason = localSettingsRefusal(join(workspace, LOCAL));
      const command = /`(git [^`]+)`/.exec(reason ?? '')?.[1];
      expect(command).toBeDefined();
      execSync(command!, { cwd: workspace, stdio: 'pipe' });
      expect(localSettingsTracking(join(workspace, LOCAL)).state).toBe('untracked');
    }

    it('in the workspace’s own repository', () => {
      git(dir, 'init', '-q');
      write(join(dir, LOCAL));
      git(dir, 'add', '-f', '.book/settings.local.json');
      runRemedy(dir);
    });

    it('from a workspace in a subdirectory', () => {
      git(dir, 'init', '-q');
      const workspace = join(dir, 'packages', 'app');
      write(join(workspace, LOCAL));
      git(dir, 'add', '-f', 'packages/app/.book/settings.local.json');
      runRemedy(workspace);
    });

    it('when a repository above the nearest one lists it', () => {
      git(dir, 'init', '-q');
      const nested = join(dir, 'nested');
      write(join(nested, LOCAL));
      git(dir, 'add', '-f', 'nested/.book/settings.local.json');
      git(nested, 'init', '-q');
      runRemedy(nested);
    });

    it('when `.book` is a submodule that lists it', () => {
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
      runRemedy(parent);
    });

    it.skipIf(process.platform === 'win32')('when a link leads to what the index lists', () => {
      git(dir, 'init', '-q');
      write(join(dir, 'config', 'settings.local.json'));
      symlinkSync('config', join(dir, '.book'));
      git(dir, 'add', '-f', '.book', 'config/settings.local.json');
      runRemedy(dir);
    });

    it('when the index lists another spelling that reaches this file', () => {
      git(dir, 'init', '-q');
      write(join(dir, LOCAL));
      const blob = git(dir, 'hash-object', '-w', '.book/settings.local.json').trim();
      git(dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},.BOOK/settings.local.json`);
      if (!existsSync(join(dir, '.BOOK', 'settings.local.json'))) {
        mkdirSync(join(dir, '.BOOK'));
        linkSync(join(dir, LOCAL), join(dir, '.BOOK', 'settings.local.json'));
      }
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        runRemedy(dir);
      } finally {
        Object.defineProperty(process, 'platform', { value: original });
      }
    });
  });

  it('offers no command for an index path it cannot paste safely', () => {
    git(dir, 'init', '-q');
    write(join(dir, 'x$(id).json'));
    git(dir, 'add', 'x$(id).json');
    mkdirSync(join(dir, '.book'));
    if (process.platform === 'win32') return;
    symlinkSync('../x$(id).json', join(dir, LOCAL));
    const reason = localSettingsRefusal(join(dir, LOCAL));
    expect(reason).toContain('git tracks it');
    expect(reason).not.toContain('$(id)');
  });

  it.skipIf(process.platform === 'win32')('prints no control character from a path', () => {
    const module = join(dir, 'mod\u009b31m');
    mkdirSync(module);
    git(module, 'init', '-q');
    write(join(module, 'settings.local.json'));
    git(module, 'add', '-f', 'settings.local.json');
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q');
    symlinkSync(module, join(repo, '.book'));
    git(repo, 'add', '-f', '.book');
    const reason = localSettingsRefusal(join(repo, LOCAL));
    expect(reason).toContain('git tracks it');
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});
