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
  afterEach(() => setFrameSnapshotForTesting(null));

  it('records render and sync frames', () => {
    const base = createFakeBase();
    const renderer = createFrameCapturingRenderer(stream, undefined, () => base);

    renderer('line one\nline two\n');
    expect(getFrameLines()).toEqual(['line one', 'line two']);

    renderer.sync('synced');
    expect(getFrameLines()).toEqual(['synced']);
    expect(base.sync).toHaveBeenCalledWith('synced');
  });

  it('resets frames and tracks the active cursor', () => {
    const renderer = createFrameCapturingRenderer(stream, undefined, () => createFakeBase());

    renderer('x\n');
    renderer.setCursorPosition({ x: 3, y: 5 });
    expect(getLastCursorPosition()).toEqual({ x: 3, y: 5 });

    renderer.setCursorPosition(undefined);
    expect(getLastCursorPosition()).toBeNull();
    renderer.clear();
    expect(getFrameLines()).toEqual([]);
  });

  it('installs idempotently', async () => {
    await expect(installFrameCapture()).resolves.toBeUndefined();
    await expect(installFrameCapture()).resolves.toBeUndefined();
  });
});
