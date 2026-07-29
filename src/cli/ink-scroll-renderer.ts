import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface TranscriptScrollHint {
  top: number;
  bottom: number;
  delta: number;
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

let pendingHint: TranscriptScrollHint | null = null;
let rendererInstalled = false;

export function isInkScrollRendererEnabled(value?: string): boolean {
  return value === 'on';
}

export function setTranscriptScrollHint(hint: TranscriptScrollHint): void {
  if (!Number.isFinite(hint.delta) || hint.delta === 0) return;
  if (
    pendingHint &&
    pendingHint.top === hint.top &&
    pendingHint.bottom === hint.bottom &&
    Math.sign(pendingHint.delta) === Math.sign(hint.delta)
  ) {
    pendingHint = { ...pendingHint, delta: pendingHint.delta + hint.delta };
    return;
  }
  pendingHint = { ...hint };
}

function splitFrame(frame: string): string[] {
  return frame.endsWith('\n') ? frame.slice(0, -1).split('\n') : frame.split('\n');
}

function getFrameEndRow(frame: string, visibleLineCount: number): number {
  return visibleLineCount + (frame.endsWith('\n') ? 1 : 0);
}

function cursorTo(row: number): string {
  return `\x1b[${Math.max(1, Math.floor(row))};1H`;
}

function setScrollRegion(top: number, bottom: number): string {
  return `\x1b[${Math.max(1, Math.floor(top))};${Math.max(1, Math.floor(bottom))}r`;
}

export function isPureVerticalShift(
  previousLines: readonly string[],
  nextLines: readonly string[],
  hint: TranscriptScrollHint,
): boolean {
  if (previousLines.length !== nextLines.length) return false;
  const top = Math.floor(hint.top) - 1;
  const bottom = Math.floor(hint.bottom);
  const delta = Math.trunc(hint.delta);
  if (top < 0 || bottom > nextLines.length || bottom - top < 2) return false;
  if (Math.abs(delta) >= bottom - top) return false;

  for (let row = 0; row < top; row++) {
    if (previousLines[row] !== nextLines[row]) return false;
  }
  for (let row = bottom; row < nextLines.length; row++) {
    if (previousLines[row] !== nextLines[row]) return false;
  }

  if (delta > 0) {
    for (let row = top; row < bottom - delta; row++) {
      if (nextLines[row] !== previousLines[row + delta]) return false;
    }
  } else {
    const distance = Math.abs(delta);
    for (let row = top + distance; row < bottom; row++) {
      if (nextLines[row] !== previousLines[row - distance]) return false;
    }
  }
  return true;
}

function writeExposedRows(
  stream: InkStream,
  lines: readonly string[],
  top: number,
  bottom: number,
  delta: number,
): void {
  const distance = Math.abs(delta);
  const first = delta > 0 ? bottom - distance : top;
  for (let offset = 0; offset < distance; offset++) {
    const row = first + offset;
    stream.write(cursorTo(row + 1) + (lines[row] ?? '') + '\x1b[K');
  }
}

function createScrollAwareRenderer(
  stream: InkStream,
  options: { incremental?: boolean } | undefined,
  createBase: LogUpdateModule['create'],
): LogUpdateRenderer {
  const base = createBase(stream, options);
  let previousFrame = '';

  const render = ((output: string) => {
    const hint = pendingHint;
    pendingHint = null;
    const previousLines = splitFrame(previousFrame);
    const nextLines = splitFrame(output);
    const terminalRows = stream.rows ?? 0;
    const frameEndRow = getFrameEndRow(output, nextLines.length);
    const canScroll =
      Boolean(stream.isTTY) &&
      terminalRows > 0 &&
      frameEndRow <= terminalRows &&
      previousFrame.length > 0 &&
      hint !== null &&
      hint.bottom <= nextLines.length &&
      isPureVerticalShift(previousLines, nextLines, hint);

    if (canScroll && hint) {
      const top = Math.floor(hint.top);
      const bottom = Math.floor(hint.bottom);
      const delta = Math.trunc(hint.delta);
      stream.write('\x1b[?25l' + setScrollRegion(top, bottom));
      stream.write(`\x1b[${Math.abs(delta)}${delta > 0 ? 'S' : 'T'}`);
      writeExposedRows(stream, nextLines, top - 1, bottom, delta);
      // Ink's sync() positions the input cursor relative to the frame bottom.
      // Re-anchor there first so its cursor suffix cannot repaint the prompt on
      // a transcript row after a terminal-native scroll.
      stream.write(setScrollRegion(1, terminalRows) + cursorTo(frameEndRow));
      previousFrame = output;
      base.sync(output);
      return true;
    }

    previousFrame = output;
    return base(output);
  }) as LogUpdateRenderer;

  render.clear = () => {
    pendingHint = null;
    previousFrame = '';
    base.clear();
  };
  render.done = () => {
    pendingHint = null;
    previousFrame = '';
    base.done();
  };
  render.sync = (output: string) => {
    pendingHint = null;
    previousFrame = output;
    base.sync(output);
  };
  render.setCursorPosition = (position: unknown) => base.setCursorPosition(position);
  render.isCursorDirty = () => base.isCursorDirty();
  render.willRender = (output: string) => {
    const shouldRender = base.willRender(output);
    if (!shouldRender) pendingHint = null;
    return shouldRender;
  };
  return render;
}

export async function installInkScrollRenderer(enabled?: boolean): Promise<void> {
  if (rendererInstalled) return;
  // DECSTBM/CSI S/T rendering remains available for profiling, but Windows
  // ConPTY can corrupt fixed footer rows after a later incremental repaint.
  if (!(enabled ?? isInkScrollRendererEnabled(process.env.BOOK_SCROLL_RENDERER))) return;
  rendererInstalled = true;

  try {
    const require = createRequire(import.meta.url);
    const inkEntry = require.resolve('ink');
    const logUpdateUrl = pathToFileURL(join(dirname(inkEntry), 'log-update.js')).href;
    const module = (await import(logUpdateUrl)) as { default: LogUpdateModule };
    const logUpdate = module.default;
    const createBase = logUpdate.create;
    logUpdate.create = (stream, options) => createScrollAwareRenderer(stream, options, createBase);
  } catch {
    // Keep Ink's built-in renderer when its internal module layout changes.
  }
}
