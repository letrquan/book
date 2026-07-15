import { describe, expect, it } from 'vitest';
import {
  lineDiff,
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
