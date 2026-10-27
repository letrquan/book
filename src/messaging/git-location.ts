/**
 * Where a session works, in git's terms, for its live-session record (#620 4b): the worktree, the
 * repository every worktree of it shares, and the branch. Peers compare the first two to tell
 * "editing the same files" from "same repository, another checkout".
 */

import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isInGitRepository } from '../repo-containment.js';
import { openReadOnlyGit } from '../tools/git.js';

export interface GitLocation {
  /** `git rev-parse --show-toplevel`: a real path. */
  worktree: string;
  /** The common git directory (`--git-common-dir`), real path: one per repository. */
  repository: string;
  /** The checked-out branch; absent on a detached HEAD. */
  branch?: string;
}

function outputOf(result: {
  success: boolean;
  output: string;
  error?: string;
}): string | undefined {
  if (!result.success) return undefined;
  const text = result.output.trim();
  return text && text !== '(no output)' ? text : undefined;
}

/**
 * The git location of `cwd`, or `null` outside a repository. Rejects when git could not say — a
 * refused configuration, a failed or cancelled call — so a caller can keep the answer it had. Each
 * call is hardened as the prompt's git line is (`openReadOnlyGit`): a checkout's `core.fsmonitor`
 * program does not run (#574).
 */
export async function resolveGitLocation(
  cwd: string,
  signal?: AbortSignal,
): Promise<GitLocation | null> {
  if (!isInGitRepository(cwd)) return null;
  const git = await openReadOnlyGit({
    workspaceRoot: cwd,
    env: process.env as Record<string, string>,
    signal,
  });
  const [dirs, branch] = await Promise.all([
    git.run(['rev-parse', '--show-toplevel', '--git-common-dir']),
    git.run(['symbolic-ref', '--short', '-q', 'HEAD']),
  ]);
  const [top, common] = (outputOf(dirs) ?? '').split(/\r?\n/);
  if (!top || !common) throw new Error(dirs.error ?? 'git did not name the worktree');
  const [worktree, repository] = await Promise.all([
    realpath(top),
    // Relative to the directory git ran in when it is not absolute.
    realpath(resolve(cwd, common)),
  ]);
  const name = outputOf(branch);
  return { worktree, repository, ...(name ? { branch: name } : {}) };
}
