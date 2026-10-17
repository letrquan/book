import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { Box, Text, render, useApp, useStdout } from 'ink';
import { createElement as h, useEffect, useState, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { replayTerminalOutput } from '../tui/terminal-screen.js';
import {
  createFrameClippedGet,
  expandTabs,
  installInkFrameClip,
  type StringWidth,
} from './ink-frame-clip.js';
import {
  createRowCachedGet,
  installInkOutputCache,
  type InkOutput,
  type InkOutputConstructor,
  type InkOutputFrame,
  type SliceAnsi,
} from './ink-output-cache.js';
import { inkBuildDir } from './ink-renderer.js';

const RED = '\u001b[31m';
const NO_COLOUR = '\u001b[39m';
const ENTER_ALT_SCREEN = '\u001b[?1049h';
const WIPE = '\u001b[H\u001b[2J';

let Output: InkOutputConstructor;
let sliceAnsi: SliceAnsi;
let stringWidth: StringWidth;
let originalGet: (this: InkOutput) => InkOutputFrame;

// These cases drive real Ink renders on timers, outside act(), as the TUI does.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
const actEnvironmentBefore = actEnvironment.IS_REACT_ACT_ENVIRONMENT;

afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = actEnvironmentBefore;
});

beforeAll(async () => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  // The modules `installInkFrameClip` reads: Ink's private output.js and the copies beside it.
  const outputPath = join(inkBuildDir(), 'output.js');
  const require = createRequire(outputPath);
  const [outputModule, sliceAnsiModule, stringWidthModule] = await Promise.all([
    import(pathToFileURL(outputPath).href),
    import(pathToFileURL(require.resolve('slice-ansi')).href),
    import(pathToFileURL(require.resolve('string-width')).href),
  ]);
  Output = outputModule.default as InkOutputConstructor;
  sliceAnsi = sliceAnsiModule.default as SliceAnsi;
  stringWidth = stringWidthModule.default as StringWidth;
  originalGet = Output.prototype.get;
});

afterEach(() => {
  // No case may leave Ink patched for the next one.
  Output.prototype.get = originalGet;
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeTerminal {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  bytes: () => string;
  resize: (columns: number, rows: number) => number;
}

/** A TTY stdout that records every byte, and resizes the way SIGWINCH does. */
function fakeTerminal(columns: number, rows: number): FakeTerminal {
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows,
    isTTY: true,
    write: (data: string | Uint8Array) => {
      writes.push(String(data));
      return true;
    },
  });
  const stdin = Object.assign(new PassThrough(), { isTTY: false });
  return {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    bytes: () => writes.join(''),
    resize: (nextColumns, nextRows) => {
      const at = writes.join('').length;
      stdout.columns = nextColumns;
      stdout.rows = nextRows;
      stdout.emit('resize');
      return at;
    },
  };
}

const INDICATOR = '* Working... (esc to interrupt)';
const PROMPT = '> ask Book anything';
const FOOTER_LEFT = '? for shortcuts';
const FOOTER_RIGHT = 'accept edits on';

/**
 * The bottom chrome the way Book lays it out during a turn, sized from React state that follows the
 * terminal 50 ms after a resize: a working indicator over an input bar between two rules, and a
 * footer, with the rules, the input bar and the footer Boxes of an explicit width. The redraw runs
 * before the new size is set, as `applyTerminalSize` in `src/tui/app.tsx` does. `onSized` hears
 * each size the chrome has committed.
 */
function Chrome({ onSized }: { onSized: (columns: number) => void }): ReactNode {
  const { stdout } = useStdout();
  const { suspendTerminal } = useApp();
  const [size, setSize] = useState({ columns: stdout.columns, rows: stdout.rows });
  useEffect(() => onSized(size.columns), [onSized, size.columns]);
  useEffect(() => {
    let timer: NodeJS.Timeout | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void suspendTerminal(() => {
          stdout.write(WIPE);
        });
        setSize({ columns: stdout.columns, rows: stdout.rows });
      }, 50);
    };
    stdout.on('resize', onResize);
    return () => {
      clearTimeout(timer);
      stdout.off('resize', onResize);
    };
  }, [stdout, suspendTerminal]);
  const rule = size.columns - 1;
  return h(
    Box,
    { flexDirection: 'column', height: size.rows },
    h(Box, { flexGrow: 1, flexDirection: 'column' }, h(Text, null, 'transcript')),
    h(Text, null, INDICATOR),
    h(Box, { width: rule }, h(Text, null, '─'.repeat(rule))),
    h(Box, { width: rule }, h(Text, null, PROMPT)),
    h(Box, { width: rule }, h(Text, null, '─'.repeat(rule))),
    h(
      Box,
      { width: size.columns, justifyContent: 'space-between' },
      h(Text, null, FOOTER_LEFT),
      h(Text, null, FOOTER_RIGHT),
    ),
  );
}

/** Renders the chrome at 80x30, narrows the terminal to 73x39, and returns the screen it leaves. */
async function resizeChrome(incrementalRendering: boolean): Promise<string[]> {
  const terminal = fakeTerminal(80, 30);
  terminal.stdout.write(ENTER_ALT_SCREEN);
  let sized: (columns: number) => void = () => {};
  const narrowed = new Promise<void>((resolve) => {
    sized = (columns) => {
      if (columns === 73) resolve();
    };
  });
  const app = render(h(Chrome, { onSized: (columns: number) => sized(columns) }), {
    stdout: terminal.stdout,
    stdin: terminal.stdin,
    patchConsole: false,
    interactive: true,
    exitOnCtrlC: false,
    incrementalRendering,
    maxFps: 1000,
  });
  try {
    await wait(50);
    const at = terminal.resize(73, 39);
    // The debounce, the redraw, and the frame at the new size: wait until the chrome has taken the
    // new size, then until the output has been quiet for a while, so a slow runner cannot read the
    // screen mid-redraw.
    await narrowed;
    for (let waited = 0, length = -1; waited < 2000; waited += 50) {
      if (terminal.bytes().length === length) break;
      length = terminal.bytes().length;
      await wait(50);
    }
    return await replayTerminalOutput(terminal.bytes(), {
      cols: 80,
      rows: 30,
      resize: { at, cols: 73, rows: 39 },
    });
  } finally {
    app.unmount();
  }
}

function expectSingleChrome(screen: string[]): void {
  const context = `screen:\n${screen.join('\n')}`;
  const count = (pattern: RegExp) => screen.filter((line) => pattern.test(line)).length;
  const indicator = screen.findIndex((line) => line.includes('Working'));
  const prompt = screen.findIndex((line) => line.includes('ask Book'));
  expect(count(/Working/), context).toBe(1);
  expect(count(/ask Book/), context).toBe(1);
  expect(count(/for shortcuts/), context).toBe(1);
  expect(count(/edits on/), context).toBe(1);
  // Exactly the two full rules of the new width, and no fragment of an old one.
  expect(count(/^─{72}$/), context).toBe(2);
  expect(count(/─/), context).toBe(2);
  expect(indicator, context).toBeLessThan(prompt);
  expect(screen.every((line) => stringWidth(line) <= 73)).toBe(true);
}

describe('frame clip on a narrowing resize (#525)', () => {
  it('confirms Output.width is the root width Ink takes from the live stdout.columns', async () => {
    const widths: number[] = [];
    Output.prototype.get = function (this: InkOutput) {
      widths.push(this.width);
      return originalGet.call(this);
    };
    const terminal = fakeTerminal(80, 10);
    const app = render(h(Box, { width: 100 }, h(Text, null, 'over-wide box')), {
      stdout: terminal.stdout,
      stdin: terminal.stdin,
      patchConsole: false,
      interactive: true,
      maxFps: 1000,
    });
    try {
      await wait(50);
      expect(widths.at(-1)).toBe(80);
      terminal.resize(73, 10);
      expect(widths.at(-1)).toBe(73);
    } finally {
      app.unmount();
    }
  });

  it('draws the chrome once after the resize with incremental rendering', async () => {
    expect(await installInkFrameClip()).toBe(true);
    expectSingleChrome(await resizeChrome(true));
  });

  it('draws the chrome once after the resize with standard rendering', async () => {
    expect(await installInkFrameClip()).toBe(true);
    expectSingleChrome(await resizeChrome(false));
  });

  it('draws the chrome once with the output cache under the clip', async () => {
    expect(await installInkOutputCache({})).toBe(true);
    expect(await installInkFrameClip()).toBe(true);
    expectSingleChrome(await resizeChrome(true));
  });
});

/** Words that, one per tab stop, take 88 columns on a terminal and 63 cells in Ink's frame. */
const TAB_ROW = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'zeta',
  'eta',
  'theta',
  'iota',
  'kappa',
  'lambda',
].join('\t');

/** The rows of a tab-separated table a Bash call printed. */
const TAB_ROWS = 3;

/**
 * A turn above the input bar and footer, one row shorter than the terminal as Book's layout is, so
 * Ink draws it incrementally. `detail` is the Ctrl+O view: the tool's tab-separated output appears
 * and the input bar's text changes in the same frame.
 */
function TabFrame({ detail }: { detail: boolean }): ReactNode {
  const rule = 72;
  const table = detail
    ? Array.from({ length: TAB_ROWS }, (_, index) => h(Text, { key: index }, TAB_ROW))
    : [];
  return h(
    Box,
    { flexDirection: 'column', height: 38 },
    h(Box, { flexGrow: 1, flexDirection: 'column' }, h(Text, null, 'output'), ...table),
    h(Box, { width: rule }, h(Text, null, '─'.repeat(rule))),
    h(
      Box,
      { width: rule },
      h(Text, null, detail ? '> Esc closes this' : '> Type a follow-up; Enter queues it'),
    ),
    h(Box, { width: rule }, h(Text, null, '─'.repeat(rule))),
    h(Text, null, FOOTER_LEFT),
  );
}

/** Draws the turn at 73x39, opens its detail view, and returns the screen. */
async function drawTabFrame(): Promise<string[]> {
  const terminal = fakeTerminal(73, 39);
  terminal.stdout.write(ENTER_ALT_SCREEN);
  const app = render(h(TabFrame, { detail: false }), {
    stdout: terminal.stdout,
    stdin: terminal.stdin,
    patchConsole: false,
    interactive: true,
    exitOnCtrlC: false,
    incrementalRendering: true,
    maxFps: 1000,
  });
  try {
    await wait(50);
    app.rerender(h(TabFrame, { detail: true }));
    for (let waited = 0, length = -1; waited < 2000; waited += 50) {
      await wait(50);
      if (terminal.bytes().length === length) break;
      length = terminal.bytes().length;
    }
    return await replayTerminalOutput(terminal.bytes(), { cols: 73, rows: 39 });
  } finally {
    app.unmount();
  }
}

describe('frame clip on a tab row (#525)', () => {
  it('keeps one input bar and one footer when a tab row passes the width', async () => {
    expect(await installInkFrameClip()).toBe(true);
    const screen = await drawTabFrame();
    const context = `screen:\n${screen.join('\n')}`;
    const count = (pattern: RegExp) => screen.filter((line) => pattern.test(line)).length;
    expect(count(/^> /), context).toBe(1);
    expect(count(/Esc closes this/), context).toBe(1);
    expect(count(/for shortcuts/), context).toBe(1);
    expect(count(/^─{72}$/), context).toBe(2);
    // Each tab row stops at the terminal's last column instead of wrapping onto the next row.
    expect(
      count(/^alpha {3}beta {4}gamma {3}delta {3}epsilon zeta {4}eta {5}theta {3}iota {4}k$/),
      context,
    ).toBe(TAB_ROWS);
    expect(count(/lambda/), context).toBe(0);
  });
});

describe('frame-clipped Ink output', () => {
  function clipped(get: (this: InkOutput) => InkOutputFrame = originalGet) {
    return createFrameClippedGet({ get, sliceAnsi, stringWidth });
  }

  function make(width: number, height: number, writes: [number, number, string][]): InkOutput {
    const output = new Output({ width, height });
    for (const [x, y, text] of writes) output.write(x, y, text, { transformers: [] });
    return output;
  }

  it('cuts a row wider than the width to exactly the width', () => {
    const output = make(10, 2, [
      [0, 0, 'a'.repeat(16)],
      [3, 1, 'b'.repeat(9)],
    ]);
    const rows = clipped().call(output).output.split('\n');
    expect(rows).toEqual(['a'.repeat(10), `   ${'b'.repeat(7)}`]);
  });

  it('keeps the height Ink reports', () => {
    const output = make(4, 3, [[0, 0, 'abcdefgh']]);
    expect(clipped().call(output)).toEqual({ output: 'abcd\n\n', height: 3 });
  });

  it('never splits a wide character at the boundary', () => {
    const output = make(5, 2, [
      [0, 0, 'ab你好世'],
      [0, 1, 'abcd👍z'],
    ]);
    const rows = clipped().call(output).output.split('\n');
    expect(rows).toEqual(['ab你', 'abcd']);
    for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(5);
  });

  it('skips the width lookup only for writes that fit even at two cells per code unit', () => {
    const output = make(8, 2, [
      [0, 0, '你好世界'],
      [0, 1, '你好世界你'],
    ]);
    const looked: string[] = [];
    const getWidestLine = output.caches.getWidestLine.bind(output.caches);
    output.caches.getWidestLine = (text) => {
      looked.push(text);
      return getWidestLine(text);
    };
    const rows = clipped().call(output).output.split('\n');
    expect(rows).toEqual(['你好世界', '你好世界']);
    expect(looked).toEqual(['你好世界你']);
  });

  it('keeps ANSI styling and closes it at the cut', () => {
    const output = make(4, 1, [[0, 0, `${RED}abcdefgh${NO_COLOUR}`]]);
    const row = clipped().call(output).output;
    expect(row).toBe(`${RED}abcd${NO_COLOUR}`);
  });

  it('returns rows within the width byte-identical to the wrapped get', () => {
    const writes: [number, number, string][] = [
      [0, 0, `${RED}red${NO_COLOUR} plain`],
      [2, 1, '你好'],
      [0, 2, 'exactly ten'.slice(0, 10)],
    ];
    const expected = originalGet.call(make(10, 3, writes));
    expect(clipped().call(make(10, 3, writes))).toEqual(expected);
  });

  it('cuts only the over-wide rows of a frame that has one', () => {
    const writes: [number, number, string][] = [
      [0, 0, `${RED}kept${NO_COLOUR}`],
      [0, 1, 'x'.repeat(12)],
      [1, 2, '你好'],
    ];
    const expected = originalGet.call(make(8, 3, writes)).output.split('\n');
    const rows = clipped()
      .call(make(8, 3, writes))
      .output.split('\n');
    expect(rows).toEqual([expected[0], 'x'.repeat(8), expected[2]]);
  });

  /**
   * A clip over Ink's own get that records what the clip asks the Output's width caches, starting
   * once Ink's get has built the frame, since Ink measures every character itself.
   */
  function recordingClip() {
    const looked: string[] = [];
    const measured: string[] = [];
    const get = createFrameClippedGet({
      get(this: InkOutput) {
        const built = originalGet.call(this);
        const { caches } = this;
        const getWidestLine = caches.getWidestLine.bind(caches);
        const getStringWidth = caches.getStringWidth.bind(caches);
        caches.getWidestLine = (text) => {
          looked.push(text);
          return getWidestLine(text);
        };
        caches.getStringWidth = (text) => {
          measured.push(text);
          return getStringWidth(text);
        };
        return built;
      },
      sliceAnsi,
      stringWidth,
    });
    return { get, looked, measured };
  }

  it('measures no row when no write reaches past the width', () => {
    const fits = recordingClip();
    fits.get.call(
      make(10, 3, [
        [0, 0, 'abc'],
        [7, 1, 'xyz'],
      ]),
    );
    // The write's own width lookup, which measures its text, and no row.
    expect(fits.looked).toEqual(['xyz']);
    expect(fits.measured).toEqual(['xyz']);
    const overflows = recordingClip();
    overflows.get.call(
      make(10, 3, [
        [0, 0, 'abc'],
        [8, 1, 'xyz'],
      ]),
    );
    // Only the row the over-wide write covers, through the Output's own width cache.
    expect(overflows.looked).toEqual(['xyz']);
    expect(overflows.measured).toEqual(['xyz', '        xyz']);
  });

  it('flags nothing for an over-wide write that a clip ending within the width cuts', () => {
    const clippedWrite = () => {
      const output = new Output({ width: 10, height: 1 });
      output.clip({ x1: 0, x2: 8 });
      output.write(0, 0, 'x'.repeat(20), { transformers: [] });
      output.unclip();
      return output;
    };
    const expected = originalGet.call(clippedWrite());
    const recording = recordingClip();
    expect(recording.get.call(clippedWrite())).toEqual(expected);
    expect(recording.looked).toEqual([]);
    expect(recording.measured).toEqual([]);
  });

  it('still flags a tab write inside a clip that ends within the width', () => {
    const output = new Output({ width: 10, height: 1 });
    output.clip({ x1: 0, x2: 8 });
    // Ink's clip measures the tab as no cells and keeps all eight letters.
    output.write(0, 0, 'ab\tcdefgh', { transformers: [] });
    output.unclip();
    expect(clipped().call(output).output).toBe('ab      cd');
  });

  it('falls back to string-width when the Output has no width cache', () => {
    const output = make(20, 1, [[0, 0, 'a\tb']]);
    const measured: string[] = [];
    const get = createFrameClippedGet({
      get(this: InkOutput) {
        // Ink's own get needs the cache; take it away once the frame is built.
        const built = originalGet.call(this);
        Object.assign(this.caches, { getStringWidth: undefined });
        return built;
      },
      sliceAnsi,
      stringWidth: (text) => {
        measured.push(text);
        return stringWidth(text);
      },
    });
    expect(get.call(output).output).toBe('a       b');
    expect(measured).toContain('a       b');
  });

  it('checks every row when a transformer newline shifts the rows past the grid', () => {
    const output = new Output({ width: 8, height: 2 });
    output.write(0, 0, 'a', { transformers: [() => 'a\nb'] });
    output.write(0, 1, 'x'.repeat(12), { transformers: [] });
    // Ink keeps the transformer's newline on grid row 0, so the frame splits into three rows.
    expect(originalGet.call(output).output).toBe(`a\nb\n${'x'.repeat(12)}`);
    expect(clipped().call(output)).toEqual({ output: `a\nb\n${'x'.repeat(8)}`, height: 2 });
  });

  it('expands tabs to the next multiple-of-8 column', () => {
    expect(expandTabs('a\tb', stringWidth)).toBe(`a${' '.repeat(7)}b`);
    expect(expandTabs('abcdefg\tb', stringWidth)).toBe('abcdefg b');
    expect(expandTabs('abcdefgh\tb', stringWidth)).toBe(`abcdefgh${' '.repeat(8)}b`);
    expect(expandTabs('a\t\tb', stringWidth)).toBe(`a${' '.repeat(15)}b`);
    expect(expandTabs('你\tb', stringWidth)).toBe(`你${' '.repeat(6)}b`);
    expect(expandTabs('no tab', stringWidth)).toBe('no tab');
  });

  it('expands a tab after styled text by its visible column', () => {
    expect(expandTabs(`${RED}red${NO_COLOUR}\tx`, stringWidth)).toBe(
      `${RED}red${NO_COLOUR}${' '.repeat(5)}x`,
    );
  });

  it('expands tabs from column 0 of the row, not of the write', () => {
    expect(clipped().call(make(20, 1, [[3, 0, 'a\tb']])).output).toBe(`   a${' '.repeat(4)}b`);
  });

  it('cuts a row that only passes the width once its tabs are expanded', () => {
    const output = make(12, 1, [[0, 0, 'ab\tcd\tef']]);
    // Ink gives each tab one cell, so its row fits; the terminal's would not.
    expect(originalGet.call(output).output).toBe('ab\tcd\tef');
    expect(clipped().call(output).output).toBe(`ab${' '.repeat(6)}cd`);
  });

  it('leaves the tab-free rows of a frame with a tab row byte-identical', () => {
    const writes: [number, number, string][] = [
      [0, 0, `${RED}kept${NO_COLOUR} 你好`],
      [0, 1, 'a\tb'],
      [2, 2, 'plain'],
    ];
    const expected = originalGet.call(make(20, 3, writes)).output.split('\n');
    const rows = clipped()
      .call(make(20, 3, writes))
      .output.split('\n');
    expect(rows).toEqual([expected[0], `a${' '.repeat(7)}b`, expected[2]]);
  });

  it('clips the row-cached get, cold and warm', () => {
    const rowCache = createRowCachedGet({ originalGet, sliceAnsi, Output });
    const get = clipped(rowCache.get);
    const writes: [number, number, string][] = [
      [0, 0, 'short'],
      [0, 1, '─'.repeat(15)],
    ];
    for (let pass = 0; pass < 2; pass++) {
      expect(get.call(make(10, 2, writes)).output, `pass ${pass + 1}`).toBe(
        `short\n${'─'.repeat(10)}`,
      );
    }
  });

  it('installs once, and a second install is a no-op', async () => {
    expect(await installInkFrameClip()).toBe(true);
    const installed = Output.prototype.get;
    expect(installed).not.toBe(originalGet);
    expect(await installInkFrameClip()).toBe(true);
    expect(Output.prototype.get).toBe(installed);
    expect(Output.prototype.get.call(make(3, 1, [[0, 0, 'abcdef']])).output).toBe('abc');
  });

  it('works with the output cache off', async () => {
    expect(await installInkOutputCache({ BOOK_INK_OUTPUT_CACHE: 'off' })).toBe(false);
    expect(await installInkFrameClip()).toBe(true);
    expect(Output.prototype.get.call(make(3, 1, [[0, 0, 'abcdef']])).output).toBe('abc');
  });

  it('keeps one layer of each when the cache and the clip are installed twice', async () => {
    let calls = 0;
    Output.prototype.get = function (this: InkOutput) {
      calls++;
      return originalGet.call(this);
    };
    expect(await installInkOutputCache({})).toBe(true);
    expect(await installInkFrameClip()).toBe(true);
    const installed = Output.prototype.get;
    // The clipped get carries the cache's mark, so neither installer wraps again.
    expect(await installInkOutputCache({})).toBe(true);
    expect(await installInkFrameClip()).toBe(true);
    expect(Output.prototype.get).toBe(installed);
    expect(Output.prototype.get.call(make(3, 2, [[0, 1, 'abcdef']])).output).toBe('\nabc');
    expect(calls).toBe(1);
  });

  it('works over the output cache when it is installed first', async () => {
    expect(await installInkOutputCache({})).toBe(true);
    const cached = Output.prototype.get;
    expect(await installInkFrameClip()).toBe(true);
    expect(Output.prototype.get).not.toBe(cached);
    for (let pass = 0; pass < 2; pass++) {
      expect(Output.prototype.get.call(make(3, 2, [[0, 1, 'abcdef']])).output).toBe('\nabc');
    }
  });
});
