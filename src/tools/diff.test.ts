import { describe, expect, it } from 'vitest';
import { lineDiff, renderDiff, renderDiffWithStats, diffStatsFromHunks } from './diff.js';

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
});
