import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isInkOutputShape,
  type InkClip,
  type InkOutput,
  type InkOutputConstructor,
  type InkOutputFrame,
  type SliceAnsi,
} from './ink-output-cache.js';
import { parseEnvBoolean } from '../env-boolean.js';
import { inkBuildDir } from './ink-renderer.js';

/**
 * Keeps every row of Ink's frame within the terminal's width (#525).
 *
 * Ink's private `Output.get` builds each row from a grid `this.width` cells wide, but a write that
 * runs past the last cell grows the row instead of being cut, so a frame row can come out wider
 * than the terminal. The terminal autowraps each over-wide row onto a second physical row, so
 * log-update's idea of how tall its frame is falls short by one row per wrap, and its next
 * incremental frame moves the cursor up into the middle of the old one. The rows it thinks
 * unchanged — blank rows, rules, the input bar — are skipped, and the stale wrapped rows stay: two
 * working indicators, extra rules, a rule fragment, a second input bar.
 *
 * Every narrowing resize used to do that for 50 ms: Ink's `resized()` lays the root out at the new
 * `stdout.columns` and draws at once, while Book's components held the old width in React state
 * until a debounce ran, and the input bar's rules and footer are Boxes with that width set
 * explicitly. Since #538 the TUI commits the new size from a `resize` listener that runs before
 * `resized()`, so no frame laid out at the old width should reach Ink any more; the clip stays as a
 * safety net for any row that still would. `BOOK_INK_FRAME_CLIP=off` turns it off, so a run can show
 * that no row comes out wider than the terminal without it.
 *
 * Cutting the rows at `Output.get` covers both renderer modes and every way Ink writes a frame
 * (incremental, standard, and the clear-terminal branch), because all of them write what `get`
 * returns. `this.width` is the root's computed width, which Ink sets from the live
 * `stdout.columns` in `calculateLayout` before every resized frame.
 *
 * Tabs are the other way a row passes the width without a resize. `string-width`, and so Ink's
 * layout and its `getWidestLine`, count a tab as no cells (Ink's grid gives it one), while the
 * terminal moves to the next multiple-of-8 column. A tab-separated table in a tool's output therefore
 * fits in Ink's frame and still autowraps on screen, with the same desync. A row that holds a tab has
 * every tab replaced by spaces up to the next multiple-of-8 visible column, counted ANSI-aware from
 * column 0 of the row, before it is measured and cut; the spaces also overwrite the cells a terminal
 * tab would jump over and leave stale.
 *
 * Rows are not measured unless a write could put them past the width. A write reaches no further
 * than its `x` plus its widest line, by Ink's `getWidestLine`: a write whose text holds no tab is
 * skipped when that stays inside `this.width`, when it is short enough that even two cells per code
 * unit stays inside, or when Ink's own clip already cuts it at an edge inside the width. That rests
 * on transformers adding styling only, which is all Text's transformer does; Book renders no
 * `<Transform>` that adds width. Only the rows a remaining write covers — a tab write, or one that
 * reaches past the width — are measured, and only the ones that really are too wide are cut, with
 * Ink's `slice-ansi`, which keeps styles closed and never splits a wide character (a row cut beside
 * one may come out a cell short). Rows are measured with the `Output`'s own `getStringWidth`, shared
 * across frames while the row cache is on, falling back to Ink's `string-width`.
 *
 * With the row cache on, the widths the check reads are mostly cache hits. With
 * `BOOK_INK_OUTPUT_CACHE=off` every `Output` has fresh caches, so `getWidestLine` measures each
 * long enough write anew on every frame.
 *
 * `installInkFrameClip` wraps whichever `get` is installed — Ink's own or the row-cached one from
 * `ink-output-cache.ts` — so it is independent of `BOOK_INK_OUTPUT_CACHE` and
 * `BOOK_INK_RENDER_CULL`, and has to be installed after the cache. `ink-renderer.contract.test.ts`
 * pins the parts of `Output` it reads.
 */

/** `string-width`, resolved from Ink's own location so it is the copy Ink measures with. */
export type StringWidth = (text: string) => number;

export interface FrameClippedGetOptions {
  /** The `get` being wrapped: Ink's own, or one already wrapping it. */
  get: (this: InkOutput) => InkOutputFrame;
  sliceAnsi: SliceAnsi;
  stringWidth: StringWidth;
}

/** Set on the installed `get` itself, as the output cache marks its own. */
const INSTALLED_MARK = Symbol('book.inkFrameClip');

/** The terminal's tab stops: every eighth column. */
const TAB_STOP = 8;

/**
 * Replaces every tab with spaces up to the next tab stop, as the terminal would move the cursor,
 * counting visible columns from the start of the row. `measure` skips ANSI escapes.
 */
export function expandTabs(row: string, measure: StringWidth): string {
  const parts = row.split('\t');
  let expanded = parts[0] ?? '';
  let column = measure(expanded);
  for (let index = 1; index < parts.length; index++) {
    const part = parts[index] ?? '';
    const pad = TAB_STOP - (column % TAB_STOP);
    expanded += ' '.repeat(pad) + part;
    column += pad + measure(part);
  }
  return expanded;
}

/** Whether Ink's own clip cuts writes horizontally at an edge inside the width. */
function clipsWithinWidth(clip: InkClip | undefined, width: number): boolean {
  return typeof clip?.x1 === 'number' && typeof clip.x2 === 'number' && clip.x2 <= width;
}

/**
 * The rows a write could put past the width covers, or null when no write could. A write covers at
 * most the rows from its `y` down by its line count: a vertical clip only moves it down and drops
 * lines.
 */
function rowsPastWidth(output: InkOutput): boolean[] | null {
  let rows: boolean[] | null = null;
  const clips: (InkClip | undefined)[] = [];
  for (const operation of output.operations) {
    if (operation.type === 'clip') {
      clips.push(operation.clip);
      continue;
    }
    if (operation.type === 'unclip') {
      clips.pop();
      continue;
    }
    const { x, y, text } = operation;
    // A tab measures as no cells, to Ink's clip as much as to `getWidestLine`, so it always counts.
    if (!text.includes('\t')) {
      if (clipsWithinWidth(clips.at(-1), output.width)) continue;
      // No grapheme is wider than two cells or shorter than one code unit, so a write whose length
      // is at most half the room left on its row cannot reach past it, and needs no width lookup.
      if (x + 2 * text.length <= output.width) continue;
      if (x + output.caches.getWidestLine(text) <= output.width) continue;
    }
    rows ??= new Array<boolean>(output.height).fill(false);
    let lines = 1;
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
      lines++;
    }
    const last = Math.min(y + lines, output.height);
    for (let row = Math.max(y, 0); row < last; row++) rows[row] = true;
  }
  return rows;
}

/** Builds a `get` that returns what `options.get` does, with every row cut to `this.width`. */
export function createFrameClippedGet(
  options: FrameClippedGetOptions,
): (this: InkOutput) => InkOutputFrame {
  const { get, sliceAnsi, stringWidth } = options;
  const clipped = function (this: InkOutput): InkOutputFrame {
    const frame = get.call(this);
    // Read after `get`: the row cache swaps its shared caches in, which already know the widths.
    const candidates = rowsPastWidth(this);
    if (candidates === null) return frame;
    const caches = this.caches as Partial<InkOutput['caches']> | undefined;
    const measure: StringWidth =
      typeof caches?.getStringWidth === 'function'
        ? caches.getStringWidth.bind(caches)
        : stringWidth;
    const width = this.width;
    const rows = frame.output.split('\n');
    // A transformer can return a line with a newline in it, which Ink keeps on one grid row; the
    // split then yields more rows than the grid has and every later index shifts, so check them all.
    const checkAll = rows.length !== frame.height;
    let changed = false;
    for (let row = 0; row < rows.length; row++) {
      if (!checkAll && !candidates[row]) continue;
      const original = rows[row] ?? '';
      let text = original.includes('\t') ? expandTabs(original, measure) : original;
      // Ink trims every row's trailing spaces; a cut row keeps that convention.
      if (measure(text) > width) text = sliceAnsi(text, 0, width).trimEnd();
      if (text === original) continue;
      rows[row] = text;
      changed = true;
    }
    return changed ? { output: rows.join('\n'), height: frame.height } : frame;
  };
  // Keep the marks of the `get` this wraps, so its installer still sees itself installed and a
  // second install pass adds no layer of either.
  for (const symbol of Object.getOwnPropertySymbols(get)) {
    const descriptor = Object.getOwnPropertyDescriptor(get, symbol);
    if (descriptor) Object.defineProperty(clipped, symbol, descriptor);
  }
  Object.defineProperty(clipped, INSTALLED_MARK, { value: true });
  return clipped;
}

/** Whether `Output.prototype.get` is already a frame-clipped one. */
function isFrameClippedGet(Output: unknown): boolean {
  if (typeof Output !== 'function') return false;
  const prototype = (Output as { prototype?: { get?: unknown } }).prototype;
  const get = prototype?.get as { [INSTALLED_MARK]?: unknown } | undefined;
  return get?.[INSTALLED_MARK] === true;
}

/** Whether Ink's `Output` carries the `width`, operations and widest-line cache the clip reads. */
function isClippableOutput(Output: unknown): Output is InkOutputConstructor {
  if (!isInkOutputShape(Output)) return false;
  try {
    return new Output({ width: 3, height: 1 }).width === 3;
  } catch {
    return false;
  }
}

/**
 * Wraps Ink's `Output.prototype.get` so no frame row is wider than the terminal, once per process,
 * and returns whether the clip is installed after this call. Install it after
 * `installInkOutputCache`, so it wraps the row-cached `get` rather than being wrapped by it. Returns
 * false, leaving Ink alone, when `BOOK_INK_FRAME_CLIP` reads as false — `0`, `false`, `off` or
 * `no`, in any case and with spaces around it — and when Ink's private `Output` or the `slice-ansi`
 * and `string-width` copies beside it cannot be read. A clip already in place stays, whatever this
 * call's environment says.
 */
export async function installInkFrameClip(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const outputPath = join(inkBuildDir(), 'output.js');
    const outputModule = await import(pathToFileURL(outputPath).href);
    const Output: unknown = outputModule.default;
    if (isFrameClippedGet(Output)) return true;
    if (parseEnvBoolean(env.BOOK_INK_FRAME_CLIP) === false) return false;
    const require = createRequire(outputPath);
    const [sliceAnsiModule, stringWidthModule] = await Promise.all([
      import(pathToFileURL(require.resolve('slice-ansi')).href),
      import(pathToFileURL(require.resolve('string-width')).href),
    ]);
    const sliceAnsi: unknown = sliceAnsiModule.default;
    const stringWidth: unknown = stringWidthModule.default;
    if (!isClippableOutput(Output)) return false;
    if (typeof sliceAnsi !== 'function' || typeof stringWidth !== 'function') return false;
    Output.prototype.get = createFrameClippedGet({
      get: Output.prototype.get,
      sliceAnsi: sliceAnsi as SliceAnsi,
      stringWidth: stringWidth as StringWidth,
    });
    return true;
  } catch {
    return false;
  }
}
