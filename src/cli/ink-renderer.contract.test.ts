import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Text, render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { installInkFrameThrottle } from './ink-frame-throttle.js';
import {
  VERIFIED_INK_VERSION,
  hasInkTrailingNewlineFix,
  installedInkVersion,
} from './ink-renderer.js';

describe('Ink renderer contract', () => {
  it('runs the Ink release the TUI was verified against', () => {
    expect(
      installedInkVersion(),
      `Ink changed from the verified ${VERIFIED_INK_VERSION}. Re-verify the TUI as ` +
        'docs/guide/development.md ("Upgrading Ink") describes, then update VERIFIED_INK_VERSION.',
    ).toBe(VERIFIED_INK_VERSION);
  });

  it("has the incremental renderer's trailing-newline fix", () => {
    expect(hasInkTrailingNewlineFix()).toBe(true);
  });

  it('lets Book replace the render throttle', async () => {
    const stdout = Object.assign(new EventEmitter(), {
      columns: 80,
      rows: 24,
      isTTY: true,
      write: () => true,
    }) as unknown as NodeJS.WriteStream;
    const stdin = Object.assign(new PassThrough(), {
      isTTY: false,
    }) as unknown as NodeJS.ReadStream;
    const app = render(createElement(Text, null, 'frame'), {
      stdout,
      stdin,
      patchConsole: false,
      interactive: true,
    });
    try {
      expect(
        await installInkFrameThrottle(stdout),
        "Ink's private instance changed shape; update installInkFrameThrottle before VERIFIED_INK_VERSION.",
      ).toBe(true);
    } finally {
      app.unmount();
      app.cleanup();
    }
  });
});
