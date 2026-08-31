/**
 * Best-effort browser launch for the login redirect.
 *
 * Always best-effort: over SSH, in a container, or with no desktop session
 * there is nothing to launch, and the caller has already printed the URL. But
 * the *report* has to be honest — the caller uses it to choose between "Opened
 * your browser at:" and "Open this URL to continue:", and a machine with no
 * launcher that is told a browser opened will sit at the prompt until the login
 * times out. `spawn` never throws for a missing executable; ENOENT arrives on
 * the `error` event, so success is resolved from the child's own events rather
 * than from the absence of a synchronous throw.
 *
 * Spawned detached and unreferenced so a browser that keeps running does not
 * hold the CLI open, and through the async `spawn` rather than any of the
 * blocking child-process APIs the architecture check forbids.
 */
import { spawn } from 'node:child_process';

function launcher(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [] };
  // Not `cmd /c start`: an authorization URL is full of `&`, which cmd.exe
  // treats as a command separator no matter how Node quotes the argument.
  // rundll32 is an ordinary executable, so the URL reaches it intact.
  if (platform === 'win32') {
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler'] };
  }
  return { command: 'xdg-open', args: [] };
}

export type SpawnLike = typeof spawn;

export async function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  // Injected only by the tests, which must assert the success path without
  // opening a real browser tab on the machine running the suite.
  spawnImpl: SpawnLike = spawn,
): Promise<boolean> {
  // Only ever hand a launcher an http(s) URL: these commands interpret other
  // schemes (file:, and on Windows anything the shell resolves) as local
  // targets, and the URL is assembled from configurable settings.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const { command, args } = launcher(platform);
  return new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawnImpl(command, [...args, url], {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
    } catch {
      resolve(false);
      return;
    }
    // Whichever lands first wins; the other is ignored because `resolve` on an
    // already-settled promise is a no-op.
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
