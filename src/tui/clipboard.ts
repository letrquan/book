import { spawn } from 'node:child_process';

/** OSC 52 clipboard-write sequence understood by modern terminals. */
export function buildOsc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x1b\\`;
}

export interface ClipboardWriterDeps {
  platform?: NodeJS.Platform;
  stdout?: { write(data: string): unknown };
  spawn?: typeof spawn;
}

const CLIPBOARD_COMMAND_TIMEOUT_MS = 3_000;

function pipeTextToCommand(
  spawnFn: typeof spawn,
  command: string,
  args: readonly string[],
  text: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(command, [...args], {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => child.kill(), CLIPBOARD_COMMAND_TIMEOUT_MS);
    const settle = (success: boolean) => {
      clearTimeout(timer);
      resolve(success);
    };
    child.once('error', () => settle(false));
    child.once('close', (code) => settle(code === 0));
    child.stdin.once('error', () => {});
    child.stdin.end(text);
  });
}

/**
 * Copy text to the system clipboard: OSC 52 first (works in Windows Terminal
 * and over SSH), then a best-effort platform command fallback. Never throws.
 */
export async function writeClipboard(
  text: string,
  deps: ClipboardWriterDeps = {},
): Promise<boolean> {
  if (!text) return false;
  const platform = deps.platform ?? process.platform;
  const stdout = deps.stdout ?? process.stdout;
  const spawnFn = deps.spawn ?? spawn;

  try {
    stdout.write(buildOsc52Sequence(text));
  } catch {
    // Clipboard output is best effort.
  }

  try {
    if (platform === 'win32') return await pipeTextToCommand(spawnFn, 'clip.exe', [], text);
    if (platform === 'darwin') return await pipeTextToCommand(spawnFn, 'pbcopy', [], text);
    if (await pipeTextToCommand(spawnFn, 'wl-copy', [], text)) return true;
    return await pipeTextToCommand(spawnFn, 'xclip', ['-selection', 'clipboard'], text);
  } catch {
    return false;
  }
}
