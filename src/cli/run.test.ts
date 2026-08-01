import { describe, expect, it } from 'vitest';
import { enterInteractiveScreen, shouldBridgeWslTerminal } from './run.js';

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
  it('enters alternate screen with SGR mouse reporting for wheel scrolling', () => {
    const { stdout, writes } = fakeStdout(true);
    const restore = enterInteractiveScreen(stdout);

    expect(writes).toEqual(['\x1b[?1049h\x1b[?1000h\x1b[?1006h']);

    restore();
    restore();

    expect(writes).toEqual([
      '\x1b[?1049h\x1b[?1000h\x1b[?1006h',
      '\x1b[?1006l\x1b[?1000l\x1b[?1049l',
    ]);
  });

  it('does nothing for non-TTY output', () => {
    const { stdout, writes } = fakeStdout(false);
    const previousDistro = process.env.WSL_DISTRO_NAME;
    const previousWindowsTerminal = process.env.WT_SESSION;
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WT_SESSION;
    try {
      const restore = enterInteractiveScreen(stdout);
      restore();
      expect(writes).toEqual([]);
    } finally {
      if (previousDistro === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = previousDistro;
      if (previousWindowsTerminal === undefined) delete process.env.WT_SESSION;
      else process.env.WT_SESSION = previousWindowsTerminal;
    }
  });

  it('enables mouse capture for WSL sessions whose stdout is not marked TTY', () => {
    const { stdout, writes } = fakeStdout(false);
    const previousDistro = process.env.WSL_DISTRO_NAME;
    const previousWindowsTerminal = process.env.WT_SESSION;
    const previousWslEnv = process.env.WSLENV;
    process.env.WT_SESSION = 'test-session';
    process.env.WSLENV = 'WT_SESSION:WT_PROFILE_ID:';

    try {
      const restore = enterInteractiveScreen(stdout);
      restore();
      expect(writes[0]).toContain('\x1b[?1000h');
    } finally {
      if (previousDistro === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = previousDistro;
      if (previousWindowsTerminal === undefined) delete process.env.WT_SESSION;
      else process.env.WT_SESSION = previousWindowsTerminal;
      if (previousWslEnv === undefined) delete process.env.WSLENV;
      else process.env.WSLENV = previousWslEnv;
    }
  });

  it('detects the Windows Node through WSL terminal bridge narrowly', () => {
    expect(
      shouldBridgeWslTerminal('win32', {
        WT_SESSION: 'session',
        WSLENV: 'WT_SESSION:WT_PROFILE_ID:',
      }),
    ).toBe(true);
    expect(shouldBridgeWslTerminal('linux', { WT_SESSION: 'session', WSLENV: 'WT_SESSION:' })).toBe(
      false,
    );
    expect(shouldBridgeWslTerminal('win32', { WT_SESSION: 'session' })).toBe(false);
  });
});
