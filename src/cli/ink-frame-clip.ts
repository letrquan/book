import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isInkOutputShape,
  type InkOutput,
  type InkOutputConstructor,
  type InkOutputFrame,
  type SliceAnsi,
} from './ink-output-cache.js';
import { inkBuildDir } from './ink-renderer.js';

/**
 * Keeps every row of Ink's frame within the terminal's width (#525).
 *
 * Ink's private `Output.get` builds each row from a grid `this.width` cells wide, but a write that
 * runs past the last cell grows the row instead of being cut, so a frame row can come out wider
 * than the terminal. That happens on every narrowing resize: Ink's `resized()` lays the root out
 * at the new `stdout.columns` and draws at once, while Book's components still hold the old width
 * in React state for the 50 ms the resize debounce takes, and the input bar's rules and footer are
 * Boxes with that width set explicitly. The terminal autowraps each over-wide row onto a second
 * physical row, so log-update's idea of how tall its frame is falls short by one row per wrap, and
 * its next incremental frame moves the cursor up into the middle of the old one. The rows it thinks
 * unchanged — blank rows, rules, the input bar — are skipped, and the stale wrapped rows stay: two
 * working indicators, extra rules, a rule fragment, a second input bar.
 *
 * Cutting the rows at `Output.get` covers both renderer modes and every way Ink writes a frame
 * (incremental, standard, and the clear-terminal branch), because all of them write what `get`
 * returns. `this.width` is the root's computed width, which Ink sets from the live
 * `stdout.columns` in `calculateLayout` before every resized frame.
 *
 * The steady state costs no row measuring. A row can only pass the width if a write reaches past
 * it, and a write reaches no further than its `x` plus its widest line — Ink's own cached
 * `getWidestLine`, the measure Ink lays text out with (it wraps text before its transformers run,
 * and Text's transformer only adds styling). So each frame first compares every write's extent
 * against `this.width` — a write short enough that even two cells per code unit stays inside skips
 * the lookup too — and only when one reaches past it are the rows that write covers measured with
 * Ink's `string-width`, and only the rows that really are too wide are cut, with Ink's `slice-ansi`,
 * which keeps styles closed and never splits a wide character (a row cut beside one may come out a
 * cell short).
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

/**
 * The rows a write that reaches past the width covers, or null when no write does. A write covers
 * at most the rows from its `y` down by its line count: a vertical clip only moves it down and
 * drops lines.
 */
function rowsPastWidth(output: InkOutput): boolean[] | null {
  let rows: boolean[] | null = null;
  for (const operation of output.operations) {
    if (operation.type !== 'write') continue;
    const { x, y, text } = operation;
    // No grapheme is wider than two cells or shorter than one code unit, so a write whose length is
    // at most half the room left on its row cannot reach past it, and needs no width lookup.
    if (x + 2 * text.length <= output.width) continue;
    if (x + output.caches.getWidestLine(text) <= output.width) continue;
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
    const width = this.width;
    const rows = frame.output.split('\n');
    let changed = false;
    for (let row = 0; row < rows.length; row++) {
      if (!candidates[row]) continue;
      const text = rows[row] ?? '';
      if (stringWidth(text) <= width) continue;
      // Ink trims every row's trailing spaces; a cut row keeps that convention.
      rows[row] = sliceAnsi(text, 0, width).trimEnd();
      changed = true;
    }
    return changed ? { output: rows.join('\n'), height: frame.height } : frame;
  };
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
 * false, leaving Ink alone, when Ink's private `Output` or the `slice-ansi` and `string-width`
 * copies beside it cannot be read.
 */
export async function installInkFrameClip(): Promise<boolean> {
  try {
    const outputPath = join(inkBuildDir(), 'output.js');
    const outputModule = await import(pathToFileURL(outputPath).href);
    const Output: unknown = outputModule.default;
    if (isFrameClippedGet(Output)) return true;
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
