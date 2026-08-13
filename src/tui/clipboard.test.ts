import { describe, expect, it } from 'vitest';
import type { spawn as SpawnCommand } from 'node:child_process';
import { buildOsc52Sequence, writeClipboard, type ClipboardWriterDeps } from './clipboard.js';

interface SpawnCall {
  command: string;
  args: readonly string[];
  text: string;
}

interface FakeStdout {
  writes: string[];
  write: (data: string) => boolean;
}

function createStdout(): FakeStdout {
  const stdout: FakeStdout = {
    writes: [],
    write(data: string) {
      stdout.writes.push(data);
      return true;
    },
  };
  return stdout;
}

/** Fake spawn whose children close with `closeCode`, or emit an error when null. */
function createSpawn(calls: SpawnCall[], closeCode: number | null = 0): typeof SpawnCommand {
  const spawnFn = (command: string, args: readonly string[]) => {
    let closeListener: ((code: number | null) => void) | undefined;
    let errorListener: (() => void) | undefined;
    const child = {
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
    return child;
  };
  return spawnFn as unknown as typeof SpawnCommand;
}

describe('buildOsc52Sequence', () => {
  it('base64-encodes UTF-8 text into an OSC 52 clipboard write', () => {
    expect(buildOsc52Sequence('hi')).toBe('\x1b]52;c;aGk=\x1b\\');
    const accented = Buffer.from('é', 'utf8').toString('base64');
    expect(buildOsc52Sequence('é')).toBe(`\x1b]52;c;${accented}\x1b\\`);
  });
});

describe('writeClipboard', () => {
  it('returns false without writing for empty text', async () => {
    const stdout = createStdout();
    await expect(writeClipboard('', { stdout })).resolves.toBe(false);
    expect(stdout.writes).toEqual([]);
  });

  it('writes OSC 52 and pipes text to clip.exe on win32', async () => {
    const stdout = createStdout();
    const calls: SpawnCall[] = [];
    const ok = await writeClipboard('hello', {
      platform: 'win32',
      stdout,
      spawn: createSpawn(calls),
    });
    expect(ok).toBe(true);
    expect(stdout.writes[0]).toBe(buildOsc52Sequence('hello'));
    expect(calls).toEqual([{ command: 'clip.exe', args: [], text: 'hello' }]);
  });

  it('uses pbcopy on darwin', async () => {
    const calls: SpawnCall[] = [];
    await writeClipboard('hello', {
      platform: 'darwin',
      stdout: createStdout(),
      spawn: createSpawn(calls),
    });
    expect(calls.map((call) => call.command)).toEqual(['pbcopy']);
  });

  it('falls back from wl-copy to xclip when wl-copy is unavailable', async () => {
    const calls: SpawnCall[] = [];
    let attempt = 0;
    const spawnFn = ((command: string, args: readonly string[]) => {
      attempt += 1;
      return createSpawn(calls, attempt === 1 ? null : 0)(command, args);
    }) as unknown as ClipboardWriterDeps['spawn'];
    const ok = await writeClipboard('hello', {
      platform: 'linux',
      stdout: createStdout(),
      spawn: spawnFn,
    });
    expect(ok).toBe(true);
    expect(calls.map((call) => call.command)).toEqual(['wl-copy', 'xclip']);
    expect(calls[1]?.args).toEqual(['-selection', 'clipboard']);
  });

  it('never throws when the platform command cannot start', async () => {
    const stdout = createStdout();
    const spawnFn = (() => {
      throw new Error('ENOENT');
    }) as unknown as ClipboardWriterDeps['spawn'];
    await expect(
      writeClipboard('hello', { platform: 'win32', stdout, spawn: spawnFn }),
    ).resolves.toBe(false);
    expect(stdout.writes[0]).toBe(buildOsc52Sequence('hello'));
  });
});
