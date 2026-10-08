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
 * about one viewport of rows mounted above and below the view, so most of that walk is spent on
 * rows nobody can see: for each text node it squashes the text, measures `widestLine` and wraps it,
 * then records a write that `Output.get` throws away when it lies outside the clip. Even after
 * culling wholly offscreen rows, rows that straddle the viewport edge (e.g. long diffs or tool
 * outputs) still accounted for 54% of writes landing outside the clip.
 *
 * The walk checks `yogaNode.getDisplay() === Yoga.DISPLAY_NONE` first and returns at once when it
 * is, so the cull installs exactly that: a mounted transcript row's yoga node gets an own
 * `getDisplay` that reports `DISPLAY_NONE` while the row's box lies wholly outside the innermost
 * clip of the walk in progress, and the node's real display otherwise.
 *
 * The registration root is `TranscriptView`'s `contentRef` box, registered once on mount. Because
 * that box always straddles the viewport while there is anything to scroll, propagation registers
 * ChatPanel's column, and the column registers each row during the walk itself, before the walk
 * visits it. Newly mounted rows in a frame are therefore culled in that same frame.
 * When a registered node's `getDisplay` finds the node visible but straddling the innermost vertical
 * clip (its box crosses `y1` or `y2`), it registers each of its child elements (`childNodes` with a
 * `yogaNode`, text nodes included) through the same registrar, skipping the scan when the child
 * count and the first and last child identities are unchanged. Because Ink's walk queries
 * `getDisplay` on a parent before walking its children, straddling children are culled in the exact
 * same walk.
 * Nodes wholly inside the clip register nothing (everything is visible), and culled nodes register
 * nothing.
 *
 * The cull rests on the invariant that a node whose box lies wholly outside the innermost vertical
 * clip can be hidden without changing what is drawn on screen. That holds only if:
 *   (a) everything the node's subtree draws lies inside the node's own box, and
 *   (b) no descendant draws against a clip of its own (Ink's `Output.get` applies only the
 *       innermost clip; it does not intersect nested clips).
 *
 * This invariant is held in two ways:
 *   1. Summary rows truncate, never wrap: the one-row summary boxes in `ToolCallBlock.tsx`,
 *      `AgentMessage.tsx` and `QuietToolRun.tsx` pass `wrap="truncate-end"` to every `Text` child,
 *      so long targets never spill onto the line below the box.
 *   2. A node that clips itself is never culled: if an element's style clips (`overflow`, `overflowX`
 *      or `overflowY` is `'hidden'`), its `getDisplay` returns the real display without culling.
 *      Its subtree draws against its own clip, so only drawing it is exact; its children are still
 *      decided against that clip when the walk reaches them.
 *
 * A clipping or overflowing descendant added to the transcript later would break exactness.
 * Yoga layout is untouched — Yoga reads display from its native style, not from this JavaScript
 * method — so a culled node is still laid out exactly as before; only its drawing is skipped.
 *
 * Absolute tops are memoized per frame in a `WeakMap` from element to `{ frame, top }` so sibling
 * elements avoid re-summing `getComputedTop()` up the ancestor chain. A frame counter advances
 * whenever `Output.prototype.clip` is called on a different `Output` instance than the previous
 * call (Ink builds a new `Output` for every frame). An element's absolute top is its own computed
 * top plus its parent's memoized absolute top (a missing parent is 0; a link with no readable top
 * leaves the cull undecided). Tops are recomputed when the frame counter advances.
 *
 * The clip state comes from wrapping `Output.prototype.clip` and `unclip`, which the walk calls in
 * walk order: one stack per `Output` (a `WeakMap`) of clips pushed and not yet popped. A frame's
 * stack is detected when an `Output` is first clipped; only that stack array is held during the
 * frame, avoiding retaining the `Output` instance and its operations after the frame completes.
 * Each cull instance uses a single shared `getDisplay` function looking up node state in a `WeakMap`,
 * avoiding per-node closures.
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
 * An Ink DOM element as the cull reads it: a yoga node, style overflow properties, and the parent
 * chain whose computed tops add up to the walk's absolute y. Ink's `DOMElement` satisfies this.
 */
export interface CullableElement {
  yogaNode?: CullableYogaNode | null;
  parentNode?: CullableElement | null;
  childNodes?: readonly CullableElement[] | Iterable<CullableElement> | null;
  style?: {
    overflow?: string;
    overflowX?: string;
    overflowY?: string;
  };
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

/** Set on a yoga node to remember its original unculled display method across cull instances. */
const REAL_DISPLAY = Symbol('book.inkRenderCullRealDisplay');

interface MarkedClip {
  [INSTALLED_MARK]?: true;
}

interface MarkedYogaNode {
  [REAL_DISPLAY]?: () => number;
  [key: symbol]: unknown;
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

  // Registration mark created per cull instance so a new instance re-registers previously marked nodes.
  const cullMark = Symbol('book.inkRenderCullDisplay');

  // The clips each Output has pushed and not yet popped.
  const clips = new WeakMap<InkOutput, InkClip[]>();
  // Active stack array for the current frame, keeping no reference to the Output instance itself.
  let activeClipStack: InkClip[] | null = null;
  let frame = 0;
  const absoluteTops = new WeakMap<CullableElement, { frame: number; top: number | undefined }>();

  // Tracks the childNodes length, first child, and last child last scanned per element.
  const scannedChildren = new WeakMap<
    CullableElement,
    {
      length: number;
      firstChild: CullableElement | undefined;
      lastChild: CullableElement | undefined;
    }
  >();

  // Maps each registered yogaNode to its element and realDisplay method for sharedGetDisplay.
  const nodeRecords = new WeakMap<
    CullableYogaNode,
    { element: CullableElement; realDisplay: () => number }
  >();

  const clip = function (this: InkOutput, pushed: InkClip): void {
    let stack = clips.get(this);
    if (stack === undefined) {
      frame++;
      stack = [];
      clips.set(this, stack);
    }
    activeClipStack = stack;
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

  function sharedGetDisplay(this: CullableYogaNode): number {
    const record = nodeRecords.get(this);
    if (record === undefined) {
      const stored = (this as unknown as MarkedYogaNode)[REAL_DISPLAY];
      if (typeof stored === 'function') return stored.call(this);
      const proto = Object.getPrototypeOf(this) as CullableYogaNode | null;
      if (typeof proto?.getDisplay === 'function') return proto.getDisplay.call(this);
      return displayNone;
    }
    const { element, realDisplay } = record;
    const display = realDisplay.call(this);
    if (display === displayNone) return display;
    if (activeClipStack === null || activeClipStack.length === 0) return display;
    const innermost = activeClipStack.at(-1);
    if (innermost === undefined) return display;
    const { y1, y2 } = innermost;
    // No clip, or one that clips horizontally only, never decides a cull.
    if (typeof y1 !== 'number' || typeof y2 !== 'number') return display;
    const top = getAbsoluteTop(element);
    if (top === undefined) return display;
    const bottom = top + this.getComputedHeight();

    const style = element.style;
    const clipsSelf =
      style !== undefined &&
      (style.overflow === 'hidden' || style.overflowX === 'hidden' || style.overflowY === 'hidden');

    const straddles = (top < y1 && bottom > y1) || (top < y2 && bottom > y2);
    if (straddles) {
      const currentChildren = element.childNodes;
      let currentLength = 0;
      let firstChild: CullableElement | undefined;
      let lastChild: CullableElement | undefined;
      if (Array.isArray(currentChildren)) {
        currentLength = currentChildren.length;
        if (currentLength > 0) {
          firstChild = currentChildren[0];
          lastChild = currentChildren[currentLength - 1];
        }
      } else if (
        currentChildren &&
        typeof (currentChildren as Iterable<CullableElement>)[Symbol.iterator] === 'function'
      ) {
        const items = Array.from(currentChildren as Iterable<CullableElement>);
        currentLength = items.length;
        if (currentLength > 0) {
          firstChild = items[0];
          lastChild = items[currentLength - 1];
        }
      }

      const lastScanned = scannedChildren.get(element);
      if (
        lastScanned === undefined ||
        lastScanned.length !== currentLength ||
        lastScanned.firstChild !== firstChild ||
        lastScanned.lastChild !== lastChild
      ) {
        scannedChildren.set(element, {
          length: currentLength,
          firstChild,
          lastChild,
        });
        if (
          currentChildren &&
          typeof (currentChildren as Iterable<CullableElement>)[Symbol.iterator] === 'function'
        ) {
          for (const child of currentChildren as Iterable<CullableElement>) {
            cull.cullWhenOffscreen(child);
          }
        }
      }
    }

    if (clipsSelf) return display;
    if (bottom <= y1 || top >= y2) return displayNone;
    return display;
  }

  const cull: InkRenderCull = {
    clip,
    unclip,
    cullWhenOffscreen: (element: CullableElement | null): void => {
      if (element === null || typeof element !== 'object') return;
      const yogaNode = element.yogaNode;
      if (!isCullableYogaNode(yogaNode)) return;
      const marked = yogaNode as unknown as MarkedYogaNode;
      if (marked[cullMark] === true) return;

      let realDisplay = marked[REAL_DISPLAY];
      if (typeof realDisplay !== 'function') {
        realDisplay = yogaNode.getDisplay;
        Object.defineProperty(yogaNode, REAL_DISPLAY, { value: realDisplay, configurable: true });
      }

      nodeRecords.set(yogaNode, { element, realDisplay });
      Object.defineProperty(yogaNode, 'getDisplay', {
        value: sharedGetDisplay,
        configurable: true,
      });
      Object.defineProperty(yogaNode, cullMark, { value: true, configurable: true });
    },
  };

  return cull;
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
 * The registrar the TUI calls from a mount effect: a no-op until an install succeeds, then
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
