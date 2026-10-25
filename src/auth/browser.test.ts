import { describe, expect, it } from 'vitest';
import { browserCommands } from './browser.js';

const url = 'https://auth.example/authorize?a=1&b=2';

describe('browserCommands', () => {
  it('uses the platform opener when $BROWSER is unset, the URL as one argument', () => {
    expect(browserCommands(url, {}, 'linux')).toEqual([['xdg-open', [url]]]);
    expect(browserCommands(url, {}, 'darwin')).toEqual([['open', [url]]]);
    expect(browserCommands(url, {}, 'win32')).toEqual([
      ['rundll32', ['url.dll,FileProtocolHandler', url]],
    ]);
  });

  it('reads $BROWSER as a list of commands with arguments, %s standing for the URL', () => {
    expect(browserCommands(url, { BROWSER: 'firefox --new-window' }, 'linux')).toEqual([
      ['firefox', ['--new-window', url]],
    ]);
    expect(browserCommands(url, { BROWSER: 'firefox:chromium' }, 'linux')).toEqual([
      ['firefox', [url]],
      ['chromium', [url]],
    ]);
    expect(browserCommands(url, { BROWSER: 'open -a Safari %s' }, 'darwin')).toEqual([
      ['open', ['-a', 'Safari', url]],
    ]);
    expect(browserCommands(url, { BROWSER: 'C:\\b\\chrome.exe;edge' }, 'win32')).toEqual([
      ['C:\\b\\chrome.exe', [url]],
      ['edge', [url]],
    ]);
  });
});
