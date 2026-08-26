import { describe, expect, it } from 'vitest';
import type { spawn as SpawnCommand } from 'node:child_process';
import { buildOsc52Sequence, writeClipboard, type ClipboardWriterDeps } from './clipboard.js';

interface SpawnCall {
  command: string;
  args: readonly string[];
  text: string;
}

function createSpawn(calls: SpawnCall[], closeCode: number | null = 0): typeof SpawnCommand {
  const spawnFn = (command: string, args: readonly string[]) => {
    let closeListener: ((code: number | null) => void) | undefined;
    let errorListener: (() => void) | undefined;
    return {
      once(event: string, listener: (code: number | null) => void) {
        if (event === 'close') closeListener = listener;
        if (event === 'error') errorListener = listener as () => void;
      },
      kill: () => {},
      stdin: {
        once: () => {},
        end: (text: string) => {
          calls.push({ command, args, text });
          queueMicrotask(() => {
            if (closeCode === null) errorListener?.();
            else closeListener?.(closeCode);
          });
        },
      },
    };
  };
  return spawnFn as unknown as typeof SpawnCommand;
}

describe('clipboard', () => {
  it('base64-encodes UTF-8 text for OSC 52', () => {
    expect(buildOsc52Sequence('hi')).toBe('\x1b]52;c;aGk=\x1b\\');
  });

  it('writes OSC 52 and pipes text to clip.exe on Windows', async () => {
    const writes: string[] = [];
    const calls: SpawnCall[] = [];
    await expect(
      writeClipboard('hello', {
        platform: 'win32',
        stdout: { write: (data) => writes.push(data) },
        spawn: createSpawn(calls),
      }),
    ).resolves.toBe('clipboard');
    expect(writes).toEqual([buildOsc52Sequence('hello')]);
    expect(calls).toEqual([{ command: 'clip.exe', args: [], text: 'hello' }]);
  });

  it('falls back from wl-copy to xclip', async () => {
    const calls: SpawnCall[] = [];
    let attempt = 0;
    const spawnFn = ((command: string, args: readonly string[]) => {
      attempt++;
      return createSpawn(calls, attempt === 1 ? null : 0)(command, args);
    }) as unknown as ClipboardWriterDeps['spawn'];

    await expect(
      writeClipboard('hello', {
        platform: 'linux',
        stdout: { write: () => true },
        spawn: spawnFn,
      }),
    ).resolves.toBe('clipboard');
    expect(calls.map((call) => call.command)).toEqual(['wl-copy', 'xclip']);
  });

  it('fails for empty text without spawning', async () => {
    await expect(writeClipboard('')).resolves.toBe('failed');
  });

  it('reports OSC 52 alone as unconfirmed rather than as a copy', async () => {
    // OSC 52 has no reply, so emitting it proves nothing: tmux without
    // set-clipboard on, and terminals where it is opt-in, drop it silently.
    // Claiming a copy there told the user something untrue.
    const spawnFn = (() => {
      throw new Error('ENOENT');
    }) as unknown as ClipboardWriterDeps['spawn'];
    await expect(
      writeClipboard('hello', {
        platform: 'linux',
        stdout: { write: () => true },
        spawn: spawnFn,
      }),
    ).resolves.toBe('terminal');
  });

  it('fails when neither OSC 52 nor a platform command lands', async () => {
    const spawnFn = (() => {
      throw new Error('ENOENT');
    }) as unknown as ClipboardWriterDeps['spawn'];
    await expect(
      writeClipboard('hello', {
        platform: 'linux',
        stdout: {
          write: () => {
            throw new Error('EPIPE');
          },
        },
        spawn: spawnFn,
      }),
    ).resolves.toBe('failed');
  });
});
