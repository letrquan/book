import { describe, expect, it } from 'vitest';
import { enterAlternateScreen } from './run.js';

function fakeStdout(isTTY: boolean) {
  const writes: string[] = [];
  const stdout = {
    isTTY,
    write(chunk: string | Uint8Array) {
      writes.push(String(chunk));
      return true;
    },
  } as Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;

  return { stdout, writes };
}

describe('enterAlternateScreen', () => {
  it('writes enter and one restore sequence for TTY output', () => {
    const { stdout, writes } = fakeStdout(true);
    const restore = enterAlternateScreen(stdout);

    expect(writes).toEqual(['\x1b[?1049h']);

    restore();
    restore();

    expect(writes).toEqual(['\x1b[?1049h', '\x1b[?1049l']);
  });

  it('does nothing for non-TTY output', () => {
    const { stdout, writes } = fakeStdout(false);
    const restore = enterAlternateScreen(stdout);

    restore();

    expect(writes).toEqual([]);
  });
});
