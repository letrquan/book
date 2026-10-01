import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Text, render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { installInkFrameThrottle } from './ink-frame-throttle.js';
import { isInkOutputShape } from './ink-output-cache.js';
import {
  VERIFIED_INK_VERSION,
  hasInkTrailingNewlineFix,
  inkBuildDir,
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

  it("lets Book cache Ink's output rows", async () => {
    // Both read from Ink's own build directory, never the hoisted copy beside it: an Ink upgrade
    // that changes either fails here rather than in the middle of a scroll.
    const outputPath = join(inkBuildDir(), 'output.js');
    const outputModule = (await import(pathToFileURL(outputPath).href)) as { default: unknown };
    expect(
      isInkOutputShape(outputModule.default),
      "Ink's private Output changed shape; update ink-output-cache.ts before VERIFIED_INK_VERSION.",
    ).toBe(true);
    const sliceAnsiPath = createRequire(outputPath).resolve('slice-ansi');
    const sliceAnsiModule = (await import(pathToFileURL(sliceAnsiPath).href)) as {
      default: unknown;
    };
    expect(typeof sliceAnsiModule.default).toBe('function');
  });
});
