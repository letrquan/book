import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { openInBrowser } from './browser.js';

/**
 * A launcher that does not exist on any platform, so the suite never actually
 * opens a browser tab on a developer machine or a CI image with xdg-utils.
 * `openInBrowser` picks its command from the platform, so this is spelled as an
 * unsupported platform value rather than by stubbing spawn.
 */
const NO_LAUNCHER = 'book-test-nonexistent-platform' as unknown as NodeJS.Platform;

describe('openInBrowser', () => {
  /**
   * The URL is assembled from configurable settings, so a launcher that
   * interprets it as a local target must never see it. `open` and rundll32 take
   * it as an argument; a `file:` or shell-resolved scheme is refused outright.
   */
  it('refuses anything that is not an http(s) URL', async () => {
    await expect(openInBrowser('file:///etc/passwd', 'linux')).resolves.toBe(false);
    await expect(openInBrowser('not a url', 'darwin')).resolves.toBe(false);
    await expect(openInBrowser('javascript:alert(1)', 'win32')).resolves.toBe(false);
    await expect(openInBrowser('', 'linux')).resolves.toBe(false);
  });

  /**
   * The load-bearing case. `spawn` never throws for a missing executable —
   * ENOENT arrives asynchronously — so reporting success from the absence of a
   * synchronous throw told every headless host that a browser had opened, and
   * the login then sat waiting for a redirect nothing would produce.
   */
  it('reports false when the launcher binary does not exist', async () => {
    await expect(openInBrowser('https://example.com/authorize?a=1&b=2', NO_LAUNCHER)).resolves.toBe(
      false,
    );
  });

  it('reports true once the child actually spawns', async () => {
    // A launcher that exists everywhere POSIX and exits immediately, so the
    // success path is asserted without opening a browser on this machine.
    if (process.platform === 'win32') return;
    const spawnTrue = ((_command: string, _args: string[], options: object) =>
      spawn('true', [], options as never)) as unknown as typeof spawn;
    await expect(
      openInBrowser('https://example.com/authorize?a=1&b=2', 'linux', spawnTrue),
    ).resolves.toBe(true);
  });

  it('passes the URL through as a single argument, never through a shell', async () => {
    if (process.platform === 'win32') return;
    let received: readonly string[] = [];
    const capture = ((command: string, args: string[], options: object) => {
      received = [command, ...args];
      return spawn('true', [], options as never);
    }) as unknown as typeof spawn;
    // `&` is in every authorization URL and is a shell metacharacter.
    await openInBrowser('https://example.com/authorize?a=1&b=2', 'linux', capture);
    expect(received).toEqual(['xdg-open', 'https://example.com/authorize?a=1&b=2']);
  });
});
