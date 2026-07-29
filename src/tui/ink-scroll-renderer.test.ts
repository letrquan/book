import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  installInkScrollRenderer,
  isInkScrollRendererEnabled,
  isPureVerticalShift,
  setTranscriptScrollHint,
} from './ink-scroll-renderer.js';

describe('ink scroll renderer', () => {
  it('keeps terminal-native scrolling opt-in', () => {
    expect(isInkScrollRendererEnabled(undefined)).toBe(false);
    expect(isInkScrollRendererEnabled('off')).toBe(false);
    expect(isInkScrollRendererEnabled('on')).toBe(true);
  });

  it('recognizes a shift confined to the transcript region', () => {
    expect(
      isPureVerticalShift(
        ['header', 'A', 'B', 'C', 'D', 'footer'],
        ['header', 'B', 'C', 'D', 'E', 'footer'],
        { top: 2, bottom: 5, delta: 1 },
      ),
    ).toBe(true);
  });

  it('rejects changes outside the scroll region and unrelated frame changes', () => {
    expect(
      isPureVerticalShift(
        ['header', 'A', 'B', 'C', 'D', 'footer'],
        ['changed', 'B', 'C', 'D', 'E', 'footer'],
        { top: 2, bottom: 5, delta: 1 },
      ),
    ).toBe(false);
    expect(
      isPureVerticalShift(
        ['header', 'A', 'B', 'C', 'D', 'footer'],
        ['header', 'A', 'B', 'X', 'D', 'footer'],
        { top: 2, bottom: 5, delta: 1 },
      ),
    ).toBe(false);
  });

  it('emits a terminal scroll operation for a safe transcript shift', async () => {
    const require = createRequire(import.meta.url);
    const logUpdateModule = (await import(
      pathToFileURL(join(dirname(require.resolve('ink')), 'log-update.js')).href
    )) as {
      default: {
        create: (
          stream: {
            isTTY: boolean;
            rows: number;
            write: (value: string) => void;
          },
          options?: { incremental?: boolean },
        ) => ((output: string) => void) & {
          setCursorPosition: (position: { x: number; y: number }) => void;
        };
      };
    };
    const lines = (values: string[]) => values.join('\n');
    const previousFrame = lines(['header', 'A', 'B', 'C', 'D']);
    const nextFrame = lines(['header', 'B', 'C', 'D', 'E']);

    const baselineWrites: string[] = [];
    const baseline = logUpdateModule.default.create(
      {
        isTTY: true,
        rows: 5,
        write: (value) => baselineWrites.push(value),
      },
      { incremental: true },
    );
    baseline.setCursorPosition({ x: 2, y: 4 });
    baseline(previousFrame);
    const beforeBaselineShift = baselineWrites.length;
    baseline.setCursorPosition({ x: 2, y: 4 });
    baseline(nextFrame);
    const baselineOutput = baselineWrites.slice(beforeBaselineShift).join('');

    const previousScrollRenderer = process.env.BOOK_SCROLL_RENDERER;
    process.env.BOOK_SCROLL_RENDERER = 'on';
    await installInkScrollRenderer();
    if (previousScrollRenderer === undefined) delete process.env.BOOK_SCROLL_RENDERER;
    else process.env.BOOK_SCROLL_RENDERER = previousScrollRenderer;
    const writes: string[] = [];
    const log = logUpdateModule.default.create(
      {
        isTTY: true,
        rows: 5,
        write: (value) => writes.push(value),
      },
      { incremental: true },
    );

    log.setCursorPosition({ x: 2, y: 4 });
    log(previousFrame);
    const beforeShift = writes.length;
    setTranscriptScrollHint({ top: 2, bottom: 5, delta: 1 });
    log.setCursorPosition({ x: 2, y: 4 });
    log(nextFrame);

    const shiftOutput = writes.slice(beforeShift).join('');
    expect(shiftOutput).toContain('\x1b[2;5r');
    expect(shiftOutput).toContain('\x1b[1S');
    expect(shiftOutput).toContain('E');
    expect(shiftOutput).toContain('\x1b[1;5r\x1b[5;1H\x1b[1A');
    expect(shiftOutput).not.toContain('\x1b7');
    expect(shiftOutput).not.toContain('\x1b8');
    expect(Buffer.byteLength(shiftOutput)).toBeLessThan(Buffer.byteLength(baselineOutput));
  });

  it('reanchors below a trailing newline before Ink renders the next frame', async () => {
    const require = createRequire(import.meta.url);
    const logUpdateModule = (await import(
      pathToFileURL(join(dirname(require.resolve('ink')), 'log-update.js')).href
    )) as {
      default: {
        create: (
          stream: {
            isTTY: boolean;
            rows: number;
            write: (value: string) => void;
          },
          options?: { incremental?: boolean },
        ) => (output: string) => void;
      };
    };
    await installInkScrollRenderer();

    const writes: string[] = [];
    const log = logUpdateModule.default.create(
      {
        isTTY: true,
        rows: 6,
        write: (value) => writes.push(value),
      },
      { incremental: true },
    );
    log('header\nA\nB\nC\nD\n');

    const beforeShift = writes.length;
    setTranscriptScrollHint({ top: 2, bottom: 5, delta: 1 });
    log('header\nB\nC\nD\nE\n');

    const shiftOutput = writes.slice(beforeShift).join('');
    expect(shiftOutput).toContain('\x1b[1;6r\x1b[6;1H');
    expect(shiftOutput).not.toContain('\x1b[1;6r\x1b[5;1H');
  });
});
