import { describe, expect, it } from 'vitest';
import { enterInteractiveScreen } from './run.js';

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

describe('enterInteractiveScreen', () => {
  it('enters alternate screen without capturing terminal text selection', () => {
    const { stdout, writes } = fakeStdout(true);
    const restore = enterInteractiveScreen(stdout);

    expect(writes).toEqual(['\x1b[?1049h\x1b[?1006l\x1b[?1000l']);

    restore();
    restore();

    expect(writes).toEqual([
      '\x1b[?1049h\x1b[?1006l\x1b[?1000l',
      '\x1b[?1006l\x1b[?1000l\x1b[?1049l',
    ]);
  });

  it('does nothing for non-TTY output', () => {
    const { stdout, writes } = fakeStdout(false);
    const restore = enterInteractiveScreen(stdout);

    restore();

    expect(writes).toEqual([]);
  });
});
