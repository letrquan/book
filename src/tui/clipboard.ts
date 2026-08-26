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

/**
 * How far a copy actually got.
 *
 * `clipboard` is the only confirmed outcome: a platform command exited zero.
 * OSC 52 has no reply, so emitting it proves nothing — tmux without
 * `set-clipboard on`, and terminals where the sequence is opt-in, silently
 * ignore it. Reporting that as success told the user their selection was copied
 * when it was not, so the two are kept apart.
 */
export type ClipboardOutcome = 'clipboard' | 'terminal' | 'failed';

/** Copy through OSC 52 and a best-effort local platform clipboard command. */
export async function writeClipboard(
  text: string,
  deps: ClipboardWriterDeps = {},
): Promise<ClipboardOutcome> {
  if (!text) return 'failed';
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

  const unconfirmed: ClipboardOutcome = oscWritten ? 'terminal' : 'failed';
  try {
    if (platform === 'win32') {
      return (await pipeTextToCommand(spawnFn, 'clip.exe', [], text)) ? 'clipboard' : unconfirmed;
    }
    if (platform === 'darwin') {
      return (await pipeTextToCommand(spawnFn, 'pbcopy', [], text)) ? 'clipboard' : unconfirmed;
    }
    if (await pipeTextToCommand(spawnFn, 'wl-copy', [], text)) return 'clipboard';
    return (await pipeTextToCommand(spawnFn, 'xclip', ['-selection', 'clipboard'], text))
      ? 'clipboard'
      : unconfirmed;
  } catch {
    return unconfirmed;
  }
}
