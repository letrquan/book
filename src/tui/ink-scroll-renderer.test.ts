import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  installInkScrollRenderer,
  isPureVerticalShift,
  setTranscriptScrollHint,
} from './ink-scroll-renderer.js';

describe('ink scroll renderer', () => {
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
        ) => (output: string) => void;
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
    baseline(previousFrame);
    const beforeBaselineShift = baselineWrites.length;
    baseline(nextFrame);
    const baselineOutput = baselineWrites.slice(beforeBaselineShift).join('');

    await installInkScrollRenderer();
    const writes: string[] = [];
    const log = logUpdateModule.default.create(
      {
        isTTY: true,
        rows: 5,
        write: (value) => writes.push(value),
      },
      { incremental: true },
    );

    log(previousFrame);
    const beforeShift = writes.length;
    setTranscriptScrollHint({ top: 2, bottom: 5, delta: 1 });
    log(nextFrame);

    const shiftOutput = writes.slice(beforeShift).join('');
    expect(shiftOutput).toContain('\x1b[2;5r');
    expect(shiftOutput).toContain('\x1b[1S');
    expect(shiftOutput).toContain('E');
    expect(Buffer.byteLength(shiftOutput)).toBeLessThan(Buffer.byteLength(baselineOutput));
  });
});
