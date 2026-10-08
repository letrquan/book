import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, type execFile as ExecFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WORKSPACE_READ_ONLY_GIT_TOOLS } from '../permissions.js';
import type { ToolContext } from '../types/tools.js';
import {
  gitTools,
  hardenedGitArgs,
  hardenedGitEnv,
  HARDENED_DIFF_ARGS,
  READ_ONLY_GIT_ARGS,
  runGit,
} from './git.js';

const ctx: ToolContext = { workspaceRoot: '/workspace', env: { TEST_ENV: 'yes' } };
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

type ExecInvocation = {
  file: string;
  args: readonly string[];
  options: { cwd?: string; timeout?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv };
  callback: ExecCallback;
};

function fakeExecFile(implementation: (invocation: ExecInvocation) => void): typeof ExecFile {
  return ((
    file: string,
    args: readonly string[],
    options: ExecInvocation['options'],
    callback: ExecCallback,
  ) => {
    implementation({ file, args, options, callback });
    return {};
  }) as typeof ExecFile;
}

describe('runGit', () => {
  it('passes fixed argument arrays without a shell string', async () => {
    const calls: ExecInvocation[] = [];
    const execute = fakeExecFile((invocation) => {
      calls.push(invocation);
      invocation.callback(null, ' M src/app.ts\n', '');
    });

    // `runGit` is the unhardened path, so a caller can pass whatever it means; the read-only
    // tools go through `readOnlyGit` instead (see the "hardening against a real git" block).
    const result = await runGit(['status', '--short'], ctx, execute);

    expect(result).toEqual({ success: true, output: ' M src/app.ts\n' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: 'git',
      args: ['status', '--short'],
      options: {
        cwd: '/workspace',
        timeout: 30_000,
        env: expect.objectContaining({ TEST_ENV: 'yes' }),
      },
    });
  });

  it('puts the hardening in front of the read-only tools own arguments', () => {
    // `readOnlyGit` is module-private, so what is asserted is what it builds with: the flags,
    // then the tool's own arguments, in that order. The real-git block below checks the effect.
    expect(hardenedGitArgs(READ_ONLY_GIT_ARGS.GitStatus)).toEqual([
      ...hardenedGitArgs([]),
      'status',
      '--short',
    ]);
    for (const args of Object.values(READ_ONLY_GIT_ARGS)) {
      expect(hardenedGitArgs(args)).toEqual([...hardenedGitArgs([]), ...args]);
    }
  });

  it('maps no output and stderr failures consistently', async () => {
    const callbacks = [
      (callback: ExecCallback) => callback(null, '', ''),
      (callback: ExecCallback) => callback(new Error('exit 1'), '', 'fatal: bad repository'),
    ];
    const execute = fakeExecFile(({ callback }) => callbacks.shift()!(callback));

    await expect(runGit(['status'], ctx, execute)).resolves.toEqual({
      success: true,
      output: '(no output)',
    });
    await expect(runGit(['status'], ctx, execute)).resolves.toEqual({
      success: false,
      output: '',
      error: 'fatal: bad repository',
    });
  });

  it('keeps the event loop responsive while git is running', async () => {
    const execute = fakeExecFile(({ callback }) => {
      setTimeout(() => callback(null, 'done', ''), 20);
    });

    let timerFired = false;
    const pending = runGit(['status'], ctx, execute);
    setTimeout(() => {
      timerFired = true;
    }, 0);

    await expect(pending).resolves.toMatchObject({ success: true });
    expect(timerFired).toBe(true);
  });

  it('reports cancellation from the active attempt signal', async () => {
    const controller = new AbortController();
    const execute = fakeExecFile(({ options, callback }) => {
      options.signal?.addEventListener('abort', () => callback(new Error('AbortError'), '', ''), {
        once: true,
      });
    });

    const pending = runGit(['status'], { ...ctx, signal: controller.signal }, execute);
    controller.abort();

    await expect(pending).resolves.toEqual({
      success: false,
      output: '',
      error: 'CANCELLED: Git command was cancelled',
    });
  });

  it('does not invoke a shell process', async () => {
    const calls: ExecInvocation[] = [];
    const execute = fakeExecFile((invocation) => {
      calls.push(invocation);
      invocation.callback(null, 'ok', '');
    });
    await runGit(['commit', '-m', 'message with spaces'], ctx, execute);

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('git');
    // The caller's arguments are passed as separate argv entries, so a message with spaces or a
    // `; rm -rf` in it is data and never a command.
    expect(calls[0].args.slice(-3)).toEqual(['commit', '-m', 'message with spaces']);
  });
});

/**
 * #305 item 6: a clone brings `.git/config` with it, and a checked-in repository can set any of
 * these. `core.fsmonitor` is the one that bites: `git status` executes it. The four read-only
 * tools run without a prompt (see `permissions.ts`), so their arguments are the only thing
 * standing between a repository and a program it started the moment the operator opened Book.
 */
describe('git hardening', () => {
  /** The `-c key=value` pairs `runGit` puts in front of every call. */
  function configOf(args: readonly string[]): Map<string, string> {
    const entries = new Map<string, string>();
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] !== '-c') continue;
      const [key, value] = args[index + 1].split('=');
      entries.set(key, value);
    }
    return entries;
  }

  it('overrides the settings a checkout owns that would run a program', () => {
    const config = configOf(hardenedGitArgs(['status', '--short']));
    // A command git executes to check whether the tree changed.
    expect(config.get('core.fsmonitor')).toBe('false');
    // A command git runs to page its output.
    expect(config.get('core.pager')).toBe('cat');
    // Where hooks live: nothing to find.
    expect(config.get('core.hooksPath')).toBe('');
  });

  it('stops the background writers, not only the ones gc.auto covers', () => {
    // `gc.auto=0` is not the whole of it. `maintenance.auto` is separately on by default, so
    // every commit spawns `git maintenance run --auto`, which repacks and can run whatever
    // strategies the configuration registers — a prefetch, a credential or ssh program — while
    // Book is mid-flow and moving refs. Checked here as a key, because that is what a
    // `-c key=value` pair in the argv is: asserting the exact argv length would make this test
    // fail every time an unrelated flag is added.
    const config = configOf(hardenedGitArgs(['status', '--short']));
    expect(config.get('maintenance.auto')).toBe('false');
    expect(config.get('gc.auto')).toBe('0');
  });

  it('takes no index lock for a call that only reads', () => {
    expect(hardenedGitArgs(['status'])).toContain('--no-optional-locks');
  });

  it('closes the two routes a checkout owns for producing a diff', () => {
    // `diff.external` names a program to produce the diff; a `.gitattributes` `textconv` line
    // names one per file. Both are checkout settings read by a tool whose job is to report. The
    // flags are shared rather than restated per caller, so this asserts the one list every
    // hardened caller that runs `git diff` reaches for.
    expect([...HARDENED_DIFF_ARGS]).toEqual(['--no-ext-diff', '--no-textconv']);
    expect(READ_ONLY_GIT_ARGS.GitDiff).toContain('--no-ext-diff');
    expect(READ_ONLY_GIT_ARGS.GitDiff).toContain('--no-textconv');
  });

  it('gives every hardened call a pager and a credential prompt it cannot wait on', () => {
    // One list, spread by the four callers that have an environment of their own to merge into
    // it: a tool's `ToolContext.env`, git isolation's commit identity, `/review`'s call, the TUI
    // poll. Asserted as a fresh object per call, since a shared mutable one would let one
    // caller's configuration reach another's.
    const env = hardenedGitEnv();
    expect(env).toEqual({ GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' });
    expect(hardenedGitEnv()).not.toBe(env);
  });

  it('covers exactly the tools that run without a prompt', () => {
    // `WORKSPACE_READ_ONLY_GIT_TOOLS` in permissions.ts is what a prompt is skipped for, and
    // this map is the argument review that skipping rests on. The two must not drift: a tool in
    // the first and not the second would be auto-allowed without anyone having read what it
    // runs. GitCommit is a mutation and is in neither.
    expect(Object.keys(READ_ONLY_GIT_ARGS).sort()).toEqual(
      [...WORKSPACE_READ_ONLY_GIT_TOOLS].sort(),
    );
    expect(gitTools.map((tool) => tool.name).sort()).toContain('GitCommit');
  });

  /**
   * #324: the same hole reached from the other end. Grep used to read a path that starts with
   * `-` as a ripgrep option, so a repository could name a program and have it run. A read-only
   * Git tool has the same shape — fixed argv, model arguments added in front of it, no prompt —
   * and the only thing that has kept it shut is that these tools take no arguments at all. A
   * parameter is therefore a review, not a detail, and this fails when one appears.
   */
  it('declares no parameters on the tools that run without a prompt', () => {
    for (const tool of gitTools.filter((candidate) => candidate.name !== 'GitCommit')) {
      expect(tool.parameters).toEqual({ type: 'object', properties: {}, required: [] });
    }
  });
});

/**
 * Findings on PR #334, checked against a real `git` rather than a fake exec.
 *
 * The argument assertions above can only show that a flag is *present*. Whether a flag is the
 * right one is a question about a real Git, and Git's config surface is large enough that
 * reading the list is not evidence: a reviewer reproduced `gpg.program` running under
 * `log.showSignature` with no flag in the list covering it. So these build a repository whose
 * `.git/config` points at a program that records having run, and ask Git itself.
 */
describe('hardening against a real git', () => {
  let root: string;
  let repo: string;
  /** The program a malicious config points at; it creates this when it runs. */
  let marker: string;
  let program: string;

  const git = (args: string[], cwd = repo): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });

  const toolFor = (name: string) => gitTools.find((tool) => tool.name === name)!;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'book-git-hardening-'));
    repo = join(root, 'repo');
    marker = join(root, 'PROGRAM_RAN');
    program = join(root, 'evil.sh');
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
    chmodSync(program, 0o755);
    mkdirSync(repo);
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.email', 't@example.com'], repo);
    git(['config', 'user.name', 'Test'], repo);
    writeFileSync(join(repo, 'a.txt'), 'hello\n');
    git(['add', 'a.txt'], repo);
    git(['commit', '-qm', 'init'], repo);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A commit carrying a `gpgsig` header, so `git log` has a signature to try to verify. */
  function addSignedCommit(): void {
    const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
    const parent = git(['rev-parse', 'HEAD']).trim();
    const object = [
      `tree ${tree}`,
      `parent ${parent}`,
      'author T <t@example.com> 1700000000 +0000',
      'committer T <t@example.com> 1700000000 +0000',
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' ',
      ' iQEzBAABCgAdFiEEDummySignature',
      ' -----END PGP SIGNATURE-----',
      '',
      'signed commit',
      '',
    ].join('\n');
    writeFileSync(join(root, 'commit-object'), object);
    const commit = execFileSync(
      'git',
      ['hash-object', '-w', '-t', 'commit', join(root, 'commit-object')],
      {
        cwd: repo,
        encoding: 'utf8',
      },
    ).trim();
    git(['update-ref', 'refs/heads/signed', commit], repo);
  }

  it('does not run gpg.program when the repository configures signature checking', async () => {
    // The reported hole: `log.showSignature` makes `git log` verify every signature it prints,
    // and verification runs `gpg.program` — a program the repository's own `.git/config` names.
    // `GitLog` is auto-allowed (see `permissions.ts`), so this runs with no prompt at all.
    addSignedCommit();
    git(['config', 'log.showSignature', 'true'], repo);
    git(['config', 'gpg.program', program], repo);

    // The config is genuinely capable of starting the program, or the rest of this test is
    // asserting nothing: a bare `git log` over the same repo does start it. This is the
    // reviewer's reproduction, and it is re-checked per test because these set repository config
    // that a later test in the same repo would otherwise be able to lean on.
    execFileSync('git', ['log', '--oneline', '-1', 'signed'], { cwd: repo, encoding: 'utf8' });
    expect(existsSync(marker)).toBe(true);
    expect(git(['config', '--get', 'log.showSignature']).trim()).toBe('true');

    rmSync(marker);
    await toolFor('GitLog').execute({}, { workspaceRoot: repo, env: {} });

    expect(existsSync(marker)).toBe(false);
  });

  it('names log.showSignature and gpg.program in the hardening', () => {
    // Asserted directly as well as end to end: the end-to-end test passes for any reason that
    // stops the program, and this says which switch is load-bearing.
    const config = new Map<string, string>();
    for (let index = 0; index < hardenedGitArgs([]).length - 1; index += 1) {
      if (hardenedGitArgs([])[index] === '-c') {
        const [key, value] = hardenedGitArgs([])[index + 1].split('=');
        config.set(key, value);
      }
    }
    expect(config.get('log.showSignature')).toBe('false');
    // A `--no-show-signature` on the command itself, so the guarantee does not rest on the
    // `-c` override being consulted for this subcommand.
    expect(READ_ONLY_GIT_ARGS.GitLog).toContain('--no-show-signature');
  });

  it('leaves the operator commit hooks running', async () => {
    // The other side of the same file: `-c core.hooksPath=` belongs to the *read-only* hardening
    // only. Applied to `git commit` it silently disables a pre-commit hook the user installed,
    // which is their code silently not running — a worse failure than the one the hardening
    // prevents, and one they would have no way to see.
    const hooks = join(repo, 'my-hooks');
    mkdirSync(hooks);
    const hook = join(hooks, 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(hook, 0o755);
    git(['config', 'core.hooksPath', hooks], repo);

    await toolFor('GitCommit').execute({ message: 'with hook' }, { workspaceRoot: repo, env: {} });

    expect(existsSync(marker)).toBe(true);
  });

  it('runs the mutating tool with exactly the arguments main runs it with', async () => {
    // "Exactly as on main" is a stronger claim than "the hook still runs", and it is the one
    // worth holding to: GitCommit's argv and environment are the user's business, not a security
    // surface, and anything Book adds to them is Book changing a git command the user asked for.
    const calls: ExecInvocation[] = [];
    const execute = fakeExecFile((invocation) => {
      calls.push(invocation);
      invocation.callback(null, '', '');
    });

    await runGit(['commit', '-m', 'a message'], { workspaceRoot: '/w', env: {} }, execute);

    expect(calls[0].args).toEqual(['commit', '-m', 'a message']);
    // No `-c`, no `--no-optional-locks`, and none of the hardening's environment.
    expect(calls[0].args).not.toContain('-c');
    expect(calls[0].options.env?.GIT_PAGER).toBeUndefined();
    expect(calls[0].options.env?.GIT_TERMINAL_PROMPT).toBeUndefined();
  });

  it('still holds the read-only tools against the keys that do fire', async () => {
    // The rest of the surface, checked the same way rather than by reading the list. `fsmonitor`
    // and the diff drivers are the ones Git actually executes on these subcommands; the pager and
    // the column config are not reached through a non-TTY `execFile`, so the pager and hooksPath
    // entries in `GIT_HARDENING_ARGS` are belt-and-braces rather than load-bearing, and this
    // test says so by not claiming them.
    git(['config', 'core.fsmonitor', program], repo);
    await toolFor('GitStatus').execute({}, { workspaceRoot: repo, env: {} });
    expect(existsSync(marker)).toBe(false);

    rmSync(marker, { force: true });
    git(['config', 'core.fsmonitor', ''], repo);
    git(['config', 'diff.external', program], repo);
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    await toolFor('GitDiff').execute({}, { workspaceRoot: repo, env: {} });
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps a credential prompt from hanging a headless read-only call', async () => {
    // `readOnlyGit` is module-private, so this is observed through the tool. `GIT_TERMINAL_PROMPT=0`
    // belongs to the read-only path alone: a `git commit` that legitimately needs a credential
    // must still be able to ask for one, so the override cannot live in `runGit`.
    const credentials = join(root, 'credential.sh');
    writeFileSync(credentials, `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(credentials, 0o755);
    // Forward slashes, because a backslash in a config *value* is an escape character: a raw
    // `C:\Users\...` is `fatal: bad config line 2`, and every git command in this repository
    // fails before the tool under test is reached. `git config key value` would escape it for
    // us, which is why the sibling tests here are safe; this one writes the file as text.
    writeFileSync(
      join(repo, '.git', 'config'),
      [
        '[credential]',
        `\thelper = ${credentials.replaceAll('\\', '/')}`,
        '[remote "origin"]',
        '\turl = https://example.invalid/repo.git',
        '',
      ].join('\n'),
    );

    const result = await toolFor('GitStatus').execute({}, { workspaceRoot: repo, env: {} });

    // A read-only status touches no remote, so the helper is never the answer here; what this
    // pins is that the call returns at all rather than waiting on a stdin nobody will write to.
    expect(result.status).toBe('success');
  });

  it('leaves no marker for GitStatus and GitDiff with a repository clean filter', async () => {
    const filterMarker = join(root, 'CLEAN_FILTER_RAN');
    const filterProgram = `sh -c "touch '${filterMarker.replace(/\\/g, '/')}'"`;
    git(['config', 'filter.x.clean', filterProgram], repo);
    git(['config', 'filter.x.required', 'true'], repo);
    writeFileSync(join(repo, '.gitattributes'), '* filter=x\n');
    git(['add', '.gitattributes'], repo);
    git(['commit', '-qm', 'attributes'], repo);

    // Make file stat-dirty
    writeFileSync(join(repo, 'a.txt'), 'changed for filter test\n');
    rmSync(filterMarker, { force: true });

    await toolFor('GitStatus').execute({}, { workspaceRoot: repo, env: {} });
    expect(existsSync(filterMarker)).toBe(false);

    await toolFor('GitDiff').execute({}, { workspaceRoot: repo, env: {} });
    expect(existsSync(filterMarker)).toBe(false);
  });

  it('keeps GitStatus working when core.fsmonitor is true', async () => {
    git(['config', 'core.fsmonitor', 'true'], repo);
    const result = await toolFor('GitStatus').execute({}, { workspaceRoot: repo, env: {} });
    expect(result.status).toBe('success');
  });
});
