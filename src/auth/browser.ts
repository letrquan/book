/**
 * Open a URL in the user's browser, for a sign-in. Never through a shell: the URL is one
 * argument to the opener, so its `&` and `?` reach the browser intact. `$BROWSER`, when set,
 * names the program to use, as for git, gh and Python's `webbrowser`. Every caller prints the
 * URL as well, so a machine with no browser (an SSH session) can still finish the sign-in.
 */

import { spawn } from 'node:child_process';

/**
 * The commands to try, in order. `$BROWSER` is read as Python's `webbrowser` reads it: a list
 * separated by the platform's path delimiter, each entry a command with arguments split on
 * whitespace, where `%s` stands for the URL (appended when absent). No shell ever sees it.
 */
export function browserCommands(
  url: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Array<[string, string[]]> {
  const configured = (env.BROWSER ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0)
    .map(([command, ...args]): [string, string[]] => {
      const withUrl = args.map((arg) => arg.replaceAll('%s', url));
      return [command, args.some((arg) => arg.includes('%s')) ? withUrl : [...withUrl, url]];
    });
  if (configured.length > 0) return configured;
  if (platform === 'darwin') return [['open', [url]]];
  // `cmd /c start` would parse the `&` in the query string; the URL handler takes it whole.
  if (platform === 'win32') return [['rundll32', ['url.dll,FileProtocolHandler', url]]];
  return [['xdg-open', [url]]];
}

function start(command: string, args: string[]): Promise<boolean> {
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

/** Whether an opener was started. It does not wait for, or report on, the browser itself. */
export async function openInBrowser(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  for (const [command, args] of browserCommands(url, env)) {
    if (await start(command, args)) return true;
  }
  return false;
}
