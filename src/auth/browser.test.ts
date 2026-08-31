import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { openInBrowser } from './browser.js';

/**
 * A command name no PATH resolves, used to reach the real ENOENT path.
 *
 * This cannot be spelled as an unsupported *platform* value: `launcher()` maps
 * every platform that is not darwin or win32 to `xdg-open`, so an unknown
 * platform selects a launcher that genuinely exists on a Linux CI image. Doing
 * it that way both failed there and spawned the real launcher against the test
 * URL, which is the one thing this file must never do. The command is injected
 * instead, through the seam the success-path tests already use.
 */
const NO_LAUNCHER = 'book-test-nonexistent-launcher';

/** Forwards to the real `spawn`, so ENOENT arrives the way production sees it. */
const spawnMissing = ((_command: string, args: string[], options: object) =>
  spawn(NO_LAUNCHER, args, options as never)) as unknown as typeof spawn;

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
    await expect(
      openInBrowser('https://example.com/authorize?a=1&b=2', 'linux', spawnMissing),
    ).resolves.toBe(false);
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
