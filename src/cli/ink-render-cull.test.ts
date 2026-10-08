import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  InkClip,
  InkOperation,
  InkOutput,
  InkOutputFrame,
  InkTransformer,
} from './ink-output-cache.js';
import {
  createInkRenderCull,
  cullWhenOffscreen,
  installInkRenderCull,
  type CullableElement,
  type CullableYogaNode,
  type InkRenderCull,
} from './ink-render-cull.js';
import { inkBuildDir } from './ink-renderer.js';

// yoga-layout's DISPLAY_NONE and DISPLAY_FLEX. The install itself reads the real constants from
// the copy Ink resolves, and the contract tier pins that against the installed Ink.
const DISPLAY_NONE = 1;
const DISPLAY_FLEX = 0;

/** A stand-in for Ink's `Output`: clip, unclip and `get` on the prototype, operations recorded. */
class FakeOutput {
  operations: InkOperation[] = [];

  write(x: number, y: number, text: string, options: { transformers: InkTransformer[] }): void {
    this.operations.push({ type: 'write', x, y, text, transformers: options.transformers });
  }

  clip(clip: InkClip): void {
    this.operations.push({ type: 'clip', clip });
  }

  unclip(): void {
    this.operations.push({ type: 'unclip' });
  }

  get(): InkOutputFrame {
    return { output: '', height: 0 };
  }
}

const yogaProto = {
  getComputedTop(this: { top: number }) {
    return this.top;
  },
  getComputedHeight(this: { height: number }) {
    return this.height;
  },
  getDisplay(this: { display: number }) {
    return this.display;
  },
};

function fakeYogaNode(top: number, height: number, display = DISPLAY_FLEX): CullableYogaNode {
  const node = Object.create(yogaProto) as {
    top: number;
    height: number;
    display: number;
  } & CullableYogaNode;
  node.top = top;
  node.height = height;
  node.display = display;
  return node;
}

interface FakeRowElement extends CullableElement {
  yogaNode: CullableYogaNode;
  parentNode: CullableElement | null;
  childNodes?: FakeRowElement[];
}

/** A row under a root box whose own top is zero, so the row's top is its absolute top. */
function row(top: number, height: number, display = DISPLAY_FLEX): FakeRowElement {
  return {
    yogaNode: fakeYogaNode(top, height, display),
    parentNode: { yogaNode: fakeYogaNode(0, 1), parentNode: null },
  };
}

function rowWithChildren(
  top: number,
  height: number,
  children: { top: number; height: number }[],
  display = DISPLAY_FLEX,
): FakeRowElement {
  const parent: FakeRowElement = {
    yogaNode: fakeYogaNode(top, height, display),
    parentNode: { yogaNode: fakeYogaNode(0, 1), parentNode: null },
    childNodes: [],
  };
  parent.childNodes = children.map((c) => ({
    yogaNode: fakeYogaNode(c.top, c.height),
    parentNode: parent,
  }));
  return parent;
}

describe("culling rows against the walk's clips", () => {
  let cull: InkRenderCull;
  let fakeClip: (this: InkOutput, clip: InkClip) => void;
  let fakeUnclip: (this: InkOutput) => void;

  beforeAll(() => {
    fakeClip = FakeOutput.prototype.clip;
    fakeUnclip = FakeOutput.prototype.unclip;
  });

  beforeEach(() => {
    cull = createInkRenderCull({ clip: fakeClip, unclip: fakeUnclip, displayNone: DISPLAY_NONE });
    FakeOutput.prototype.clip = cull.clip as typeof FakeOutput.prototype.clip;
    FakeOutput.prototype.unclip = cull.unclip as typeof FakeOutput.prototype.unclip;
  });

  afterAll(() => {
    FakeOutput.prototype.clip = fakeClip;
    FakeOutput.prototype.unclip = fakeUnclip;
  });

  it('still records clips and unclips through the original methods', () => {
    const output = new FakeOutput();
    output.clip({ y1: 10, y2: 20 });
    output.unclip();
    expect(output.operations).toEqual([
      { type: 'clip', clip: { y1: 10, y2: 20 } },
      { type: 'unclip' },
    ]);
  });

  it("culls a row whose bottom is at the clip's first row, and not one lower", () => {
    const output = new FakeOutput();
    output.clip({ y1: 10, y2: 20 });
    // Bottom 10 == y1 is wholly outside: Ink would keep the write only to slice it to nothing.
    const above = row(8, 2);
    cull.cullWhenOffscreen(above);
    expect(above.yogaNode.getDisplay()).toBe(DISPLAY_NONE);
    // Bottom 11 reaches the clip's first row, which is visible.
    const visible = row(9, 2);
    cull.cullWhenOffscreen(visible);
    expect(visible.yogaNode.getDisplay()).toBe(DISPLAY_FLEX);
    output.unclip();
  });

  it("culls a row whose top is at the clip's last row, and not one higher", () => {
    const output = new FakeOutput();
    output.clip({ y1: 10, y2: 20 });
    const below = row(20, 1);
    cull.cullWhenOffscreen(below);
    expect(below.yogaNode.getDisplay()).toBe(DISPLAY_NONE);
    const visible = row(19, 1);
    cull.cullWhenOffscreen(visible);
    expect(visible.yogaNode.getDisplay()).toBe(DISPLAY_FLEX);
    output.unclip();
  });

  it('never culls with no clip active', () => {
    const output = new FakeOutput();
    const rowElement = row(0, 1);
    cull.cullWhenOffscreen(rowElement);
    expect(rowElement.yogaNode.getDisplay()).toBe(DISPLAY_FLEX);
    // A clip pushed and popped leaves nothing to decide against.
    output.clip({ y1: 10, y2: 20 });
    output.unclip();
    expect(rowElement.yogaNode.getDisplay()).toBe(DISPLAY_FLEX);
  });

  it('never culls when the innermost clip is horizontal-only, even inside a vertical one', () => {
    const output = new FakeOutput();
    output.clip({ y1: 10, y2: 20 });
    output.clip({ x1: 0, x2: 40 });
    const rowElement = row(25, 1);
    cull.cullWhenOffscreen(rowElement);
    expect(rowElement.yogaNode.getDisplay()).toBe(DISPLAY_FLEX);
    output.unclip();
    output.unclip();
  });

  it('lets the next clip out decide once the innermost one is popped', () => {
    const output = new FakeOutput();
    output.clip({ y1: 10, y2: 20 });
    output.clip({ y1: 50, y2: 60 });
    const rowElement = row(55, 1);
    cull.cullWhenOffscreen(rowElement);
    expect(rowElement.yogaNode.getDisplay()).toBe(DISPLAY_FLEX);
    output.unclip();
    expect(rowElement.yogaNode.getDisplay()).toBe(DISPLAY_NONE);
    output.unclip();
  });

  it('keeps a real DISPLAY_NONE', () => {
    const output = new FakeOutput();
    output.clip({ y1: 10, y2: 20 });
    const hidden = row(15, 1, DISPLAY_NONE);
    cull.cullWhenOffscreen(hidden);
    expect(hidden.yogaNode.getDisplay()).toBe(DISPLAY_NONE);
    output.unclip();
  });

  it('registers a yoga node once', () => {
    const rowElement = row(0, 1);
    cull.cullWhenOffscreen(rowElement);
    const registered = rowElement.yogaNode.getDisplay;
    cull.cullWhenOffscreen(rowElement);
    expect(rowElement.yogaNode.getDisplay).toBe(registered);
  });

  it('does nothing for a null element or an element without a usable yoga node', () => {
    expect(() => cull.cullWhenOffscreen(null)).not.toThrow();
    const bare: CullableElement = { parentNode: null };
    expect(() => cull.cullWhenOffscreen(bare)).not.toThrow();
    const partial: CullableElement = {
      yogaNode: {} as unknown as CullableYogaNode,
      parentNode: null,
    };
    expect(() => cull.cullWhenOffscreen(partial)).not.toThrow();
    expect(Object.prototype.hasOwnProperty.call(partial.yogaNode, 'getDisplay')).toBe(false);
  });

  it('registers children of a parent straddling y1, culling those wholly above and keeping those crossing into the clip', () => {
    const output = new FakeOutput();
    output.clip({ y1: 10, y2: 20 });
    // Parent top: 5, height: 10 -> absolute top: 5, bottom: 15. Straddles y1 (5 < 10 && 15 > 10).
    // Child 0: top 0, height 4 -> absolute top: 5, bottom: 9 <= 10 -> wholly above y1.
    // Child 1: top 4, height 4 -> absolute top: 9, bottom: 13 -> crossing into clip (9 < 20 && 13 > 10).
    const parent = rowWithChildren(5, 10, [
      { top: 0, height: 4 },
      { top: 4, height: 4 },
    ]);
    const [childAbove, childCrossing] = parent.childNodes!;
    cull.cullWhenOffscreen(parent);
    expect(Object.prototype.hasOwnProperty.call(childAbove.yogaNode, 'getDisplay')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(childCrossing.yogaNode, 'getDisplay')).toBe(false);
    // Walking parent calls its getDisplay first:
    expect(parent.yogaNode.getDisplay()).toBe(DISPLAY_FLEX);
    // In the same walk, child getDisplay calls:
    expect(childAbove.yogaNode.getDisplay()).toBe(DISPLAY_NONE);
    expect(childCrossing.yogaNode.getDisplay()).toBe(DISPLAY_FLEX);
    output.unclip();
  });

  it('registers children of a parent straddling y2, keeping those crossing into the clip and culling those wholly below', () => {
    const output = new FakeOutput();
    output.clip({ y1: 10, y2: 20 });
    // Parent top: 15, height: 10 -> absolute top: 15, bottom: 25. Straddles y2 (15 < 20 && 25 > 20).
    // Child 0: top 1, height 3 -> absolute top: 16, bottom: 19 -> crossing into clip (16 < 20 && 19 > 10).
    // Child 1: top 5, height 3 -> absolute top: 20, bottom: 23 -> wholly below y2 (20 >= 20).
    const parent = rowWithChildren(15, 10, [
      { top: 1, height: 3 },
      { top: 5, height: 3 },
    ]);
    const [childCrossing, childBelow] = parent.childNodes!;
    cull.cullWhenOffscreen(parent);
    expect(parent.yogaNode.getDisplay()).toBe(DISPLAY_FLEX);
    expect(childCrossing.yogaNode.getDisplay()).toBe(DISPLAY_FLEX);
    expect(childBelow.yogaNode.getDisplay()).toBe(DISPLAY_NONE);
    output.unclip();
  });

  it('registers none of the children when the parent is wholly inside the clip', () => {
    const output = new FakeOutput();
    output.clip({ y1: 10, y2: 20 });
    // Parent top: 12, height: 6 -> absolute top: 12, bottom: 18 (12 >= 10 && 18 <= 20).
    const parent = rowWithChildren(12, 6, [
      { top: 0, height: 2 },
      { top: 2, height: 2 },
    ]);
    const [child1, child2] = parent.childNodes!;
    cull.cullWhenOffscreen(parent);
    expect(parent.yogaNode.getDisplay()).toBe(DISPLAY_FLEX);
    expect(Object.prototype.hasOwnProperty.call(child1.yogaNode, 'getDisplay')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(child2.yogaNode, 'getDisplay')).toBe(false);
    output.unclip();
  });

  it('registers none of the children when the parent is culled', () => {
    const output = new FakeOutput();
    output.clip({ y1: 10, y2: 20 });
    // Parent top: 2, height: 5 -> absolute top: 2, bottom: 7 <= 10 (culled wholly above).
    const parent = rowWithChildren(2, 5, [
      { top: 0, height: 2 },
      { top: 2, height: 2 },
    ]);
    const [child1, child2] = parent.childNodes!;
    cull.cullWhenOffscreen(parent);
    expect(parent.yogaNode.getDisplay()).toBe(DISPLAY_NONE);
    expect(Object.prototype.hasOwnProperty.call(child1.yogaNode, 'getDisplay')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(child2.yogaNode, 'getDisplay')).toBe(false);
    output.unclip();
  });

  it("memoizes ancestors' computed tops within a frame and recomputes across frames", () => {
    let ancestorTopReads = 0;
    const ancestorYoga = fakeYogaNode(0, 1);
    ancestorYoga.getComputedTop = () => {
      ancestorTopReads++;
      return 0;
    };
    const ancestor: FakeRowElement = {
      yogaNode: ancestorYoga,
      parentNode: null,
    };
    const parent = rowWithChildren(5, 10, [
      { top: 0, height: 4 },
      { top: 4, height: 4 },
    ]);
    parent.parentNode = ancestor;
    const [child1, child2] = parent.childNodes!;

    const output1 = new FakeOutput();
    output1.clip({ y1: 10, y2: 20 });
    cull.cullWhenOffscreen(parent);
    cull.cullWhenOffscreen(child1);
    cull.cullWhenOffscreen(child2);

    // Ink's walk calls getDisplay on parent, then child1, then child2:
    parent.yogaNode.getDisplay();
    child1.yogaNode.getDisplay();
    child2.yogaNode.getDisplay();

    expect(ancestorTopReads).toBe(1);

    // A new frame: Output.prototype.clip is called on a new Output instance:
    const output2 = new FakeOutput();
    output2.clip({ y1: 10, y2: 20 });

    parent.yogaNode.getDisplay();
    child1.yogaNode.getDisplay();
    child2.yogaNode.getDisplay();

    expect(ancestorTopReads).toBe(2);
  });
});

describe('installing the cull on Ink', () => {
  let Output: { new (options: { width: number; height: number }): InkOutput };
  let originalClip: (this: InkOutput, clip: InkClip) => void;
  let originalUnclip: (this: InkOutput) => void;

  beforeAll(async () => {
    // The same module `installInkRenderCull` reads: Ink's private output.js.
    const outputPath = join(inkBuildDir(), 'output.js');
    const outputModule = (await import(pathToFileURL(outputPath).href)) as {
      default: typeof Output;
    };
    Output = outputModule.default;
    originalClip = Output.prototype.clip;
    originalUnclip = Output.prototype.unclip;
  });

  afterEach(() => {
    // No case here may leave Ink patched for the next one, or for the contract tier beside it.
    Output.prototype.clip = originalClip;
    Output.prototype.unclip = originalUnclip;
  });

  it('stays off for every spelling of off in BOOK_INK_RENDER_CULL', async () => {
    for (const value of ['false', 'OFF', 'no', ' off ']) {
      expect(await installInkRenderCull({ BOOK_INK_RENDER_CULL: value })).toBe(false);
      // Not merely false: Ink's own clip and unclip are still the ones Ink shipped.
      expect(Output.prototype.clip).toBe(originalClip);
      expect(Output.prototype.unclip).toBe(originalUnclip);
    }
  });

  it("leaves a row's getDisplay untouched while the cull is off", () => {
    const rowElement = row(0, 1);
    // The exported registrar — the one the TUI calls — is inert until an install succeeds, and
    // every install so far in this file was refused by the environment.
    cullWhenOffscreen(rowElement);
    expect(Object.prototype.hasOwnProperty.call(rowElement.yogaNode, 'getDisplay')).toBe(false);
  });

  it('installs once, and reports a second install as already in place', async () => {
    expect(await installInkRenderCull({})).toBe(true);
    const wrapped = Output.prototype.clip;
    expect(wrapped).not.toBe(originalClip);
    expect(Output.prototype.unclip).not.toBe(originalUnclip);
    expect(await installInkRenderCull({})).toBe(true);
    expect(Output.prototype.clip).toBe(wrapped);
    expect(Output.prototype.unclip).not.toBe(originalUnclip);
    // The wrapped clip still records through Ink's own method, which is what `get` replays.
    const output = new Output({ width: 20, height: 10 });
    output.clip({ y1: 0, y2: 5 });
    expect(output.operations).toEqual([{ type: 'clip', clip: { y1: 0, y2: 5 } }]);
  });

  it('keeps the cull in place when a later call turns the environment off', async () => {
    expect(await installInkRenderCull({})).toBe(true);
    const wrapped = Output.prototype.clip;
    expect(await installInkRenderCull({ BOOK_INK_RENDER_CULL: 'off' })).toBe(true);
    expect(Output.prototype.clip).toBe(wrapped);
  });
});
