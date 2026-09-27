import { describe, expect, it } from 'vitest';
import type { execFile as ExecFile } from 'child_process';
import { WORKSPACE_READ_ONLY_GIT_TOOLS } from '../permissions.js';
import type { ToolContext } from '../types/tools.js';
import { gitTools, hardenedGitArgs, READ_ONLY_GIT_ARGS, runGit } from './git.js';

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

    const result = await runGit(['status', '--short'], ctx, execute);

    expect(result).toEqual({ success: true, output: ' M src/app.ts\n' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: 'git',
      // The caller's own arguments, with the hardening flags in front of them; see the next test
      // for what those are and why.
      args: hardenedGitArgs(['status', '--short']),
      options: {
        cwd: '/workspace',
        timeout: 30_000,
        env: expect.objectContaining({ TEST_ENV: 'yes' }),
      },
    });
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

  it('overrides the settings a repository owns that would run a program', () => {
    const config = configOf(hardenedGitArgs(['status', '--short']));
    // A command git executes to check whether the tree changed.
    expect(config.get('core.fsmonitor')).toBe('false');
    // A command git runs to page its output.
    expect(config.get('core.pager')).toBe('cat');
    // Where hooks live: nothing to find.
    expect(config.get('core.hooksPath')).toBe('');
  });

  it('takes no index lock for a call that only reads', () => {
    expect(hardenedGitArgs(['status'])).toContain('--no-optional-locks');
  });

  it('keeps a terminal prompt from hanging a headless run', async () => {
    const calls: ExecInvocation[] = [];
    const execute = fakeExecFile((invocation) => {
      calls.push(invocation);
      invocation.callback(null, '', '');
    });
    await runGit(['status'], { ...ctx, env: { GIT_TERMINAL_PROMPT: '1' } }, execute);
    expect(calls[0].options.env?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('closes the two routes a checkout owns for producing a diff', () => {
    // `diff.external` names a program to produce the diff; a `.gitattributes` `textconv` line
    // names one per file. Both are repository settings read by a tool whose job is to report.
    expect(READ_ONLY_GIT_ARGS.GitDiff).toContain('--no-ext-diff');
    expect(READ_ONLY_GIT_ARGS.GitDiff).toContain('--no-textconv');
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
});
