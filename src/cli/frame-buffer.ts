import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface FrameCursorPosition {
  x: number;
  y: number;
}

interface InkStream {
  isTTY?: boolean;
  rows?: number;
  write: (data: string) => unknown;
}

interface LogUpdateRenderer {
  (output: string): boolean | void;
  clear: () => void;
  done: () => void;
  sync: (output: string) => void;
  setCursorPosition: (position: unknown) => void;
  isCursorDirty: () => boolean;
  willRender: (output: string) => boolean;
}

interface LogUpdateModule {
  create: (stream: InkStream, options?: { incremental?: boolean }) => LogUpdateRenderer;
}

let latestFrame = '';
let lastCursorPosition: FrameCursorPosition | null = null;
let captureInstalled = false;

function splitFrame(frame: string): string[] {
  return frame.endsWith('\n') ? frame.slice(0, -1).split('\n') : frame.split('\n');
}

function toCursorPosition(position: unknown): FrameCursorPosition | null {
  if (!position || typeof position !== 'object') return null;
  const candidate = position as { x?: unknown; y?: unknown };
  if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') return null;
  return { x: candidate.x, y: candidate.y };
}

/** Lines of the most recently rendered full-screen frame. */
export function getFrameLines(): string[] {
  return latestFrame.length === 0 ? [] : splitFrame(latestFrame);
}

/** Last cursor position Ink asked the renderer to restore, if any. */
export function getLastCursorPosition(): FrameCursorPosition | null {
  return lastCursorPosition;
}

/** Override the captured snapshot. Used by focused selection tests. */
export function setFrameSnapshotForTesting(
  frame: string | null,
  cursor: FrameCursorPosition | null = null,
): void {
  latestFrame = frame ?? '';
  lastCursorPosition = cursor;
}

export function createFrameCapturingRenderer(
  stream: InkStream,
  options: { incremental?: boolean } | undefined,
  createBase: LogUpdateModule['create'],
): LogUpdateRenderer {
  const base = createBase(stream, options);

  const render = ((output: string) => {
    latestFrame = output;
    return base(output);
  }) as LogUpdateRenderer;

  render.clear = () => {
    latestFrame = '';
    base.clear();
  };
  render.done = () => {
    latestFrame = '';
    lastCursorPosition = null;
    base.done();
  };
  render.sync = (output: string) => {
    latestFrame = output;
    base.sync(output);
  };
  render.setCursorPosition = (position: unknown) => {
    lastCursorPosition = toCursorPosition(position);
    base.setCursorPosition(position);
  };
  render.isCursorDirty = () => base.isCursorDirty();
  render.willRender = (output: string) => base.willRender(output);
  return render;
}

/** Capture Ink's latest full frame so mouse selection can extract visible text. */
export async function installFrameCapture(): Promise<void> {
  if (captureInstalled) return;
  captureInstalled = true;

  try {
    const require = createRequire(import.meta.url);
    const inkEntry = require.resolve('ink');
    const logUpdateUrl = pathToFileURL(join(dirname(inkEntry), 'log-update.js')).href;
    const module = (await import(logUpdateUrl)) as { default: LogUpdateModule };
    const logUpdate = module.default;
    const createBase = logUpdate.create;
    logUpdate.create = (stream, options) =>
      createFrameCapturingRenderer(stream, options, createBase);
  } catch {
    // Keep the TUI usable if Ink changes its private renderer layout.
  }
}
