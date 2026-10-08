import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Box, Text, render } from 'ink';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { installInkFrameThrottle } from './ink-frame-throttle.js';
import {
  createRowCachedGet,
  isInkOutputShape,
  type InkClip,
  type InkOutput,
  type InkOutputConstructor,
  type InkOutputFrame,
  type InkTransformer,
  type SliceAnsi,
} from './ink-output-cache.js';
import {
  cullWhenOffscreen,
  installInkRenderCull,
  type CullableElement,
} from './ink-render-cull.js';
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

  it('culls transcript rows wholly outside the viewport clip', async () => {
    const outputPath = join(inkBuildDir(), 'output.js');
    const outputModule = (await import(pathToFileURL(outputPath).href)) as {
      default: ContractInkOutputConstructor;
    };
    const Output = outputModule.default;
    const originalClip = Output.prototype.clip;
    const originalUnclip = Output.prototype.unclip;
    try {
      // The frames drawn without the cull come first: the install wraps the prototype for the rest
      // of the process, so the baseline must be drawn before it.
      const baselines = new Map<number, DrawnTranscript>();
      for (const offset of CULL_OFFSETS) {
        baselines.set(offset, await drawTranscript(Output, offset, false));
      }
      expect(
        await installInkRenderCull(),
        "Ink's private Output changed shape; update ink-render-cull.ts before VERIFIED_INK_VERSION.",
      ).toBe(true);
      for (const offset of CULL_OFFSETS) {
        const baseline = baselines.get(offset)!;
        const culled = await drawTranscript(Output, offset, true);
        expect(baseline.frame, `offset ${offset} baseline not empty`).not.toBe('');
        expect(baseline.frame.split('\n')[0], `offset ${offset} first line`).toContain(
          `row ${offset}`,
        );
        // The cull decides against the clip Output.get replays, so every culled frame is byte-identical
        // to the frame Ink draws itself.
        expect(culled.frame, `offset ${offset}`).toBe(baseline.frame);
        // The unculled walk recorded every mounted row, including the ones `get` threw away.
        expect(baseline.rowsWritten.length).toBe(CULL_ROWS);
        // The culled walk recorded only the visible rows: none outside the viewport was written.
        const expectedVisible = Array.from(
          { length: CULL_CONTENT_HEIGHT },
          (_, index) => `row ${offset + index}`,
        );
        expect(culled.rowsWritten, `offset ${offset}`).toEqual(expectedVisible);
      }
    } finally {
      Output.prototype.clip = originalClip;
      Output.prototype.unclip = originalUnclip;
    }
  });

  it('culls lines of a tall transcript row straddling the viewport clip', async () => {
    const outputPath = join(inkBuildDir(), 'output.js');
    const outputModule = (await import(pathToFileURL(outputPath).href)) as {
      default: ContractInkOutputConstructor;
    };
    const Output = outputModule.default;
    const originalClip = Output.prototype.clip;
    const originalUnclip = Output.prototype.unclip;
    try {
      const baselines = new Map<number, DrawnTranscript>();
      for (const offset of CULL_OFFSETS) {
        baselines.set(offset, await drawTallRowTranscript(Output, offset, false));
      }
      expect(
        await installInkRenderCull(),
        "Ink's private Output changed shape; update ink-render-cull.ts before VERIFIED_INK_VERSION.",
      ).toBe(true);
      for (const offset of CULL_OFFSETS) {
        const baseline = baselines.get(offset)!;
        const culled = await drawTallRowTranscript(Output, offset, true);
        expect(baseline.frame, `offset ${offset} baseline not empty`).not.toBe('');
        expect(baseline.frame.split('\n')[0], `offset ${offset} first line`).toContain(
          `line ${offset}`,
        );
        expect(culled.frame, `offset ${offset}`).toBe(baseline.frame);
        expect(baseline.rowsWritten.length).toBe(CULL_ROWS);
        const expectedVisible = Array.from(
          { length: CULL_CONTENT_HEIGHT },
          (_, index) => `line ${offset + index}`,
        );
        expect(culled.rowsWritten, `offset ${offset}`).toEqual(expectedVisible);
      }
    } finally {
      Output.prototype.clip = originalClip;
      Output.prototype.unclip = originalUnclip;
    }
  });

  it('keeps a DISPLAY_NONE node from drawing while its sibling holds its position', async () => {
    const outputPath = join(inkBuildDir(), 'output.js');
    const outputModule = (await import(pathToFileURL(outputPath).href)) as {
      default: ContractInkOutputConstructor;
    };
    const Output = outputModule.default;
    const yogaPath = createRequire(outputPath).resolve('yoga-layout');
    const yogaModule = (await import(pathToFileURL(yogaPath).href)) as {
      default?: { DISPLAY_NONE: number };
    };
    const displayNone = yogaModule.default?.DISPLAY_NONE ?? 1;

    const originalGet = Output.prototype.get;
    let lastOutput = '';
    Output.prototype.get = function (this: InkOutput) {
      const frame = originalGet.call(this);
      lastOutput = frame.output;
      return frame;
    };

    try {
      const stdout = makeStdout();
      const stdin = makeStdin();

      function App() {
        return createElement(
          Box,
          { flexDirection: 'column' },
          createElement(HiddenRow, { displayNone }, createElement(Text, null, 'hidden row')),
          createElement(Box, { height: 1 }, createElement(Text, null, 'after')),
        );
      }

      const app = render(createElement(App), {
        stdout,
        stdin,
        patchConsole: false,
        interactive: true,
        maxFps: 1000,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      lastOutput = '';
      app.rerender(createElement(App));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const frame = lastOutput;
      Output.prototype.get = originalGet;
      app.unmount();
      app.cleanup();

      const lines = frame.split('\n');
      expect(lines[0]).toBe('');
      expect(lines[1]?.startsWith('after')).toBe(true);
      expect(frame).not.toContain('hidden row');
    } finally {
      Output.prototype.get = originalGet;
    }
  });
});

interface ContractInkOutputConstructor {
  new (options: { width: number; height: number }): InkOutput;
  prototype: InkOutput & { get: (this: InkOutput) => InkOutputFrame };
}

const CULL_ROWS = 60;
const CULL_CONTENT_HEIGHT = 10;
const CULL_OFFSETS = [0, 7, 25, 50] as const;

interface DrawnTranscript {
  frame: string;
  rowsWritten: string[];
}

function makeStdout(writes?: string[]): NodeJS.WriteStream {
  return Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 24,
    isTTY: true,
    write: (data: string | Uint8Array) => {
      if (writes) writes.push(String(data));
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
}

function makeStdin(): NodeJS.ReadStream {
  return Object.assign(new PassThrough(), {
    isTTY: false,
  }) as unknown as NodeJS.ReadStream;
}

function Transcript({ offset, culled }: { offset: number; culled: boolean }): ReactNode {
  const rows: ReactNode[] = [];
  for (let index = 0; index < CULL_ROWS; index++) {
    rows.push(
      createElement(
        Box,
        {
          key: index,
          flexShrink: 0,
          ref: (node: CullableElement | null) => {
            if (node && culled) cullWhenOffscreen(node);
          },
        },
        createElement(Text, null, `row ${index}`),
      ),
    );
  }
  return createElement(
    Box,
    { height: CULL_CONTENT_HEIGHT, overflowY: 'hidden' },
    createElement(Box, { marginTop: -offset, flexDirection: 'column' }, rows),
  );
}

async function drawTranscript(
  Output: ContractInkOutputConstructor,
  offset: number,
  culled: boolean,
): Promise<DrawnTranscript> {
  const stdoutWrites: string[] = [];
  const stdout = makeStdout(stdoutWrites);
  const stdin = makeStdin();
  const recordedWrites: string[] = [];
  const originalWrite = Output.prototype.write;
  const originalGet = Output.prototype.get;
  let lastOutput = '';
  Output.prototype.write = function (
    this: InkOutput,
    x: number,
    y: number,
    text: string,
    options: { transformers: InkTransformer[] },
  ) {
    recordedWrites.push(text);
    return originalWrite.call(this, x, y, text, options);
  };
  Output.prototype.get = function (this: InkOutput) {
    const frame = originalGet.call(this);
    lastOutput = frame.output;
    return frame;
  };
  try {
    const app = render(createElement(Transcript, { offset, culled }), {
      stdout,
      stdin,
      patchConsole: false,
      interactive: true,
      maxFps: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    recordedWrites.length = 0;
    stdoutWrites.length = 0;
    lastOutput = '';
    app.rerender(createElement(Transcript, { offset, culled }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = lastOutput;
    const rowsWritten = recordedWrites.filter((text) => text.startsWith('row '));
    Output.prototype.write = originalWrite;
    Output.prototype.get = originalGet;
    app.unmount();
    app.cleanup();
    return {
      frame,
      rowsWritten,
    };
  } finally {
    Output.prototype.write = originalWrite;
    Output.prototype.get = originalGet;
  }
}

function TallRowTranscript({ offset, culled }: { offset: number; culled: boolean }): ReactNode {
  const lines: ReactNode[] = [];
  for (let index = 0; index < CULL_ROWS; index++) {
    lines.push(createElement(Text, { key: index }, `line ${index}`));
  }
  return createElement(
    Box,
    { height: CULL_CONTENT_HEIGHT, overflowY: 'hidden' },
    createElement(
      Box,
      { marginTop: -offset, flexDirection: 'column' },
      createElement(
        Box,
        {
          flexDirection: 'column',
          flexShrink: 0,
          ref: (node: CullableElement | null) => {
            if (node && culled) cullWhenOffscreen(node);
          },
        },
        lines,
      ),
    ),
  );
}

async function drawTallRowTranscript(
  Output: ContractInkOutputConstructor,
  offset: number,
  culled: boolean,
): Promise<DrawnTranscript> {
  const stdoutWrites: string[] = [];
  const stdout = makeStdout(stdoutWrites);
  const stdin = makeStdin();
  const recordedWrites: string[] = [];
  const originalWrite = Output.prototype.write;
  const originalGet = Output.prototype.get;
  let lastOutput = '';
  Output.prototype.write = function (
    this: InkOutput,
    x: number,
    y: number,
    text: string,
    options: { transformers: InkTransformer[] },
  ) {
    recordedWrites.push(text);
    return originalWrite.call(this, x, y, text, options);
  };
  Output.prototype.get = function (this: InkOutput) {
    const frame = originalGet.call(this);
    lastOutput = frame.output;
    return frame;
  };
  try {
    const app = render(createElement(TallRowTranscript, { offset, culled }), {
      stdout,
      stdin,
      patchConsole: false,
      interactive: true,
      maxFps: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    recordedWrites.length = 0;
    stdoutWrites.length = 0;
    lastOutput = '';
    app.rerender(createElement(TallRowTranscript, { offset, culled }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const frame = lastOutput;
    const rowsWritten = recordedWrites.filter((text) => text.startsWith('line '));
    Output.prototype.write = originalWrite;
    Output.prototype.get = originalGet;
    app.unmount();
    app.cleanup();
    return {
      frame,
      rowsWritten,
    };
  } finally {
    Output.prototype.write = originalWrite;
    Output.prototype.get = originalGet;
  }
}

function HiddenRow({
  displayNone,
  children,
}: {
  displayNone: number;
  children?: ReactNode;
}): ReactNode {
  return createElement(
    Box,
    {
      height: 1,
      ref: (node: { yogaNode?: { getDisplay?: () => number } } | null) => {
        if (node?.yogaNode && !Object.prototype.hasOwnProperty.call(node.yogaNode, 'getDisplay')) {
          Object.defineProperty(node.yogaNode, 'getDisplay', {
            value: () => displayNone,
            configurable: true,
          });
        }
      },
    },
    children,
  );
}

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
