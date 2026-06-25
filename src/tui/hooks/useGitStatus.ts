import { useState, useEffect } from 'react';
import { execSync } from 'child_process';
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

    function check() {
      if (!existsSync(join(workspace, '.git'))) {
        if (!cancelled) setStatus({ branch: '?', status: '' });
        return;
      }

      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: workspace,
          timeout: 5000,
          encoding: 'utf-8',
        }).trim();

        const short = execSync('git status --short', {
          cwd: workspace,
          timeout: 5000,
          encoding: 'utf-8',
        }).trim();

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
      }
    }

    check();
    const interval = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [workspace]);

  return status;
}
