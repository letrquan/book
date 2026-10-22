import { execFile } from 'child_process';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { buildChildEnv } from '../child-env.js';
import { toolFailure, toolSuccess } from './result.js';
import {
  GIT_HARDENING_ARGS,
  hardenedGitArgs,
  hardenedGitEnv,
  readRepositoryGitConfig,
} from './git-repository-programs.js';

type ExecFile = typeof execFile;

/** Base -c overrides; see {@link GIT_HARDENING_ARGS} in `git-repository-programs.ts`. */
export { GIT_HARDENING_ARGS };

/**
 * The per-command flags that close the two remaining routes a checkout owns for producing a diff,
 * for every hardened caller that runs `git diff`: `diff.external` names a program to produce it,
 * and a `.gitattributes` `textconv` line names one per file. They are command flags rather than
 * configuration, which is why they are not in {@link GIT_HARDENING_ARGS}, and they are on the
 * command as well as in the config so the guarantee does not rest on the `-c` overrides being
 * consulted for the subcommand.
 *
 * `--ignore-submodules=dirty` keeps the diff to this repository: a submodule whose recorded
 * commit moved still shows, what changed inside one does not. It is a flag rather than
 * `diff.ignoreSubmodules`, because a repository's own `.gitmodules` outranks that setting.
 */
export const HARDENED_DIFF_ARGS = [
  '--no-ext-diff',
  '--no-textconv',
  '--ignore-submodules=dirty',
] as const;

/** Environment floor for hardened calls; see {@link hardenedGitEnv} in `git-repository-programs.ts`. */
export { hardenedGitEnv };

/** Hardening flags in front of arguments; see {@link hardenedGitArgs} in `git-repository-programs.ts`. */
export { hardenedGitArgs };

/**
 * The environment for a git read that stays local. In a partial clone a missing object is
 * reported as missing rather than fetched (`GIT_NO_LAZY_FETCH`, which git 2.44 or later reads, and
 * older releases patched in 2024; an older git ignores it), and git's transport allowlist is empty
 * (`GIT_ALLOW_PROTOCOL`).
 *
 * Every hardened read carries it: the read-only Git tools, `/diff`, `/review`'s target, the
 * prompt's per-turn git line, the TUI status poll and git isolation. A `git` the user runs through
 * `Bash` is theirs and does not. The prompt line and the poll go further and skip the status read
 * in a partial clone altogether (see `ReadOnlyGitReader.partialClone`), so on a git that ignores
 * `GIT_NO_LAZY_FETCH` they still read nothing a remote would have to supply.
 */
export function noFetchGitEnv(): Record<string, string> {
  return { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' };
}

/**
 * The note put in front of a failed read whose output shows git needed an object a partial clone
 * does not have, so the reader learns why and what to do rather than only git's own line.
 */
export const MISSING_OBJECTS_NOTE =
  "This repository is a partial clone, and git needs an object that is not here. Book's git reads do not fetch missing objects: run the same git command yourself, which fetches what it needs, or `git fetch --refetch <remote>` after unsetting `remote.<remote>.partialclonefilter`, then retry.";

/** `message`, with {@link MISSING_OBJECTS_NOTE} in front when it shows a missing object. */
export function describeMissingObjects(message: string): string {
  return /lazy fetching disabled|promisor remote|transport '[^']*' not allowed/i.test(message)
    ? `${MISSING_OBJECTS_NOTE}\n${message}`
    : message;
}

/**
 * `runGit` runs a caller's arguments as given, and the caller chooses.
 *
 * The hardening is a property of the calls that are *not* the operator's own work, not of every
 * git call this module makes. `GitCommit` is the operator's own work, and it is the only
 * mutating tool here: it comes through this function with its own argv and the environment the
 * user configured, exactly as it did before the hardening existed, so a `pre-commit` or
 * `commit-msg` hook still runs. Silently not running the user's hook would be a worse failure
 * than the one the hardening exists to prevent. The read-only tools and the prompt's per-turn git
 * line go through {@link readOnlyGit}, and a caller whose work is Book's own builds its argv with
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

/** One repository's read-only git, with its configuration read once for every call. */
export interface ReadOnlyGitReader {
  /** Whether the repository is a partial clone (`extensions.partialClone`, a `remote.*.promisor`). */
  partialClone: boolean;
  /** One hardened read, as {@link readOnlyGit} runs it. */
  run(args: readonly string[]): Promise<Awaited<ReturnType<typeof runGit>>>;
}

/**
 * Read the workspace's git configuration once and return a reader for several read-only calls in
 * it, each hardened as {@link readOnlyGit} is. Rejects when the configuration cannot be read or
 * names a program the pins cannot neutralize.
 */
export async function openReadOnlyGit(ctx: ToolContext): Promise<ReadOnlyGitReader> {
  const env = { ...ctx.env, ...hardenedGitEnv(), ...noFetchGitEnv() };
  const config = await readRepositoryGitConfig(ctx.workspaceRoot, undefined, {
    signal: ctx.signal,
    env,
  });
  return {
    partialClone: config.partialClone,
    run: async (args) => {
      const result = await runGit(hardenedGitArgs([...config.pins, ...args]), { ...ctx, env });
      return result.success || !result.error
        ? result
        : { ...result, error: describeMissingObjects(result.error) };
    },
  };
}

/**
 * A read-only report: hardened, with the pager and credential prompt it cannot wait on, and no
 * fetch (see {@link noFetchGitEnv}).
 *
 * Exported for the prompt's `<session-state>` git line (`gitContext` in `agent/context.ts`), which
 * runs on every turn before any tool call or approval, and so must not start a program the
 * checkout's `.git/config` names any more than `GitStatus` may (#574).
 *
 * The TUI's `/diff` uses it too, to show what `GitDiff` would.
 */
export async function readOnlyGit(args: readonly string[], ctx: ToolContext) {
  try {
    return await (await openReadOnlyGit(ctx)).run(args);
  } catch (error) {
    return {
      success: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
 * line names one per file. `GitStatus` carries `--ignore-submodules=dirty`: a submodule whose
 * recorded commit moved still shows, but what changed inside one does not count, so the status
 * stays a report on this repository alone. `GitLog` carries `--no-show-signature` for the same
 * reason `log.showSignature=false` is in the hardening: verifying a signature runs `gpg.program`. The flag
 * is on the command as well as in the config so the guarantee does not rest on the `-c` override
 * being consulted for this subcommand. `GitCommit` is deliberately not here — it is a mutation,
 * still asks, and runs with the user's own hooks (see {@link runGit}).
 */
export const READ_ONLY_GIT_ARGS = {
  GitStatus: ['status', '--short', '--ignore-submodules=dirty'],
  GitDiff: ['diff', ...HARDENED_DIFF_ARGS],
  GitLog: ['log', '--oneline', '-20', '--no-show-signature'],
  GitBranch: ['branch', '-a'],
} as const satisfies Readonly<Record<string, string[]>>;

export const gitTools: ToolDefinition[] = [
  {
    name: 'GitStatus',
    idempotent: true,
    policy: { concurrency: 'parallel' },
    description:
      'Show the working tree status (git status --short). Changes inside submodules are not listed; run `git -C <sub> status` for those.',
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
