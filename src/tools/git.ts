import { execFile } from 'child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { toolFailure, toolSuccess } from './result.js';

type ExecFile = typeof execFile;

/**
 * `-c` overrides the four read-only Git tools carry, so a repository's own configuration cannot
 * turn a read-only report into something that runs a program.
 *
 * `.git/config` is a file the clone brings with it, and a checkout can set any of these:
 *
 * - `core.fsmonitor` — a command `git status` executes to check whether the tree changed. This
 *   is the sharpest one: a status call is supposed to be inert and it will happily run whatever
 *   the repository named.
 * - `log.showSignature` — `git log` then verifies every signature it prints, and verification
 *   runs `gpg.program`, another program the repository names. `GitDiff` and `GitStatus` do not
 *   reach it, but `GitLog` does on every commit that carries a `gpgsig` header.
 * - `core.pager` — a command Git runs to page its output. `execFile` never allocates a TTY, so
 *   git normally skips it, but the setting is read before that decision.
 * - `core.hooksPath` — where hooks live. None of the four read-only tools run a hook, so nothing
 *   here is reachable through them; it is set to an empty path so a future `git` subcommand that
 *   does has no hooks to find. It is here and *only* here: on `git commit` it would silently
 *   disable a hook the user installed.
 * - `core.untrackedCache`, `gc.auto` — background writers. `--no-optional-locks` below covers the
 *   index lock these need.
 *
 * `--no-optional-locks` is a top-level flag, not a config key, so it is added separately: it stops
 * Git taking `.git/index.lock` for a call that only reads, which a read-only worktree and a
 * concurrent `book` session would otherwise fight over.
 *
 * Each of these was checked against a real `git`, not read off this list — see
 * `git.test.ts`. Anything that is not reached through a non-TTY `execFile` (`column.ui`,
 * `pager.log`, `diff.external` without `--no-ext-diff`) is not here either, because the flags that
 * close those are per-command and belong in {@link READ_ONLY_GIT_ARGS}.
 */
const GIT_HARDENING_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '-c',
  'core.hooksPath=',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'gc.auto=0',
  '-c',
  'log.showSignature=false',
  '--no-optional-locks',
];

/** The hardening flags in front of the read-only tools' own arguments; see {@link GIT_HARDENING_ARGS}. */
export function hardenedGitArgs(args: readonly string[]): string[] {
  return [...GIT_HARDENING_ARGS, ...args];
}

/**
 * `runGit` runs a caller's arguments as given, and the caller chooses.
 *
 * The hardening is a property of the *read-only* tools, not of every git call this module makes:
 * applied to `git commit` it would disable the user's own pre-commit and commit-msg hooks, and
 * silently not running a user's hook is a worse failure than the one the hardening exists to
 * prevent. So the four read-only tools go through {@link readOnlyGit}, and `GitCommit` — the only
 * mutating tool here, and the only one that still asks — comes through here with its own argv and
 * the environment the user configured, exactly as it did before the hardening existed.
 */
export async function runGit(
  args: string[],
  ctx: ToolContext,
  execute: ExecFile = execFile,
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const options = {
      cwd: ctx.workspaceRoot,
      encoding: 'utf-8' as const,
      timeout: 30_000,
      signal: ctx.signal,
      env: { ...process.env, ...ctx.env },
    };

    execute('git', args, options, (error, stdout, stderr) => {
      if (!error) {
        resolve({ success: true, output: stdout || '(no output)' });
        return;
      }

      if (ctx.signal?.aborted) {
        resolve({ success: false, output: '', error: 'CANCELLED: Git command was cancelled' });
        return;
      }

      resolve({
        success: false,
        output: '',
        error: stderr || error.message || 'Git command failed',
      });
    });
  });
}

/** A read-only report: hardened, and with a pager and a credential prompt it cannot wait on. */
function readOnlyGit(args: readonly string[], ctx: ToolContext) {
  return runGit(hardenedGitArgs(args), {
    ...ctx,
    env: { ...ctx.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  });
}

function gitResult(result: Awaited<ReturnType<typeof runGit>>): ToolResult {
  return result.success
    ? toolSuccess(result.output)
    : toolFailure(result.error ?? 'Git command failed', { content: result.output });
}

async function gitStatus(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const result = await readOnlyGit(READ_ONLY_GIT_ARGS.GitStatus, ctx);
  return gitResult(result);
}

async function gitDiff(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const result = await readOnlyGit(READ_ONLY_GIT_ARGS.GitDiff, ctx);
  return gitResult(result);
}

async function gitLog(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const result = await readOnlyGit(READ_ONLY_GIT_ARGS.GitLog, ctx);
  return gitResult(result);
}

async function gitCommit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const message = args.message as string;
  const result = await runGit(['commit', '-m', message], ctx);
  return gitResult(result);
}

async function gitBranch(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const result = await readOnlyGit(READ_ONLY_GIT_ARGS.GitBranch, ctx);
  return gitResult(result);
}

/**
 * The arguments the four read-only tools run.
 *
 * These are the tools `permissions.ts` lets through without a prompt, so their whole security
 * argument rests on two things: they read the workspace and change nothing, and the repository's
 * own configuration cannot make them execute a program (see {@link GIT_HARDENING_ARGS}). Exported
 * so that argument can be asserted per tool rather than taken on trust.
 *
 * `GitDiff` carries `--no-ext-diff` and `--no-textconv`, which close the two remaining routes a
 * checkout owns: `diff.external` names a program to produce the diff, and a `.gitattributes`
 * `textconv` line names one per file. `GitLog` carries `--no-show-signature` for the same reason
 * `log.showSignature=false` is in the hardening: verifying a signature runs `gpg.program`. The flag
 * is on the command as well as in the config so the guarantee does not rest on the `-c` override
 * being consulted for this subcommand. `GitCommit` is deliberately not here — it is a mutation,
 * still asks, and runs with the user's own hooks (see {@link runGit}).
 */
export const READ_ONLY_GIT_ARGS = {
  GitStatus: ['status', '--short'],
  GitDiff: ['diff', '--no-ext-diff', '--no-textconv'],
  GitLog: ['log', '--oneline', '-20', '--no-show-signature'],
  GitBranch: ['branch', '-a'],
} as const satisfies Readonly<Record<string, string[]>>;

export const gitTools: ToolDefinition[] = [
  {
    name: 'GitStatus',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    description: 'Show the working tree status (git status --short)',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitStatus,
  },
  {
    name: 'GitDiff',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    description: 'Show changes between commits, commit and working tree, etc.',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitDiff,
  },
  {
    name: 'GitLog',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    description: 'Show recent commit logs (last 20, oneline)',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitLog,
  },
  {
    name: 'GitCommit',
    description: 'Create a new commit with a message',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Commit message' } },
      required: ['message'],
    },
    execute: gitCommit,
  },
  {
    name: 'GitBranch',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    description: 'List branches',
    parameters: { type: 'object', properties: {}, required: [] },
    execute: gitBranch,
  },
];
