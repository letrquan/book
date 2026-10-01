import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Text, render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { installInkFrameThrottle } from './ink-frame-throttle.js';
import {
  createRowCachedGet,
  isInkOutputShape,
  type InkClip,
  type InkOutput,
  type InkOutputConstructor,
  type InkTransformer,
  type SliceAnsi,
} from './ink-output-cache.js';
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

  it("draws what Ink's own get draws", async () => {
    // The shape check above only proves the module still has the parts the row cache reads. An Ink
    // upgrade could keep that shape, fix the dropped-row quirk, or change a clip comparison, and the
    // TUI would quietly follow it. So the same fixed operation lists go through both, twice each,
    // which is what makes the second pass a cache hit.
    const outputPath = join(inkBuildDir(), 'output.js');
    const sliceAnsiPath = createRequire(outputPath).resolve('slice-ansi');
    const [outputModule, sliceAnsiModule] = await Promise.all([
      import(pathToFileURL(outputPath).href),
      import(pathToFileURL(sliceAnsiPath).href),
    ]);
    const Output = outputModule.default as InkOutputConstructor;
    const originalGet = Output.prototype.get;
    const rowCache = createRowCachedGet({
      originalGet,
      sliceAnsi: sliceAnsiModule.default as SliceAnsi,
      Output,
    });
    for (const list of OPERATION_LISTS) {
      // A fresh instance each time: the cache shares its maps across instances, not across runs.
      const expected = originalGet.call(record(Output, list));
      for (let pass = 0; pass < 2; pass++) {
        expect(rowCache.get.call(record(Output, list)), `${list.name}, pass ${pass + 1}`).toEqual(
          expected,
        );
      }
    }
  });
});

/** The operations a list asks for, recorded through Ink's own methods on a fresh instance. */
type Command =
  | { kind: 'write'; x: number; y: number; text: string; transformers?: InkTransformer[] }
  | { kind: 'clip'; clip: InkClip }
  | { kind: 'unclip' };

interface OperationList {
  name: string;
  width: number;
  height: number;
  commands: Command[];
}

const RED = '\u001b[31m';
const NO_COLOUR = '\u001b[39m';

const OPERATION_LISTS: OperationList[] = [
  {
    name: 'a plain write',
    width: 20,
    height: 4,
    commands: [{ kind: 'write', x: 0, y: 0, text: 'plain' }],
  },
  {
    name: 'an SGR-styled write',
    width: 20,
    height: 4,
    commands: [{ kind: 'write', x: 0, y: 1, text: `${RED}red${NO_COLOUR} plain` }],
  },
  {
    name: 'a wide character',
    width: 20,
    height: 4,
    commands: [
      { kind: 'write', x: 0, y: 0, text: '你好世界' },
      { kind: 'write', x: 0, y: 1, text: 'a👍b' },
    ],
  },
  {
    name: 'a nested clip that is partly outside',
    width: 24,
    height: 5,
    commands: [
      { kind: 'clip', clip: { x1: 4, x2: 12, y1: 1, y2: 3 } },
      { kind: 'write', x: 0, y: 2, text: 'abcdefghijklmnop' },
      { kind: 'clip', clip: { x1: 6, x2: 8, y1: 2, y2: 3 } },
      { kind: 'write', x: 0, y: 2, text: 'ABCDEFGH' },
      { kind: 'unclip' },
      { kind: 'unclip' },
    ],
  },
  {
    name: 'a write above row zero with no clip',
    width: 12,
    height: 4,
    commands: [{ kind: 'write', x: 0, y: -1, text: 'a\nb\nc' }],
  },
  {
    name: 'a write past the last row',
    width: 12,
    height: 4,
    commands: [{ kind: 'write', x: 0, y: 2, text: 'a\nb\nc\nd\ne' }],
  },
  {
    name: 'a transformer that uses the line index',
    width: 12,
    height: 5,
    commands: [
      {
        kind: 'write',
        x: 0,
        y: 0,
        text: 'a\nb\nc',
        transformers: [(line, index) => `${index}:${line}`],
      },
    ],
  },
];

function record(Output: InkOutputConstructor, list: OperationList): InkOutput {
  const output = new Output({ width: list.width, height: list.height });
  for (const command of list.commands) {
    if (command.kind === 'write') {
      output.write(command.x, command.y, command.text, {
        transformers: command.transformers ?? [],
      });
    } else if (command.kind === 'clip') {
      output.clip(command.clip);
    } else {
      output.unclip();
    }
  }
  return output;
}
