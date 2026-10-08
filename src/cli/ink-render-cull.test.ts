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
}

/** A row under a root box whose own top is zero, so the row's top is its absolute top. */
function row(top: number, height: number, display = DISPLAY_FLEX): FakeRowElement {
  return {
    yogaNode: fakeYogaNode(top, height, display),
    parentNode: { yogaNode: fakeYogaNode(0, 1), parentNode: null },
  };
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
