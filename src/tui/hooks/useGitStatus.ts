import { useState, useEffect } from 'react';
import { execFile } from 'node:child_process';
import { existsSync } from 'fs';
import { join } from 'path';

interface GitStatus {
  branch: string;
  status: string; // '\u2713' clean, '+2 ~1' staged/modified
  error?: string;
}

export function useGitStatus(workspace: string): GitStatus {
  const [status, setStatus] = useState<GitStatus>({ branch: '?', status: '' });

  useEffect(() => {
    let cancelled = false;
    let running = false;
    let activeController: AbortController | undefined;

    async function check(): Promise<void> {
      if (running) return;
      running = true;
      activeController = new AbortController();
      if (!existsSync(join(workspace, '.git'))) {
        if (!cancelled) setStatus({ branch: '?', status: '' });
        running = false;
        return;
      }

      try {
        const branch = await runGit(
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          workspace,
          activeController.signal,
        );
        const short = await runGit(['status', '--short'], workspace, activeController.signal);

        if (!short) {
          if (!cancelled) setStatus({ branch, status: '\u2713' });
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

        if (!cancelled) setStatus({ branch, status: parts.join(' ') });
      } catch {
        if (!cancelled) setStatus({ branch: '?', status: '', error: 'git error' });
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
  }, [workspace]);

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
