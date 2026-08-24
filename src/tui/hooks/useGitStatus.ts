import { useState, useEffect, useCallback } from 'react';
import { execFile } from 'node:child_process';
import { isTranscriptScrollActive } from '../scroll-activity.js';

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
      activeController = new AbortController();

      try {
        // `rev-parse` decides whether this is a repository. Probing for a
        // `.git` entry only succeeds at the repository root, so launching from
        // any subdirectory reported no branch at all.
        const branch = await runGit(
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          workspace,
          activeController.signal,
        );
        const short = await runGit(['status', '--short'], workspace, activeController.signal);

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

function runGit(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: 5_000, encoding: 'utf8', windowsHide: true, signal },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}
