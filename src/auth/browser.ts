/**
 * Best-effort browser launch for the login redirect.
 *
 * Always best-effort: over SSH, in a container, or with no desktop session
 * there is nothing to launch, and the caller has already printed the URL. A
 * failure here is silent by design — the flow still completes when the user
 * opens the URL themselves.
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

export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
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
  try {
    const child = spawn(command, [...args, url], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
