import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFrameCapturingRenderer,
  getFrameLines,
  getLastCursorPosition,
  installFrameCapture,
  setFrameSnapshotForTesting,
} from './frame-buffer.js';

const stream = { write: () => true };

function createFakeBase() {
  return Object.assign(vi.fn(), {
    clear: vi.fn(),
    done: vi.fn(),
    sync: vi.fn(),
    setCursorPosition: vi.fn(),
    isCursorDirty: vi.fn(() => false),
    willRender: vi.fn(() => true),
  });
}

describe('frame buffer', () => {
  afterEach(() => {
    setFrameSnapshotForTesting(null);
  });

  it('starts empty and honors the test seam', () => {
    expect(getFrameLines()).toEqual([]);
    expect(getLastCursorPosition()).toBeNull();

    setFrameSnapshotForTesting('a\nb\n', { x: 1, y: 2 });
    expect(getFrameLines()).toEqual(['a', 'b']);
    expect(getLastCursorPosition()).toEqual({ x: 1, y: 2 });
  });

  it('records frames rendered through the wrapper', () => {
    const base = createFakeBase();
    const renderer = createFrameCapturingRenderer(stream, undefined, () => base);

    renderer('line one\nline two\n');
    expect(getFrameLines()).toEqual(['line one', 'line two']);
    expect(base).toHaveBeenCalledWith('line one\nline two\n');

    renderer.sync('synced');
    expect(getFrameLines()).toEqual(['synced']);
    expect(base.sync).toHaveBeenCalledWith('synced');
  });

  it('resets the snapshot on clear and done', () => {
    const renderer = createFrameCapturingRenderer(stream, undefined, () => createFakeBase());

    renderer('x\n');
    renderer.clear();
    expect(getFrameLines()).toEqual([]);

    renderer('y\n');
    renderer.done();
    expect(getFrameLines()).toEqual([]);
  });

  it('records the requested cursor position and delegates it', () => {
    const base = createFakeBase();
    const renderer = createFrameCapturingRenderer(stream, undefined, () => base);

    renderer.setCursorPosition({ x: 3, y: 5 });
    expect(getLastCursorPosition()).toEqual({ x: 3, y: 5 });
    expect(base.setCursorPosition).toHaveBeenCalledWith({ x: 3, y: 5 });

    renderer.setCursorPosition(undefined);
    expect(getLastCursorPosition()).toEqual({ x: 3, y: 5 });
  });

  it('keeps recording when composed over another wrapper', () => {
    const base = createFakeBase();
    const inner = (
      s: { isTTY?: boolean; rows?: number; write: (data: string) => unknown },
      o?: { incremental?: boolean },
    ) => createFrameCapturingRenderer(s, o, () => base);
    const outer = createFrameCapturingRenderer(stream, undefined, inner);

    outer('composed\n');
    expect(getFrameLines()).toEqual(['composed']);
    expect(base).toHaveBeenCalledWith('composed\n');
  });

  it('installs without throwing and is idempotent', async () => {
    await expect(installFrameCapture()).resolves.toBeUndefined();
    await expect(installFrameCapture()).resolves.toBeUndefined();
  });
});
