import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { countScreenOccurrences, replayTerminalOutput } from './terminal-screen.js';

interface InkLogUpdate {
  create: (
    stream: { isTTY: boolean; rows: number; write: (value: string) => void },
    options?: { incremental?: boolean; showCursor?: boolean },
  ) => (output: string) => void;
}

async function loadInkLogUpdate(): Promise<InkLogUpdate> {
  const require = createRequire(import.meta.url);
  const module = (await import(
    pathToFileURL(join(dirname(require.resolve('ink')), 'log-update.js')).href
  )) as { default: InkLogUpdate };
  return module.default;
}

describe('terminal screen replay', () => {
  it('keeps a trailing-newline incremental update on its original rows', async () => {
    const logUpdate = await loadInkLogUpdate();
    const writes: string[] = [];
    const log = logUpdate.create(
      { isTTY: true, rows: 8, write: (value) => writes.push(value) },
      { incremental: true, showCursor: true },
    );

    log('Line 1\nLine 2\nLine 3\n');
    const updateStart = writes.length;
    log('Line 1\nUpdated\nLine 3\n');

    expect(writes.slice(updateStart).join('')).toMatch(/^\x1b\[3A/);
    const screen = await replayTerminalOutput(writes.join(''), { rows: 8 });
    expect(screen.slice(0, 3)).toEqual(['Line 1', 'Updated', 'Line 3']);
    expect(countScreenOccurrences(screen, 'Line 1')).toBe(1);
    expect(countScreenOccurrences(screen, 'Line 3')).toBe(1);
  });

  it('replaces prompt and activity rows instead of appending duplicates', async () => {
    const logUpdate = await loadInkLogUpdate();
    const writes: string[] = [];
    const log = logUpdate.create(
      { isTTY: true, rows: 10, write: (value) => writes.push(value) },
      { incremental: true, showCursor: true },
    );

    log('Transcript\nWorking 0s\n> Ask Book\n');
    log('Transcript\nWorking 1s\n> Ask Book\n');
    log('Transcript\nWorking 2s\n> Ask Book\n');

    const screen = await replayTerminalOutput(writes.join(''), { rows: 10 });
    expect(countScreenOccurrences(screen, '> Ask Book')).toBe(1);
    expect(countScreenOccurrences(screen, 'Working 0s')).toBe(0);
    expect(countScreenOccurrences(screen, 'Working 1s')).toBe(0);
    expect(countScreenOccurrences(screen, 'Working 2s')).toBe(1);
  });

  it.each([false, true])(
    'keeps a fixed input footer after repeated deep scrolling (incremental=%s)',
    async (incremental) => {
      const logUpdate = await loadInkLogUpdate();
      const writes: string[] = [];
      const log = logUpdate.create(
        { isTTY: true, rows: 30, write: (value) => writes.push(value) },
        { incremental, showCursor: true },
      );
      const transcript = Array.from(
        { length: 120 },
        (_, index) => `Transcript row ${String(index).padStart(3, '0')}`,
      );
      const frame = (scrollTop: number, tick: number) =>
        [
          `History position ${scrollTop} tick ${tick}`,
          ...transcript.slice(scrollTop, scrollTop + 20),
          '╭────────────────────────────────────────────────────────────╮',
          '│ › INPUT_FOOTER_SENTINEL                                    │',
          '╰────────────────────────────────────────────────────────────╯',
          'accept edits  model  ctx 0%',
        ].join('\n') + '\n';

      log(frame(96, 0));
      for (let tick = 1; tick <= 48; tick++) {
        log(frame(96 - tick * 2, tick));
      }

      const screen = await replayTerminalOutput(writes.join(''), { cols: 80, rows: 30 });
      expect(screen.filter((line) => line.includes('INPUT_FOOTER_SENTINEL'))).toHaveLength(1);
      expect(screen).toContain('╭────────────────────────────────────────────────────────────╮');
      expect(screen).toContain('╰────────────────────────────────────────────────────────────╯');
      expect(screen).toContain('accept edits  model  ctx 0%');
    },
  );
});
