import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(
  () =>
    [] as Array<{
      args: string[];
      options: {
        signal?: AbortSignal;
        env?: NodeJS.ProcessEnv;
        timeout?: number;
        windowsHide?: boolean;
      };
      callback: (error: Error | null, stdout: string) => void;
    }>,
);

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      env?: NodeJS.ProcessEnv;
      timeout?: number;
      windowsHide?: boolean;
    },
    callback: (error: Error | null, stdout: string) => void,
  ) => calls.push({ args, options, callback }),
}));

import { hardenedGitArgs } from '../../tools/git.js';
import { REPOSITORY_PROGRAM_CONFIG_PATTERN } from '../../tools/git-repository-programs.js';
import { isInsideWorkTree, sameStatus, useGitStatus } from './useGitStatus.js';

const roots: string[] = [];

function Harness({ workspace }: { workspace: string }) {
  useGitStatus(workspace);
  return null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  calls.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('useGitStatus', () => {
  it('skips overlapping polls and aborts owned work on unmount', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'book-git-status-'));
    roots.push(workspace);
    mkdirSync(join(workspace, '.git'));
    const view = render(<Harness workspace={workspace} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);

    const signal = calls[0].options.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe('sameStatus', () => {
  // The poll allocates a fresh object every five seconds. Without this
  // comparison the hook hands React a new reference on every tick, so the whole
  // app reconciles twelve times a minute in an idle session for no visual
  // change. (Reference stability itself is not asserted here: state updates do
  // not flush through this file's Ink harness — see the poll test above, which
  // asserts call counts for the same reason.)
  it('treats an unchanged report as the same status', () => {
    expect(sameStatus({ branch: 'main', status: '~1' }, { branch: 'main', status: '~1' })).toBe(
      true,
    );
    expect(sameStatus({ branch: '?', status: '' }, { branch: '?', status: '' })).toBe(true);
  });

  it('separates a changed branch, a changed tree, and a changed error', () => {
    const base = { branch: 'main', status: '~1' };
    expect(sameStatus(base, { branch: 'feat/x', status: '~1' })).toBe(false);
    expect(sameStatus(base, { branch: 'main', status: '~2' })).toBe(false);
    expect(sameStatus(base, { ...base, error: 'git error' })).toBe(false);
  });

  it('separates a clean tree from a dirty one', () => {
    expect(sameStatus({ branch: 'main', status: '✓' }, { branch: 'main', status: '+1' })).toBe(
      false,
    );
  });
});

describe('useGitStatus outside the repository root', () => {
  it('polls git from a subdirectory of the working tree', async () => {
    // Probing only `<workspace>/.git` succeeds at the repository root alone, so
    // launching from any subdirectory reported no branch at all. The fixture is
    // a real nested directory: an earlier version of this case used a bare temp
    // directory with no `.git` anywhere, which passed for the wrong reason —
    // it pinned "always spawn" rather than "resolve from a subdirectory".
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'book-git-root-'));
    roots.push(root);
    mkdirSync(join(root, '.git'));
    const nested = join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });

    const view = render(<Harness workspace={nested} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(
      hardenedGitArgs([
        'config',
        '--show-scope',
        '-z',
        '--get-regexp',
        REPOSITORY_PROGRAM_CONFIG_PATTERN,
      ]),
    );
    view.unmount();
  });
});

/**
 * The poll spawns `git` in the workspace every five seconds, for as long as the session lasts,
 * and it is not a tool call: nothing asks before it runs. A checkout's own `.git/config` comes
 * with the clone, and `core.fsmonitor` there names a program `git status` executes — so the same
 * hardening the read-only Git tools carry belongs on this argv too (see `hardenedGitArgs`).
 */
describe('useGitStatus argv', () => {
  it('hardens the poll and gives it a pager and a credential prompt it cannot wait on', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'book-git-status-argv-'));
    roots.push(workspace);
    mkdirSync(join(workspace, '.git'));

    const view = render(<Harness workspace={workspace} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].options.timeout).toBe(5_000);
    expect(calls[0].options.windowsHide).toBe(true);

    for (const call of calls) {
      // Hardened argv, the poll's own command last: one of the two it makes.
      expect([
        hardenedGitArgs([
          'config',
          '--show-scope',
          '-z',
          '--get-regexp',
          REPOSITORY_PROGRAM_CONFIG_PATTERN,
        ]),
        hardenedGitArgs(['rev-parse', '--abbrev-ref', 'HEAD']),
        hardenedGitArgs(['status', '--short', '--ignore-submodules=dirty']),
      ]).toContainEqual(call.args);
      expect(call.options.env?.GIT_PAGER).toBe('cat');
      expect(call.options.env?.GIT_TERMINAL_PROMPT).toBe('0');
    }
    view.unmount();
  });

  it('reads pins once per poll cycle and passes them to both git calls', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'book-git-status-pins-'));
    roots.push(workspace);
    mkdirSync(join(workspace, '.git'));

    const view = render(<Harness workspace={workspace} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(
      hardenedGitArgs([
        'config',
        '--show-scope',
        '-z',
        '--get-regexp',
        REPOSITORY_PROGRAM_CONFIG_PATTERN,
      ]),
    );
    expect(calls[0].options.timeout).toBe(5_000);
    expect(calls[0].options.windowsHide).toBe(true);

    // Resolve the config read with a repository filter
    calls[0].callback(null, 'local\0filter.cleaner.clean\nclean-cmd\0');
    await vi.advanceTimersByTimeAsync(0);

    // Now rev-parse should have been called with the pins from that one read
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(
      hardenedGitArgs([
        '-c',
        'filter.cleaner.clean=',
        '-c',
        'filter.cleaner.smudge=',
        '-c',
        'filter.cleaner.process=',
        '-c',
        'filter.cleaner.required=false',
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ]),
    );

    // Resolve rev-parse
    calls[1].callback(null, 'main\n');
    await vi.advanceTimersByTimeAsync(0);

    // Now status --short should have been called with the same pins, and NO second config read
    expect(calls).toHaveLength(3);
    expect(calls[2].args).toEqual(
      hardenedGitArgs([
        '-c',
        'filter.cleaner.clean=',
        '-c',
        'filter.cleaner.smudge=',
        '-c',
        'filter.cleaner.process=',
        '-c',
        'filter.cleaner.required=false',
        'status',
        '--short',
        '--ignore-submodules=dirty',
      ]),
    );

    // Neither of the poll's own reads fetches.
    for (const call of [calls[1], calls[2]]) {
      expect(call.options.env?.GIT_NO_LAZY_FETCH).toBe('1');
      expect(call.options.env?.GIT_ALLOW_PROTOCOL).toBe('');
    }

    view.unmount();
  });

  it('keeps the branch when the status read fails', async () => {
    // Real timers: the state update has to render, and the next poll is five seconds away.
    const workspace = mkdtempSync(join(tmpdir(), 'book-git-status-fail-'));
    roots.push(workspace);
    mkdirSync(join(workspace, '.git'));
    const seen: Array<{ branch: string; status: string }> = [];
    function Shown() {
      const status = useGitStatus(workspace);
      seen.push(status);
      return null;
    }

    const view = render(<Shown />);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].callback(null, '');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].args.slice(-3)).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
    calls[1].callback(null, 'main\n');
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2].args).toContain('status');
    // A partial clone missing an object the status needs, read without fetching.
    calls[2].callback(new Error('fatal: unable to read tree'), '');

    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ branch: 'main', status: '' }));
    view.unmount();
  });

  it('reads the branch only in a partial clone, with no status read', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-git-status-partial-'));
    roots.push(workspace);
    mkdirSync(join(workspace, '.git'));
    const seen: Array<{ branch: string; status: string }> = [];
    function Shown() {
      const status = useGitStatus(workspace);
      seen.push(status);
      return null;
    }

    const view = render(<Shown />);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    calls[0].callback(null, 'local\0extensions.partialclone\norigin\0');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    calls[1].callback(null, 'main\n');

    await vi.waitFor(() => expect(seen.at(-1)).toMatchObject({ branch: 'main', status: '' }));
    expect(calls).toHaveLength(2);
    view.unmount();
  });
});

// Driven through an injected probe rather than the real filesystem. Whether a
// temp directory sits inside a working tree is ambient — a home directory kept
// under version control for dotfiles makes every path below it one, which is
// what `git rev-parse` would conclude too — so a test that asserted "no
// repository here" against `tmpdir()` passed or failed by machine.
describe('isInsideWorkTree', () => {
  // Anchored through `resolve` because the walk resolves before comparing: on
  // Windows a rooted path still picks up the current drive, so `\repo` becomes
  // `D:\repo` and a literal fixture would never match.
  const root = resolve(sep, 'repo');
  const tree = (...present: string[]) => {
    const set = new Set(present);
    return (path: string) => set.has(path);
  };

  it('finds the working tree from a subdirectory', () => {
    expect(isInsideWorkTree(join(root, 'src', 'deep'), tree(join(root, '.git')))).toBe(true);
  });

  it('accepts a worktree or submodule, where .git is a file', () => {
    expect(isInsideWorkTree(root, tree(join(root, '.git')))).toBe(true);
  });

  it('walks to the filesystem root and stops, rather than looping', () => {
    // Deciding this by spawning `git` meant three processes every five seconds
    // in any plain directory, forever; under CI that took the runner with it.
    expect(isInsideWorkTree(join(root, 'plain', 'dir'), tree())).toBe(false);
  });
});

// A `.git` at the home directory is a dotfiles repository, not the project, for a project below
// the home directory without one of its own (#579): the poll spawns nothing there, so the bar
// shows no branch rather than a git error. Its git carries the home directory as a ceiling
// (`hardenedGitEnv`), which a workspace that is the home directory itself sees through.
describe('useGitStatus and a dotfiles home directory', () => {
  let root: string;
  let home: string;

  beforeEach(() => {
    // The long form on Windows, as the ceiling carries it, not the runner's 8.3 temp path.
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-git-status-home-')));
    roots.push(root);
    home = join(root, 'home');
    mkdirSync(join(home, '.git'), { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('GIT_CEILING_DIRECTORIES', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('spawns nothing for a project below it without its own .git', async () => {
    vi.useFakeTimers();
    const proj = join(home, 'proj');
    mkdirSync(proj);

    const view = render(<Harness workspace={proj} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(0);
    view.unmount();
  });

  it('polls a workspace that is the home directory, with the home directory as ceiling', async () => {
    vi.useFakeTimers();

    const view = render(<Harness workspace={home} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].options.env?.GIT_CEILING_DIRECTORIES).toBe(home);
    calls[0].callback(null, '');
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(hardenedGitArgs(['rev-parse', '--abbrev-ref', 'HEAD']));
    expect(calls[1].options.env?.GIT_CEILING_DIRECTORIES).toBe(home);
    view.unmount();
  });

  it('adds no ceiling when the home directory holds no .git', async () => {
    vi.useFakeTimers();
    rmSync(join(home, '.git'), { recursive: true });
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });

    const view = render(<Harness workspace={repo} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].options.env?.GIT_CEILING_DIRECTORIES).toBeUndefined();
    view.unmount();
  });
});
