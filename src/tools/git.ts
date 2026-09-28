import { execFile } from 'child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { buildChildEnv } from '../child-env.js';
import { toolFailure, toolSuccess } from './result.js';

type ExecFile = typeof execFile;

/**
 * `-c` overrides the Git tools and the managed-agent subsystem carry, so a checkout's own
 * configuration cannot turn a git call into something that runs a program.
 *
 * The configuration belongs to the checkout, and a checkout may have come from an archive, a
 * shared directory, or someone else's machine, so any of these can be set without the operator
 * having made that choice themselves:
 *
 * - `core.fsmonitor` — a command `git status` executes to check whether the tree changed. This
 *   is the sharpest one: a status call is supposed to be inert and it will happily run whatever
 *   the repository named.
 * - `log.showSignature` — `git log` then verifies every signature it prints, and verification
 *   runs `gpg.program`, another program the repository names. `GitDiff` and `GitStatus` do not
 *   reach it, but `GitLog` does on every commit that carries a `gpgsig` header.
 * - `core.pager` — a command Git runs to page its output. `execFile` never allocates a TTY, so
 *   git normally skips it, but the setting is read before that decision.
 * - `core.hooksPath` — where hooks live, and where most of the effect of this list lands: a
 *   `post-checkout` on `worktree add`, a `pre-commit` on an agent's commit, a
 *   `reference-transaction` on every ref Book moves, a `prepare-commit-msg` on the
 *   `cherry-pick` that applies a candidate. The four read-only tools here run no hook at all, so
 *   for them this is belt and braces against a future subcommand; for
 *   `src/agents/git-isolation.ts`, whose calls are writes nothing asks about (#348), switching
 *   them off is the decision. It is **not** applied to `GitCommit` or to `runGit` generally: on
 *   the operator's own commit it would silently disable a hook they installed, and their code
 *   silently not running is a worse failure than the one this list prevents.
 * - `core.untrackedCache`, `gc.auto`, `maintenance.auto` — background writers. `gc.auto=0` is not
 *   the whole of it: `maintenance.auto` is separately on by default, so every commit spawns
 *   `git maintenance run --auto`, which repacks and can run whatever strategies the configuration
 *   registers while Book is moving refs. `--no-optional-locks` below covers the index lock these
 *   need.
 *
 * `--no-optional-locks` is a top-level flag, not a config key, so it is added separately: it stops
 * Git taking `.git/index.lock` for a call that only reads, which a read-only worktree and a
 * concurrent `book` session would otherwise fight over.
 *
 * Each of these was checked against a real `git`, not read off this list — see
 * `git.test.ts`. Anything not reached through a non-TTY `execFile` (`column.ui`, `pager.log`,
 * `diff.external`) is not here either, because the flags that close those are per-command and
 * belong in {@link HARDENED_DIFF_ARGS}, which every hardened caller that runs `git diff` uses.
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
  'maintenance.auto=false',
  '-c',
  'log.showSignature=false',
  '--no-optional-locks',
];

/**
 * The per-command flags that close the two remaining routes a checkout owns for producing a diff,
 * for every hardened caller that runs `git diff`: `diff.external` names a program to produce it,
 * and a `.gitattributes` `textconv` line names one per file. They are command flags rather than
 * configuration, which is why they are not in {@link GIT_HARDENING_ARGS}, and they are on the
 * command as well as in the config so the guarantee does not rest on the `-c` overrides being
 * consulted for the subcommand.
 */
export const HARDENED_DIFF_ARGS = ['--no-ext-diff', '--no-textconv'] as const;

/**
 * The environment every hardened call carries: a pager, so a checkout cannot name a program git
 * pages its output with, and a credential prompt it cannot sit waiting on. Callers that have an
 * environment of their own to merge (a tool's `ToolContext.env`, a temporary `GIT_INDEX_FILE`,
 * git isolation's commit identity) spread this into it; the pager and the prompt are the floor,
 * not a replacement.
 *
 * The return type is `Record<string, string>` rather than `NodeJS.ProcessEnv`: a caller's
 * environment is `Record<string, string>` too, and spreading a wider one into it would make the
 * whole object `string | undefined` where nothing may be undefined.
 */
export function hardenedGitEnv(): Record<string, string> {
  return { GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
}

/**
 * The hardening flags in front of a caller's own arguments; see {@link GIT_HARDENING_ARGS}.
 *
 * Four callers, and they read this differently. The read-only Git tools ({@link readOnlyGit}) take
 * it because nothing asks before they run, so a checkout must not be able to start a program
 * through one. `/review`'s target (`src/review/target.ts`) and the TUI status poll
 * (`src/tui/hooks/useGitStatus.ts`) are the same: reports and background polls that fire with no
 * prompt. Git isolation (`src/agents/git-isolation.ts`) is the one that takes it on writes as
 * well — the agent's commit, the cherry-pick, `worktree add`, `update-ref` — where hooks being
 * off is a decision (#348) rather than a consequence: that work is Book's, in Book's worktree,
 * and a hook the operator installed is theirs to decide when it runs. The operator's own commits
 * keep their hooks, through {@link runGit} below.
 */
export function hardenedGitArgs(args: readonly string[]): string[] {
  return [...GIT_HARDENING_ARGS, ...args];
}

/**
 * `runGit` runs a caller's arguments as given, and the caller chooses.
 *
 * The hardening is a property of the calls that are *not* the operator's own work, not of every
 * git call this module makes. `GitCommit` is the operator's own work, and it is the only
 * mutating tool here: it comes through this function with its own argv and the environment the
 * user configured, exactly as it did before the hardening existed, so a `pre-commit` or
 * `commit-msg` hook still runs. Silently not running the user's hook would be a worse failure
 * than the one the hardening exists to prevent. The read-only tools go through
 * {@link readOnlyGit}, and a caller whose work is Book's own builds its argv with
 * {@link hardenedGitArgs} directly.
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
      // A hook git runs is a project command like any other, so it must not inherit a NODE_ENV
      // Book defaulted for its own renderer.
      env: buildChildEnv(process.env, ctx.env),
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

/** A read-only report: hardened, and with the pager and credential prompt it cannot wait on. */
function readOnlyGit(args: readonly string[], ctx: ToolContext) {
  return runGit(hardenedGitArgs(args), {
    ...ctx,
    env: { ...ctx.env, ...hardenedGitEnv() },
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
 * `GitDiff` carries {@link HARDENED_DIFF_ARGS}, which close the two remaining routes a checkout
 * owns: `diff.external` names a program to produce the diff, and a `.gitattributes` `textconv`
 * line names one per file. `GitLog` carries `--no-show-signature` for the same reason
 * `log.showSignature=false` is in the hardening: verifying a signature runs `gpg.program`. The flag
 * is on the command as well as in the config so the guarantee does not rest on the `-c` override
 * being consulted for this subcommand. `GitCommit` is deliberately not here — it is a mutation,
 * still asks, and runs with the user's own hooks (see {@link runGit}).
 */
export const READ_ONLY_GIT_ARGS = {
  GitStatus: ['status', '--short'],
  GitDiff: ['diff', ...HARDENED_DIFF_ARGS],
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
