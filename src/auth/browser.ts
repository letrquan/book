/**
 * Open a URL in the user's browser, for a sign-in. Never through a shell: the URL is one
 * argument to the opener, so its `&` and `?` reach the browser intact. `$BROWSER`, when set,
 * names the program to use, as for git, gh and Python's `webbrowser`. Every caller prints the
 * URL as well, so a machine with no browser (an SSH session) can still finish the sign-in.
 */

import { spawn } from 'node:child_process';

function opener(url: string, env: NodeJS.ProcessEnv): [string, string[]] {
  const browser = env.BROWSER?.trim();
  if (browser) return [browser, [url]];
  if (process.platform === 'darwin') return ['open', [url]];
  // `cmd /c start` would parse the `&` in the query string; the URL handler takes it whole.
  if (process.platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}

/** Whether an opener was started. It does not wait for, or report on, the browser itself. */
export function openInBrowser(url: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const [command, args] = opener(url, env);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
