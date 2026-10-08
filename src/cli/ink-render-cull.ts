import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnvBoolean } from '../env-boolean.js';
import type { InkClip, InkOutput } from './ink-output-cache.js';
import { inkBuildDir } from './ink-renderer.js';

/**
 * Culls Ink's drawing of transcript rows and straddling descendants that lie wholly outside the
 * viewport's clip.
 *
 * The row cache in `ink-output-cache.ts` took the per-frame string building out of Ink's frame, but
 * the walk that visits every mounted node every frame — Ink's private `renderNodeToOutput` — was
 * still 26% of the TUI's busy CPU while scrolling a real session. The virtual transcript keeps
 * about one viewport of rows mounted above and below the view,
 * so most of that walk is spent on rows nobody can see: for each text node it squashes the text,
 * measures `widestLine` and wraps it, then records a write that `Output.get` throws away when it
 * lies outside the clip. Even after culling wholly offscreen rows, rows that straddle the viewport
 * edge (e.g. long diffs or tool outputs) still accounted for 54% of writes landing outside the clip.
 *
 * The walk checks `yogaNode.getDisplay() === Yoga.DISPLAY_NONE` first and returns at once when it
 * is, so the cull installs exactly that: a mounted transcript row's yoga node gets an own
 * `getDisplay` that reports `DISPLAY_NONE` while the row's box lies wholly outside the innermost
 * clip of the walk in progress, and the node's real display otherwise. When a registered node's
 * `getDisplay` finds the node visible but straddling the innermost vertical clip (its box crosses
 * `y1` or `y2`), it registers each of its child elements (`childNodes` with a `yogaNode`, text
 * nodes included) through the same registrar, idempotently. Because Ink's walk queries
 * `getDisplay` on a parent before walking its children, straddling children are culled in the exact
 * same walk. Nodes wholly inside the clip register nothing (everything is visible), and culled
 * nodes register nothing.
 *
 * The cull remains exact — it only ever reaches descendants of registered transcript rows, inside
 * which there is no absolute positioning and no negative margin, and the only nested clip is
 * `VirtualTranscriptRow`'s own hold, which as the innermost clip is what both the cull and
 * `Output.get` read. A node wholly outside the innermost vertical clip writes nothing `Output.get`
 * keeps. Yoga layout is untouched — Yoga reads display from its native style, not from this
 * JavaScript method — so a culled node is still laid out exactly as before; only its drawing is
 * skipped.
 *
 * Absolute tops are memoized per frame in a `WeakMap` from element to `{ frame, top }` so sibling
 * elements avoid re-summing `getComputedTop()` up the ancestor chain. A frame counter advances
 * whenever `Output.prototype.clip` is called on a different `Output` instance than the previous
 * call (Ink builds a new `Output` for every frame). An element's absolute top is its own computed
 * top plus its parent's memoized absolute top (a missing parent is 0; a link with no readable top
 * leaves the cull undecided). Tops are recomputed when the frame counter advances.
 *
 * The clip state comes from wrapping `Output.prototype.clip` and `unclip`, which the walk calls in
 * walk order: one stack per `Output` (a `WeakMap`) of clips pushed and not yet popped, and the
 * `Output` the walk last clipped — one per frame. A row's `getDisplay` reads the top of that
 * stack, because `Output.get` applies only the innermost clip and only its vertical bounds, so
 * "wholly outside" is decided exactly as `Output.get` decides what to keep: a box whose bottom is
 * at or above the clip's first row, or whose top is at or below its last, draws nothing.
 *
 * Measured on the shipped code, over the real 4 MB session the issue used, at 120x40, resumed in a
 * PTY (40 wheel-up reports at 30/s, then 40 wheel-down at 30/s, then flicks; main's build against
 * this branch's build, interleaved runs): every real frame was drawn twice in the same process,
 * once with the cull and once without it, from the same layout — 0 mismatches over 512 frames
 * (Windows 246, Linux 266). The cull removes 65% (Windows) and 70% (Linux) of the walk's writes;
 * before it, 73% of the writes the walk made landed wholly outside the clip; with it, 21% (Windows)
 * and 10% (Linux). On Linux (5 runs per build), Ink's draw time summed over the wheel-up phase fell
 * from 486 ms to 306 ms (median draw 5.7 ms to 3.2 ms), over the wheel-down phase from 374 ms to
 * 209 ms (median draw 4.3 ms to 2.3 ms). Event-loop stalls over 40 ms during wheel-up fell from 1.6
 * to 1.0 per run, and the worst stall per run from 50 ms to 41 ms at the median.
 *
 * `installInkRenderCull` refuses to touch Ink unless the prototype carries the clip push, pop and
 * `get` the cull needs, and `ink-renderer.contract.test.ts` draws the same frames with and without
 * the cull against the installed Ink, so an Ink upgrade that changes the walk fails the contract
 * tier instead of quietly changing what the TUI draws. `BOOK_INK_RENDER_CULL=off` turns it off.
 */

/** The yoga-node surface the cull reads, and that Ink's walk itself calls. */
export interface CullableYogaNode {
  getDisplay: () => number;
  getComputedTop: () => number;
  getComputedHeight: () => number;
}

/**
 * An Ink DOM element as the cull reads it: a yoga node, and the parent chain whose computed tops
 * add up to the walk's absolute y. Ink's `DOMElement` satisfies this.
 */
export interface CullableElement {
  yogaNode?: CullableYogaNode | null;
  parentNode?: CullableElement | null;
  childNodes?: readonly CullableElement[] | Iterable<CullableElement> | null;
}

/** The pieces of Ink's `Output` the cull wraps: the walk's clip push and pop, beside its `get`. */
interface CullableOutputConstructor {
  prototype: {
    clip: (this: InkOutput, clip: InkClip) => void;
    unclip: (this: InkOutput) => void;
    get: (...args: unknown[]) => unknown;
  };
}

export interface InkRenderCullOptions {
  /** Ink's own clip push, which records the clip for `get` to replay. */
  clip: (this: InkOutput, clip: InkClip) => void;
  /** Ink's own clip pop. */
  unclip: (this: InkOutput) => void;
  /** `Yoga.DISPLAY_NONE`, read from the copy of yoga-layout Ink itself resolves. */
  displayNone: number;
}

/** The wrapped clip and pop, and the row registrar bound to their clip state. */
export interface InkRenderCull {
  clip: (this: InkOutput, clip: InkClip) => void;
  unclip: (this: InkOutput) => void;
  cullWhenOffscreen: (element: CullableElement | null) => void;
}

/** Set on the wrapped `clip` itself, which is where "is the cull in place" belongs. */
const INSTALLED_MARK = Symbol('book.inkRenderCull');

/** Set on a yoga node whose `getDisplay` the cull has replaced, so a row is registered once. */
const CULL_MARK = Symbol('book.inkRenderCullDisplay');

interface MarkedClip {
  [INSTALLED_MARK]?: true;
}

interface MarkedYogaNode {
  [CULL_MARK]?: true;
}

function isCullableYogaNode(candidate: unknown): candidate is CullableYogaNode {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const node = candidate as Partial<CullableYogaNode>;
  return (
    typeof node.getDisplay === 'function' &&
    typeof node.getComputedTop === 'function' &&
    typeof node.getComputedHeight === 'function'
  );
}

/**
 * Builds the wrapped clip and pop that keep the walk's clip state, and the registrar that gives a
 * row's yoga node an own `getDisplay` deciding against that state at draw time. Every state lives
 * in this factory's closure, so two of these share nothing.
 */
export function createInkRenderCull(options: InkRenderCullOptions): InkRenderCull {
  const { clip: originalClip, unclip: originalUnclip, displayNone } = options;
  // The clips each Output has pushed and not yet popped, and the Output the walk last clipped.
  const clips = new WeakMap<InkOutput, InkClip[]>();
  let clippedLast: InkOutput | null = null;
  let frame = 0;
  const absoluteTops = new WeakMap<CullableElement, { frame: number; top: number | undefined }>();

  const clip = function (this: InkOutput, pushed: InkClip): void {
    if (this !== clippedLast) {
      frame++;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      clippedLast = this;
    }
    let stack = clips.get(this);
    if (stack === undefined) {
      stack = [];
      clips.set(this, stack);
    }
    stack.push(pushed);
    originalClip.call(this, pushed);
  };
  Object.defineProperty(clip, INSTALLED_MARK, { value: true });

  const unclip = function (this: InkOutput): void {
    clips.get(this)?.pop();
    originalUnclip.call(this);
  };

  const getAbsoluteTop = (node: CullableElement): number | undefined => {
    const cached = absoluteTops.get(node);
    if (cached !== undefined && cached.frame === frame) {
      return cached.top;
    }
    const nodeTop = node.yogaNode?.getComputedTop();
    if (typeof nodeTop !== 'number') {
      absoluteTops.set(node, { frame, top: undefined });
      return undefined;
    }
    let parentTop = 0;
    if (node.parentNode != null) {
      const parentAbsoluteTop = getAbsoluteTop(node.parentNode);
      if (parentAbsoluteTop === undefined) {
        absoluteTops.set(node, { frame, top: undefined });
        return undefined;
      }
      parentTop = parentAbsoluteTop;
    }
    const totalTop = parentTop + nodeTop;
    absoluteTops.set(node, { frame, top: totalTop });
    return totalTop;
  };

  const cullWhenOffscreen = (element: CullableElement | null): void => {
    if (element === null || typeof element !== 'object') return;
    const yogaNode = element.yogaNode;
    if (!isCullableYogaNode(yogaNode)) return;
    if ((yogaNode as MarkedYogaNode & CullableYogaNode)[CULL_MARK] === true) return;
    // Read before the own property shadows it: for a yoga node the cull has not touched, this is
    // the method that reports the node's real display.
    const realDisplay = yogaNode.getDisplay;

    Object.defineProperty(yogaNode, 'getDisplay', {
      value: function (): number {
        const display = realDisplay.call(yogaNode);
        if (display === displayNone) return display;
        const output = clippedLast;
        if (output === null) return display;
        const innermost = clips.get(output)?.at(-1);
        if (innermost === undefined) return display;
        const { y1, y2 } = innermost;
        // No clip, or one that clips horizontally only, never decides a cull.
        if (typeof y1 !== 'number' || typeof y2 !== 'number') return display;
        const top = getAbsoluteTop(element);
        if (top === undefined) return display;
        const bottom = top + yogaNode.getComputedHeight();
        if (bottom <= y1 || top >= y2) return displayNone;
        const straddles = (top < y1 && bottom > y1) || (top < y2 && bottom > y2);
        if (
          straddles &&
          element.childNodes &&
          typeof (element.childNodes as Iterable<CullableElement>)[Symbol.iterator] === 'function'
        ) {
          for (const child of element.childNodes) {
            cullWhenOffscreen(child);
          }
        }
        return display;
      },
      configurable: true,
    });
    Object.defineProperty(yogaNode, CULL_MARK, { value: true });
  };

  return { clip, unclip, cullWhenOffscreen };
}

/** Whether a candidate's prototype already carries the marked clip of an installed cull. */
function isRenderCullInstalled(candidate: unknown): boolean {
  if (typeof candidate !== 'function') return false;
  const prototype = (candidate as { prototype?: { clip?: unknown } }).prototype;
  const clip = prototype?.clip as MarkedClip | undefined;
  return typeof clip === 'function' && clip[INSTALLED_MARK] === true;
}

/** Whether a candidate class carries the parts of Ink's `Output` the cull wraps. */
export function isInkRenderCullShape(candidate: unknown): candidate is CullableOutputConstructor {
  if (typeof candidate !== 'function') return false;
  const prototype: unknown = (candidate as { prototype?: unknown }).prototype;
  if (typeof prototype !== 'object' || prototype === null) return false;
  const { clip, unclip, get } = prototype as Record<string, unknown>;
  return typeof clip === 'function' && typeof unclip === 'function' && typeof get === 'function';
}

/**
 * The registrar the TUI calls from a row's mount effect: a no-op until an install succeeds, then
 * bound to the `Output` that install wrapped. It runs at most once per yoga node, so a row that
 * stays mounted needs it only on mount.
 */
let activeCull: InkRenderCull['cullWhenOffscreen'] | null = null;

/**
 * Registers an Ink DOM element so its drawing is skipped while it lies wholly outside the
 * walk's innermost clip.
 */
export function cullWhenOffscreen(element: CullableElement | null): void {
  activeCull?.(element);
}

/**
 * Wraps Ink's `Output.prototype.clip` and `unclip` with the clip-tracking cull, once per process,
 * and returns whether the cull is installed after this call.
 *
 * Returns true without touching anything when `Output.prototype.clip` already carries the mark: the
 * cull is in place, whatever this call's environment says. Returns false, leaving Ink alone, when
 * `BOOK_INK_RENDER_CULL` reads as false — `0`, `false`, `off` or `no`, in any case and with spaces
 * around it — and when Ink's private `Output` or the copy of `yoga-layout` beside it cannot be
 * read, so an upgrade that changes either costs speed rather than correctness:
 * `ink-renderer.contract.test.ts` fails on that upgrade.
 */
export async function installInkRenderCull(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const outputPath = join(inkBuildDir(), 'output.js');
    const outputModule = (await import(pathToFileURL(outputPath).href)) as { default: unknown };
    if (isRenderCullInstalled(outputModule.default)) return true;
    if (parseEnvBoolean(env.BOOK_INK_RENDER_CULL) === false) return false;
    // yoga-layout as Ink itself resolves it, so DISPLAY_NONE is the value the walk compares against.
    const yogaPath = createRequire(outputPath).resolve('yoga-layout');
    const yoga = (await import(pathToFileURL(yogaPath).href)) as {
      default?: { DISPLAY_NONE?: unknown };
    };
    const displayNone = yoga.default?.DISPLAY_NONE;
    if (typeof displayNone !== 'number') return false;
    if (!isInkRenderCullShape(outputModule.default)) return false;
    const { prototype } = outputModule.default as CullableOutputConstructor;
    const cull = createInkRenderCull({
      clip: prototype.clip,
      unclip: prototype.unclip,
      displayNone,
    });
    prototype.clip = cull.clip;
    prototype.unclip = cull.unclip;
    activeCull = cull.cullWhenOffscreen;
    return true;
  } catch {
    return false;
  }
}
