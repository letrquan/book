import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inkBuildDir } from './ink-renderer.js';

/**
 * Caches Ink's output rows across frames, because Ink's frame is where the scroll stall lives.
 *
 * The first scroll through a heavy session stalls 40-250 ms at a time. A CPU profile of a real
 * 4 MB session on Windows puts the stall in Ink, not in Book's components: Ink's private
 * `Output.get` is 29% of it, `renderNodeToOutput` 19%, Yoga layout 14% and the React render 14%,
 * while DiffBlock and the Markdown renderer are 2.5% between them. Ink builds a fresh `Output`,
 * with fresh caches, for every frame, so every frame re-tokenizes every visible line and turns
 * every row's cells back into a string even when the row is the same text it drew one frame
 * earlier, one row higher.
 *
 * The replacement here walks the operations exactly the way Ink's own `get` does, collects the
 * fragments each output row is made of, and hands a row's string to the row cache instead of
 * rebuilding it, so an unchanged row costs a map lookup whether it moved or not. A row's string is
 * built by Ink's original `get` on a scratch `Output` holding only that row's fragments, which is
 * why the frames are byte-identical rather than merely close. Sharing one set of width and
 * styled-character caches across frames is the other half: a line measured once stays measured.
 *
 * A measurement prototype cut stalls over 40 ms during 40 wheel-up reports at 30/s from 9.0 to 4.4
 * per run, and their summed time from 509 ms to 221 ms over 7 interleaved runs each, with frames
 * byte-identical to Ink's own `get` across about 270 real frames.
 *
 * `installInkOutputCache` refuses to touch Ink unless `isInkOutputShape` accepts it, and
 * `ink-renderer.contract.test.ts` pins that shape against the installed Ink, so an Ink upgrade that
 * changes `Output` fails the contract tier instead of quietly changing what the TUI draws.
 */

/** Ink's private clip rectangle. A bound is undefined when the clip is not on that axis. */
export interface InkClip {
  x1?: number;
  x2?: number;
  y1?: number;
  y2?: number;
}

/** Ink's per-line text transformer, which receives the line's index within its own write. */
export type InkTransformer = (line: string, index: number) => string;

/** Ink's recorded writes and clips, in the order `get` replays them. */
export type InkOperation =
  | { type: 'write'; x: number; y: number; text: string; transformers: InkTransformer[] }
  | { type: 'clip'; clip: InkClip | undefined }
  | { type: 'unclip' };

/** The width, styled-character and block-width caches Ink keeps per `Output`, and thus per frame. */
export interface InkOutputCaches {
  styledChars: Map<string, unknown>;
  widths: Map<string, number>;
  blockWidths: Map<string, number>;
  getStyledChars: (line: string) => unknown;
  getStringWidth: (text: string) => number;
  getWidestLine: (text: string) => number;
}

/** What `Output.get` returns: the whole frame, and the number of rows it was built from. */
export interface InkOutputFrame {
  output: string;
  height: number;
}

/** Ink's private `Output`: the operation log `get` replays into a frame of rows. */
export interface InkOutput {
  width: number;
  height: number;
  operations: InkOperation[];
  caches: InkOutputCaches;
  write(x: number, y: number, text: string, options: { transformers: InkTransformer[] }): void;
  clip(clip: InkClip): void;
  unclip(): void;
}

/** Ink's private `Output` class, as `node_modules/ink/build/output.js` exports it. */
export interface InkOutputConstructor {
  new (options: { width: number; height: number }): InkOutput;
  prototype: { get: (this: InkOutput) => InkOutputFrame };
}

/** `slice-ansi`, resolved from Ink's own location so it is the copy Ink measures with. */
export type SliceAnsi = (text: string, from: number, to: number) => string;

/** Entry sizes, each clearing its map once it grows past the limit. */
export interface RowCacheLimits {
  styledChars: number;
  widths: number;
  blockWidths: number;
  sliceCache: number;
  rowCache: number;
}

const DEFAULT_LIMITS: RowCacheLimits = {
  styledChars: 1024,
  widths: 16384,
  blockWidths: 4096,
  sliceCache: 4096,
  rowCache: 4096,
};

export interface RowCachedGetOptions {
  /** Ink's own `get`, which still builds the rows this one cannot serve from the cache. */
  originalGet: (this: InkOutput) => InkOutputFrame;
  sliceAnsi: SliceAnsi;
  Output: InkOutputConstructor;
  limits?: Partial<RowCacheLimits>;
}

/**
 * How many frames and rows have been rendered, and how many of those rows needed no work: a row
 * that came from the cache, and a row nothing was written to, which is its own empty string.
 */
export interface OutputCacheStats {
  frames: number;
  rows: number;
  rowHits: number;
}

export interface RowCachedGet {
  get: (this: InkOutput) => InkOutputFrame;
  stats: () => OutputCacheStats;
}

/** One write's place and final text on a row, after clipping and transformers. */
type InkFragment = [x: number, line: string];

function bound(map: Map<unknown, unknown>, limit: number): void {
  if (map.size > limit) map.clear();
}

/**
 * Builds a replacement for `Output.prototype.get` that keeps Ink's row strings, caches and
 * clipping behaviour and adds a row cache on top. Every cache lives in this factory's closure, so
 * two of these share nothing.
 */
export function createRowCachedGet(options: RowCachedGetOptions): RowCachedGet {
  const { originalGet, sliceAnsi, Output } = options;
  const limits: RowCacheLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const rowCache = new Map<string, string>();
  const sliceCache = new Map<string, string>();
  const counters = { frames: 0, rows: 0, rowHits: 0 };
  let sharedCaches: InkOutputCaches | null = null;

  const get = function (this: InkOutput): InkOutputFrame {
    // The first Output seen donates its caches; every later frame reuses them, so a line measured
    // once stays measured.
    if (sharedCaches === null) sharedCaches = this.caches;
    const caches = sharedCaches;
    this.caches = caches;
    bound(caches.styledChars, limits.styledChars);
    bound(caches.widths, limits.widths);
    bound(caches.blockWidths, limits.blockWidths);
    bound(sliceCache, limits.sliceCache);
    bound(rowCache, limits.rowCache);

    const rows: InkFragment[][] = [];
    for (let y = 0; y < this.height; y++) rows.push([]);
    const clips: (InkClip | undefined)[] = [];
    for (const operation of this.operations) {
      if (operation.type === 'clip') clips.push(operation.clip);
      if (operation.type === 'unclip') clips.pop();
      if (operation.type !== 'write') continue;
      const { text, transformers } = operation;
      let { x, y } = operation;
      let lines = text.split('\n');
      const clip = clips.at(-1);
      if (clip) {
        const { x1, x2, y1, y2 } = clip;
        const clipHorizontally = typeof x1 === 'number' && typeof x2 === 'number';
        const clipVertically = typeof y1 === 'number' && typeof y2 === 'number';
        // Text outside the clip altogether is skipped whole, before any measuring.
        if (clipHorizontally) {
          if (x + caches.getWidestLine(text) < x1 || x > x2) continue;
        }
        if (clipVertically) {
          if (y + lines.length < y1 || y > y2) continue;
        }
        if (clipHorizontally) {
          lines = lines.map((line) => {
            const from = x < x1 ? x1 - x : 0;
            const width = caches.getStringWidth(line);
            const to = x + width > x2 ? x2 - x : width;
            const key = `${from},${to},${line.length},${line}`;
            const cached = sliceCache.get(key);
            if (cached !== undefined) return cached;
            const sliced = sliceAnsi(line, from, to);
            sliceCache.set(key, sliced);
            return sliced;
          });
          if (x < x1) x = x1;
        }
        if (clipVertically) {
          const from = y < y1 ? y1 - y : 0;
          const to = y + lines.length > y2 ? y2 - y : lines.length;
          lines = lines.slice(from, to);
          if (y < y1) y = y1;
        }
      }
      let offsetY = 0;
      for (const [index, original] of lines.entries()) {
        // Ink's quirk: a line the output has no row for is dropped without advancing the offset,
        // which puts every line after it one row too low. Kept, because frames must match.
        if (!rows[y + offsetY]) continue;
        let line = original;
        for (const transformer of transformers) line = transformer(line, index);
        rows[y + offsetY].push([x, line]);
        offsetY++;
      }
    }

    const frame: string[] = new Array(rows.length);
    const misses: number[] = [];
    const missKeys: string[] = [];
    for (let row = 0; row < rows.length; row++) {
      const fragments = rows[row];
      counters.rows++;
      if (fragments.length === 0) {
        frame[row] = '';
        counters.rowHits++;
        continue;
      }
      // Length-prefixed, so no line's content can make two different rows share a key.
      let key = `${this.width}|`;
      for (const [x, line] of fragments) key += `${x},${line.length},${line}`;
      const cached = rowCache.get(key);
      if (cached === undefined) {
        misses.push(row);
        missKeys.push(key);
      } else {
        frame[row] = cached;
        counters.rowHits++;
      }
    }
    if (misses.length > 0) {
      // One scratch Output per frame for the misses, with each missing row's fragments as plain
      // writes: Ink's own get still builds every cell and every style.
      const scratch = new Output({ width: this.width, height: misses.length });
      scratch.caches = caches;
      misses.forEach((row, index) => {
        for (const [x, line] of rows[row] ?? []) {
          scratch.operations.push({ type: 'write', x, y: index, text: line, transformers: [] });
        }
      });
      const built = originalGet.call(scratch).output.split('\n');
      misses.forEach((row, index) => {
        const text = built[index] ?? '';
        frame[row] = text;
        rowCache.set(missKeys[index], text);
      });
    }
    counters.frames++;
    return { output: frame.join('\n'), height: this.height };
  };

  return { get, stats: () => ({ ...counters }) };
}

/** Whether a candidate carries the parts of Ink's `Output` this module reads. */
export function isInkOutputShape(candidate: unknown): candidate is InkOutputConstructor {
  if (typeof candidate !== 'function') return false;
  const Output = candidate as InkOutputConstructor;
  const prototype: unknown = Output.prototype;
  if (typeof prototype !== 'object' || prototype === null) return false;
  if (typeof (prototype as { get?: unknown }).get !== 'function') return false;
  let instance: InkOutput;
  try {
    instance = new Output({ width: 1, height: 1 });
  } catch {
    return false;
  }
  if (!Array.isArray(instance.operations)) return false;
  const caches: unknown = instance.caches;
  if (typeof caches !== 'object' || caches === null) return false;
  const shaped = caches as Partial<InkOutputCaches>;
  return (
    typeof shaped.getStyledChars === 'function' &&
    typeof shaped.getStringWidth === 'function' &&
    typeof shaped.getWidestLine === 'function' &&
    shaped.styledChars instanceof Map &&
    shaped.widths instanceof Map &&
    shaped.blockWidths instanceof Map
  );
}

let installed = false;

/**
 * Replaces Ink's `Output.prototype.get` with the row-cached one, once per process. Returns false
 * and leaves Ink untouched when `BOOK_INK_OUTPUT_CACHE` is `off` or `0`, and when Ink's private
 * `Output` or the `slice-ansi` copy beside it cannot be read, so an upgrade that changes either
 * costs speed rather than correctness — `ink-renderer.contract.test.ts` fails on that upgrade.
 */
export async function installInkOutputCache(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env.BOOK_INK_OUTPUT_CACHE === 'off' || env.BOOK_INK_OUTPUT_CACHE === '0') return false;
  if (installed) return true;
  try {
    const outputPath = join(inkBuildDir(), 'output.js');
    const sliceAnsiPath = createRequire(outputPath).resolve('slice-ansi');
    const [{ default: Output }, { default: sliceAnsi }] = await Promise.all([
      import(pathToFileURL(outputPath).href),
      import(pathToFileURL(sliceAnsiPath).href),
    ]);
    if (!isInkOutputShape(Output) || typeof sliceAnsi !== 'function') return false;
    const originalGet = Output.prototype.get;
    Output.prototype.get = createRowCachedGet({
      originalGet,
      sliceAnsi: sliceAnsi as SliceAnsi,
      Output,
    }).get;
    installed = true;
    return true;
  } catch {
    return false;
  }
}
