import { useState, useEffect, useCallback } from 'react';
import { execFile } from 'node:child_process';
import { isTranscriptScrollActive } from '../scroll-activity.js';
import { buildChildEnv } from '../../child-env.js';
import { isInGitRepository } from '../../repo-containment.js';
import { hardenedGitArgs, hardenedGitEnv } from '../../tools/git.js';
import { readRepositoryProgramPins } from '../../tools/git-repository-programs.js';

/**
 * Whether `dir` sits anywhere inside a working tree, without spawning anything.
 *
 * Probing only `<workspace>/.git` succeeds at the repository root alone, so
 * launching from a subdirectory reported no branch. Asking `git rev-parse`
 * instead fixed that but made every poll spawn children even where there is no
 * repository at all: three processes every five seconds, forever, in any plain
 * directory. Walking up for the entry costs a handful of `stat` calls and gets
 * the subdirectory case right. A worktree or submodule stores `.git` as a file
 * rather than a directory, so the entry is what is checked, not its type.
 *
 * The walk itself is `isInGitRepository`, shared with the prompt's git line: it
 * follows the real path, as git does from its working directory, and ignores a
 * `.git` at the user's home directory for a project below it without its own
 * (a dotfiles repository), so such a project shows no branch and spawns
 * nothing, where git, which Book runs with the home directory as a ceiling
 * (`hardenedGitEnv`), would only fail. A workspace that is the home directory
 * shows its branch (#579).
 */
export function isInsideWorkTree(dir: string, exists?: (path: string) => boolean): boolean {
  return isInGitRepository(dir, exists);
}

export interface GitStatus {
  branch: string;
  status: string; // '\u2713' clean, '+2 ~1' staged/modified
  error?: string;
}

/**
 * Replace state only when the reported status actually changed.
 *
 * The poll allocates a fresh object every tick, so returning it unconditionally
 * made React re-render the whole app twelve times a minute in an idle session
 * for no visual change.
 */
export function sameStatus(left: GitStatus, right: GitStatus): boolean {
  return left.branch === right.branch && left.status === right.status && left.error === right.error;
}

export function useGitStatus(workspace: string): GitStatus {
  const [status, setStatus] = useState<GitStatus>({ branch: '?', status: '' });
  const update = useCallback((next: GitStatus) => {
    setStatus((current) => (sameStatus(current, next) ? current : next));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let running = false;
    let activeController: AbortController | undefined;

    async function check(): Promise<void> {
      if (isTranscriptScrollActive()) return;
      if (running) return;
      running = true;
      if (!isInsideWorkTree(workspace)) {
        if (!cancelled) update({ branch: '?', status: '' });
        running = false;
        return;
      }
      activeController = new AbortController();

      try {
        const pins = await readRepositoryProgramPins(workspace, undefined, {
          signal: activeController.signal,
          timeoutMs: 5_000,
        });
        const branch = await runGit(
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          workspace,
          activeController.signal,
          pins,
        );
        const short = await runGit(['status', '--short'], workspace, activeController.signal, pins);

        if (!short) {
          if (!cancelled) update({ branch, status: '\u2713' });
          return;
        }

        const lines = short.split('\n').filter(Boolean);
        let staged = 0;
        let modified = 0;
        for (const line of lines) {
          const stagedChar = line[0];
          const modChar = line[1];
          if (stagedChar !== ' ' && stagedChar !== '?') staged++;
          if (modChar !== ' ') modified++;
        }

        const parts: string[] = [];
        if (staged > 0) parts.push(`+${staged}`);
        if (modified > 0) parts.push(`~${modified}`);

        if (!cancelled) update({ branch, status: parts.join(' ') });
      } catch {
        // Not a repository, or git is unavailable — both mean "no branch".
        if (!cancelled) update({ branch: '?', status: '', error: 'git error' });
      } finally {
        running = false;
        activeController = undefined;
      }
    }

    void check();
    const interval = setInterval(() => void check(), 5000);
    return () => {
      cancelled = true;
      activeController?.abort();
      clearInterval(interval);
    };
  }, [update, workspace]);

  return status;
}

/**
 * One poll's `git` call, hardened.
 *
 * The poll is not a tool call: nothing asks before it runs, and it runs every five seconds for as
 * long as the session lasts, in whatever repository was opened. A clone brings `.git/config` with
 * it, and `core.fsmonitor` there names a program `git status` executes — so without
 * `hardenedGitArgs` a checkout that sets it runs that program as soon as Book opens it. Every
 * call here is read-only, so the read-only hardening is the right one; the pager and the
 * credential prompt it cannot wait on come with it, as in `readOnlyGit`.
 */
async function runGit(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  pins: readonly string[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      hardenedGitArgs([...pins, ...args]),
      {
        cwd,
        timeout: 5_000,
        encoding: 'utf8',
        windowsHide: true,
        signal,
        env: buildChildEnv(process.env, hardenedGitEnv()),
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}
