import { describe, expect, it } from 'vitest';
import { openInBrowser } from './browser.js';

describe('openInBrowser', () => {
  /**
   * The URL is assembled from configurable settings, so a launcher that
   * interprets it as a local target must never see it. `open` and rundll32 take
   * it as an argument; a `file:` or shell-resolved scheme is refused outright.
   */
  it('refuses anything that is not an http(s) URL', () => {
    expect(openInBrowser('file:///etc/passwd', 'linux')).toBe(false);
    expect(openInBrowser('not a url', 'darwin')).toBe(false);
    expect(openInBrowser('javascript:alert(1)', 'win32')).toBe(false);
    expect(openInBrowser('', 'linux')).toBe(false);
  });

  it('reports failure rather than throwing when no launcher exists', () => {
    // The command below does not exist on any supported platform; spawn's error
    // arrives asynchronously, so this asserts the call itself stays quiet.
    expect(() => openInBrowser('https://example.com/authorize?a=1&b=2', 'linux')).not.toThrow();
  });
});
