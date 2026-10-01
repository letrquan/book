import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createRowCachedGet,
  installInkOutputCache,
  type InkClip,
  type InkOutput,
  type InkOutputConstructor,
  type InkOutputFrame,
  type InkTransformer,
  type OutputCacheStats,
  type RowCacheLimits,
  type RowCachedGet,
  type SliceAnsi,
} from './ink-output-cache.js';
import { inkBuildDir } from './ink-renderer.js';

const RED = '\u001b[31m';
const BOLD = '\u001b[1m';
const NO_COLOUR = '\u001b[39m';
const NO_BOLD = '\u001b[22m';

let Output: InkOutputConstructor;
let sliceAnsi: SliceAnsi;
let originalGet: (this: InkOutput) => InkOutputFrame;

beforeAll(async () => {
  // The same two modules `installInkOutputCache` reads: Ink's private output.js, and the
  // slice-ansi beside it rather than the one a dependency hoisted to the top of node_modules.
  const outputPath = join(inkBuildDir(), 'output.js');
  const sliceAnsiPath = createRequire(outputPath).resolve('slice-ansi');
  const [outputModule, sliceAnsiModule] = await Promise.all([
    import(pathToFileURL(outputPath).href),
    import(pathToFileURL(sliceAnsiPath).href),
  ]);
  Output = outputModule.default as InkOutputConstructor;
  sliceAnsi = sliceAnsiModule.default as SliceAnsi;
  originalGet = Output.prototype.get;
});

/** The operations a case asks for, recorded through Ink's own methods. */
type Command =
  | { kind: 'write'; x: number; y: number; text: string; transformers?: InkTransformer[] }
  | { kind: 'clip'; clip: InkClip }
  | { kind: 'unclip' };

function make(width: number, height: number, commands: Command[]): InkOutput {
  const output = new Output({ width, height });
  for (const command of commands) {
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

describe('row-cached Ink output', () => {
  function cache(limits?: Partial<RowCacheLimits>): RowCachedGet {
    return createRowCachedGet({ originalGet, sliceAnsi, Output, limits });
  }

  /** Renders the same operations through Ink and through the cache, and holds them to each other. */
  function agree(
    width: number,
    height: number,
    commands: Command[],
    rowCache: RowCachedGet,
  ): InkOutputFrame {
    const expected = originalGet.call(make(width, height, commands));
    const actual = rowCache.get.call(make(width, height, commands));
    expect(actual).toEqual(expected);
    return actual;
  }

  it('draws plain lines where Ink draws them', () => {
    const frame = agree(
      20,
      5,
      [
        { kind: 'write', x: 0, y: 0, text: 'first row' },
        { kind: 'write', x: 4, y: 1, text: 'second row' },
        { kind: 'write', x: 2, y: 3, text: 'third row' },
      ],
      cache(),
    );
    expect(frame.output).toBe('first row\n    second row\n\n  third row\n');
    expect(frame.height).toBe(5);
  });

  it('keeps SGR colour and bold, including a style that spans a newline', () => {
    const frame = agree(
      24,
      5,
      [
        { kind: 'write', x: 0, y: 0, text: `${RED}red${NO_COLOUR} plain` },
        { kind: 'write', x: 0, y: 1, text: `${BOLD}bold${NO_BOLD} tail` },
        { kind: 'write', x: 0, y: 2, text: `${RED}opens here\nand carries on${NO_COLOUR}` },
      ],
      cache(),
    );
    const rows = frame.output.split('\n');
    expect(rows[0]).toContain(RED);
    expect(rows[0]).toContain('red');
    expect(rows[1]).toContain(BOLD);
    expect(rows[2]).toContain('opens here');
    expect(rows[3]).toContain('and carries on');
  });

  it('measures wide characters, and cleans up a write that lands inside one', () => {
    const frame = agree(
      20,
      4,
      [
        { kind: 'write', x: 0, y: 0, text: '你好世界' },
        { kind: 'write', x: 0, y: 1, text: 'a👍b' },
        // The second cell of the emoji: Ink blanks the emoji and writes over the placeholder.
        { kind: 'write', x: 2, y: 1, text: 'X' },
        { kind: 'write', x: 0, y: 2, text: '漢字 emoji 🎉 tail' },
      ],
      cache(),
    );
    const rows = frame.output.split('\n');
    expect(rows[0]).toBe('你好世界');
    expect(rows[1]).toBe('a Xb');
    expect(rows[2]).toBe('漢字 emoji 🎉 tail');
  });

  it('clips horizontally and vertically, inside and out, and nests', () => {
    const frame = agree(
      24,
      6,
      [
        { kind: 'clip', clip: { x1: 4, x2: 10, y1: 1, y2: 3 } },
        // Negative x and y relative to the clip, and a line the vertical slice drops whole.
        { kind: 'write', x: -2, y: -1, text: 'first\nsecond\nthird' },
        { kind: 'write', x: 2, y: 0, text: 'abcdefghijkl' },
        // Wholly outside the clip on each axis.
        { kind: 'write', x: 30, y: 1, text: 'off to the right' },
        { kind: 'write', x: 0, y: 5, text: 'a\nb\nc' },
        // Partly inside: sliced to columns 4..9 of the line.
        { kind: 'write', x: 0, y: 2, text: 'abcdefghijklmnop' },
        { kind: 'unclip' },
        { kind: 'write', x: 0, y: 0, text: 'unclipped' },
      ],
      cache(),
    );
    const rows = frame.output.split('\n');
    expect(rows[0]).toBe('unclipped');
    expect(rows[2]).toBe('    efghij');
  });

  it('clips inside a nested clip', () => {
    const frame = agree(
      24,
      4,
      [
        { kind: 'clip', clip: { x1: 4, x2: 10, y1: 1, y2: 3 } },
        { kind: 'write', x: 0, y: 2, text: 'abcdefghijklmnop' },
        { kind: 'clip', clip: { x1: 6, x2: 8, y1: 2, y2: 3 } },
        { kind: 'write', x: 0, y: 2, text: 'ABCDEFGH' },
        { kind: 'unclip' },
        { kind: 'unclip' },
      ],
      cache(),
    );
    expect(frame.output.split('\n')[2]).toBe('    efGHij');
  });

  it('drops a write below row zero with no clip, and every line of it', () => {
    const frame = agree(
      12,
      4,
      [
        { kind: 'write', x: 0, y: -1, text: 'gone' },
        { kind: 'write', x: 0, y: -1, text: 'a\nb\nc' },
      ],
      cache(),
    );
    // Ink advances the row offset only when the row exists, so a write starting above the first
    // row drops all of its lines rather than landing them one row low.
    expect(frame.output).toBe('\n\n\n');
  });

  it('drops the lines of a write that run past the last row', () => {
    const frame = agree(12, 5, [{ kind: 'write', x: 0, y: 3, text: 'a\nb\nc\nd\ne' }], cache());
    expect(frame.output).toBe('\n\n\na\nb');
  });

  it('applies transformers with each line its own index', () => {
    const frame = agree(
      12,
      5,
      [
        {
          kind: 'write',
          x: 0,
          y: 0,
          text: 'a\nb\nc',
          transformers: [(line, index) => `${index}:${line}`],
        },
        {
          kind: 'write',
          x: 0,
          y: 3,
          text: 'wide',
          transformers: [(line) => line.toUpperCase(), (line, index) => `[${index}]${line}`],
        },
      ],
      cache(),
    );
    const rows = frame.output.split('\n');
    expect(rows[0]).toBe('0:a');
    expect(rows[2]).toBe('2:c');
    expect(rows[3]).toBe('[0]WIDE');
  });

  it('leaves the empty lines of a multi-line write empty', () => {
    const frame = agree(12, 4, [{ kind: 'write', x: 0, y: 0, text: 'first\n\nthird' }], cache());
    expect(frame.output).toBe('first\n\nthird\n');
  });

  it('matches Ink across a seeded sweep of operation lists', () => {
    const rowCache = cache();
    const random = createRandom(20261001);
    for (let frame = 0; frame < 320; frame++) {
      const width = 4 + Math.floor(random() * 30);
      const height = 1 + Math.floor(random() * 8);
      agree(width, height, randomCommands(random), rowCache);
    }
  });

  it('serves a repeated frame out of the cache', () => {
    const rowCache = cache();
    const commands = rowsFrom(6, 0);
    agree(20, 6, commands, rowCache);
    const first = rowCache.stats();
    expect(first).toEqual({ frames: 1, rows: 6, rowHits: 0 });

    const frame = agree(20, 6, commands, rowCache);
    const second = rowCache.stats();
    expect(second.frames).toBe(2);
    expect(second.rows - first.rows).toBe(6);
    expect(second.rowHits - first.rowHits).toBe(6);
    // Every row of the second frame came out of the cache: none was built again.
    expect(missesIn(second) - missesIn(first)).toBe(0);
    expect(frame.output.split('\n')[0]).toBe('     row0');
  });

  it('serves rows that moved up or down a few rows', () => {
    const rowCache = cache();
    agree(20, 12, rowsFrom(9, 0), rowCache);
    const first = rowCache.stats();
    const frame = agree(20, 12, rowsFrom(9, 3), rowCache);
    const second = rowCache.stats();
    expect(second.rowHits - first.rowHits).toBe(12);
    expect(missesIn(second) - missesIn(first)).toBe(0);
    expect(frame.output.split('\n')[0]).toBe('');
    expect(frame.output.split('\n')[5]).toBe('     row2');
  });

  it('never serves a row that was built at another width', () => {
    const rowCache = cache();
    // Written past the narrower row's last column, so the row string carries that row's width.
    const commands: Command[] = [{ kind: 'write', x: 35, y: 0, text: 'ab' }];
    const wide = agree(40, 2, commands, rowCache);
    expect(wide.output.split('\n')[0]).toBe(`${' '.repeat(35)}ab`);
    const first = rowCache.stats();

    const narrow = agree(30, 2, commands, rowCache);
    const second = rowCache.stats();
    expect(narrow.output.split('\n')[0]).toBe(`${' '.repeat(30)}ab`);
    expect(missesIn(second) - missesIn(first)).toBe(1);
    expect(second.rowHits - first.rowHits).toBe(1);
  });

  it('never serves a row that grew or shrank', () => {
    const rowCache = cache();
    const row = (text: string): string =>
      agree(30, 3, [{ kind: 'write', x: 2, y: 1, text }], rowCache).output.split('\n')[1] ?? '';
    expect(row('Hel')).toBe('  Hel');
    expect(row('Hello')).toBe('  Hello');
    expect(row('Hello world')).toBe('  Hello world');
    // A prefix of a cached line must not bring the longer cached row back.
    expect(row('Hi')).toBe('  Hi');
  });

  it('keeps the frame exact when the caches are turned over constantly', () => {
    const rowCache = cache({ rowCache: 2, styledChars: 2, sliceCache: 2 });
    const random = createRandom(4242);
    for (let frame = 0; frame < 60; frame++) {
      agree(12, 6, randomCommands(random), rowCache);
    }
    const stats = rowCache.stats();
    expect(stats.frames).toBe(60);
    expect(missesIn(stats)).toBeGreaterThan(0);
  });

  it('stays off when BOOK_INK_OUTPUT_CACHE turns it off', async () => {
    expect(await installInkOutputCache({ BOOK_INK_OUTPUT_CACHE: 'off' })).toBe(false);
    expect(await installInkOutputCache({ BOOK_INK_OUTPUT_CACHE: '0' })).toBe(false);
  });
});

/** How many rows were ever built rather than served from the cache. */
function missesIn(stats: OutputCacheStats): number {
  return stats.rows - stats.rowHits;
}

/** `count` rows of `row0`, `row1`, ... written at `start` and below. */
function rowsFrom(count: number, start: number): Command[] {
  const commands: Command[] = [];
  for (let index = 0; index < count; index++) {
    commands.push({ kind: 'write', x: 5, y: start + index, text: `row${index}` });
  }
  return commands;
}

const TEXTS = [
  'plain',
  'x',
  'first\nsecond\nthird',
  'a\n\nb',
  'trailing   ',
  `${RED}red${NO_COLOUR}`,
  `${BOLD}bold and red${RED}\ncarries on${NO_COLOUR}${NO_BOLD}`,
  '你好世界',
  'a👍b',
  '漢字 emoji 🎉 tail',
  `${RED}cyan 你好 world${NO_COLOUR}`,
];

const TRANSFORMERS: InkTransformer[][] = [
  [],
  [(line) => line.toUpperCase()],
  [(line, index) => `${index}${line}`],
  [(_line, index) => `>${index}`, (line) => `<${line}>`],
];

/** A small LCG, so the sweep is the same operations on every run and every machine. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function randomClip(random: () => number): InkClip {
  const x1 = Math.floor(random() * 12) - 3;
  const y1 = Math.floor(random() * 8) - 2;
  const x2 = x1 + 1 + Math.floor(random() * 14);
  const y2 = y1 + 1 + Math.floor(random() * 8);
  const shape = random();
  if (shape < 0.25) return { x1, x2 };
  if (shape < 0.5) return { y1, y2 };
  return { x1, x2, y1, y2 };
}

function randomCommands(random: () => number): Command[] {
  const commands: Command[] = [];
  const count = 1 + Math.floor(random() * 8);
  for (let index = 0; index < count; index++) {
    const roll = random();
    if (roll < 0.15) {
      commands.push({ kind: 'clip', clip: randomClip(random) });
    } else if (roll < 0.25) {
      commands.push({ kind: 'unclip' });
    } else {
      commands.push({
        kind: 'write',
        x: Math.floor(random() * 14) - 3,
        y: Math.floor(random() * 10) - 2,
        text: pick(random, TEXTS),
        transformers: pick(random, TRANSFORMERS),
      });
    }
  }
  return commands;
}
