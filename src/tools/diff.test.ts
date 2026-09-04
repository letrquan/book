import { describe, expect, it } from 'vitest';
import {
  lineDiff,
  lineDiffAsync,
  renderDiff,
  renderDiffWithStats,
  renderDiffWithStatsAsync,
  diffStatsFromHunks,
} from './diff.js';

describe('diff stats', () => {
  it('counts added and removed lines from hunks', () => {
    const hunks = lineDiff('one\ntwo\nthree', 'one\nTWO\nthree\nfour');

    expect(diffStatsFromHunks(hunks)).toEqual({ addedLines: 2, removedLines: 1 });
  });

  it('renders the same diff string while returning stats', () => {
    const oldText = 'line1\nline2\nline3';
    const newText = 'line1\nLINE TWO\nline3\nline4';
    const { diff, stats } = renderDiffWithStats(oldText, newText);

    expect(diff).toBe(renderDiff(oldText, newText));
    expect(diff).toMatch(/^-line2$/m);
    expect(diff).toMatch(/^\+LINE TWO$/m);
    expect(diff).toMatch(/^\+line4$/m);
    expect(stats).toEqual({ addedLines: 2, removedLines: 1 });
  });

  it('returns an empty diff and zero stats when text is unchanged', () => {
    expect(renderDiffWithStats('same\ntext', 'same\ntext')).toEqual({
      diff: '',
      stats: { addedLines: 0, removedLines: 0 },
    });
  });

  it('preserves output while yielding during large async diffs', async () => {
    const oldText = Array.from({ length: 400 }, (_, index) => `old ${index}`).join('\n');
    const newText = Array.from({ length: 400 }, (_, index) => `new ${index}`).join('\n');
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 0);

    try {
      const asyncResult = await renderDiffWithStatsAsync(oldText, newText);
      expect(timerFired).toBe(true);
      expect(asyncResult).toEqual(renderDiffWithStats(oldText, newText));
    } finally {
      clearTimeout(timer);
    }
  });

  it('honors cancellation while building a large diff', async () => {
    const oldText = Array.from({ length: 500 }, (_, index) => `old ${index}`).join('\n');
    const newText = Array.from({ length: 500 }, (_, index) => `new ${index}`).join('\n');
    const controller = new AbortController();
    const pending = renderDiffWithStatsAsync(oldText, newText, 3, controller.signal);
    setTimeout(() => controller.abort(new Error('cancelled by test')), 0);

    await expect(pending).rejects.toThrow('cancelled by test');
  });
});

// Almost every real edit changes a few lines of a file that is otherwise the
// same on both sides; the LCS table used to be sized by the whole file anyway.
describe('common affix trimming', () => {
  it('yields the same hunk for a small edit deep in a large file', () => {
    const lines = Array.from({ length: 20_000 }, (_, index) => `line ${index + 1}`);
    const before = lines.join('\n') + '\n';
    const after =
      lines.map((line) => (line === 'line 10000' ? 'LINE 10000' : line)).join('\n') + '\n';
    const started = Date.now();
    const hunks = lineDiff(before, after);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 9_997, newStart: 9_997 });
    expect(hunks[0].lines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      'ctx:line 9997',
      'ctx:line 9998',
      'ctx:line 9999',
      'del:line 10000',
      'add:LINE 10000',
      'ctx:line 10001',
      'ctx:line 10002',
      'ctx:line 10003',
    ]);
  });

  it('keeps line numbers right when the change is at either end', () => {
    expect(lineDiff('a\nb\nc\n', 'A\nb\nc\n')[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    const tail = lineDiff('a\nb\nc\n', 'a\nb\nc\nd\n');
    expect(tail[0]).toMatchObject({ oldStart: 1, newStart: 1 });
    expect(tail[0].lines.at(-1)).toEqual({ kind: 'add', text: 'd' });
    const shrink = lineDiff('a\nb\nc\nd\n', 'a\nd\n');
    expect(shrink[0].lines.map((line) => line.kind)).toEqual(['ctx', 'del', 'del', 'ctx']);
    expect(shrink[0]).toMatchObject({ oldStart: 1, newStart: 1 });
  });

  it('matches the async variant', async () => {
    const before = 'x\n'.repeat(500) + 'middle\n' + 'y\n'.repeat(500);
    const after = 'x\n'.repeat(500) + 'MIDDLE\nextra\n' + 'y\n'.repeat(500);
    expect(await lineDiffAsync(before, after)).toEqual(lineDiff(before, after));
  });
});
