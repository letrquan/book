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

    let settled = false;
    const settle = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(success);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(false);
    }, CLIPBOARD_COMMAND_TIMEOUT_MS);
    child.once('error', () => settle(false));
    child.once('close', (code) => settle(code === 0));
    child.stdin.once('error', () => {});
    child.stdin.end(text);
  });
}

/** Copy through OSC 52 and a best-effort local platform clipboard command. */
export async function writeClipboard(
  text: string,
  deps: ClipboardWriterDeps = {},
): Promise<boolean> {
  if (!text) return false;
  const platform = deps.platform ?? process.platform;
  const stdout = deps.stdout ?? process.stdout;
  const spawnFn = deps.spawn ?? spawn;
  let oscWritten = false;

  try {
    stdout.write(buildOsc52Sequence(text));
    oscWritten = true;
  } catch {
    // OSC 52 is optional; keep trying the local clipboard command.
  }

  try {
    if (platform === 'win32') {
      return (await pipeTextToCommand(spawnFn, 'clip.exe', [], text)) || oscWritten;
    }
    if (platform === 'darwin') {
      return (await pipeTextToCommand(spawnFn, 'pbcopy', [], text)) || oscWritten;
    }
    if (await pipeTextToCommand(spawnFn, 'wl-copy', [], text)) return true;
    return (
      (await pipeTextToCommand(spawnFn, 'xclip', ['-selection', 'clipboard'], text)) || oscWritten
    );
  } catch {
    return oscWritten;
  }
}
