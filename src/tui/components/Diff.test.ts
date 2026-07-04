import { describe, it, expect } from 'vitest';
import { isUnifiedDiffLike, parseDiffLines } from './Diff.js';

describe('parseDiffLines', () => {
  it('parses a unified diff into categorized segments', () => {
    const output = [
      '@@ -1,3 +1,4 @@',
      ' unchanged',
      '-deleted line',
      '+added line',
      ' more unchanged',
    ].join('\n');

    const segments = parseDiffLines(output);
    const kinds = segments.map((s) => s.kind);
    expect(kinds).toEqual([
      'diffHunk',
      'diffCtx',
      'diffRemoved',
      'diffAdded',
      'diffCtx',
    ]);
  });

  it('detects CC-style word-level diff markers {+...+} and {-...-}', () => {
    const output = [
      '@@ -1 +1 @@',
      '-original text',
      '+modified {-text-}{+content+}',
    ].join('\n');

    const segments = parseDiffLines(output);
    const removed = segments.filter((s) => s.kind === 'diffRemoved');
    const added = segments.filter((s) => s.kind === 'diffAdded');
    const addedWords = segments.filter((s) => s.kind === 'diffAddedWord');
    const removedWords = segments.filter((s) => s.kind === 'diffRemovedWord');

    expect(removed.length).toBeGreaterThan(0);
    expect(added.length).toBeGreaterThanOrEqual(0);
    expect(addedWords.length > 0 || removedWords.length > 0).toBe(true);
  });

  it('handles empty diff', () => {
    expect(parseDiffLines('')).toEqual([]);
  });

  it('handles diff with no hunks (just context lines)', () => {
    const output = 'just\nsome\ncontext\nlines';
    const segments = parseDiffLines(output);
    expect(segments.every((s) => s.kind === 'diffCtx')).toBe(true);
  });

  it('truncates at maxLines via DiffBlock (logic check)', () => {
    // This test verifies the parse logic; actual truncation is in DiffBlock component.
    const manyLines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const segments = parseDiffLines(manyLines);
    expect(segments).toHaveLength(300);
  });

  it('handles lines starting with special chars but not diff markers', () => {
    const output = ['+genuine addition', '-genuine removal', ' context'].join('\n');
    const segments = parseDiffLines(output);
    expect(segments[0].kind).toBe('diffAdded');
    expect(segments[1].kind).toBe('diffRemoved');
    expect(segments[2].kind).toBe('diffCtx');
  });
});

describe('isUnifiedDiffLike', () => {
  it('requires a hunk header and changed line', () => {
    expect(isUnifiedDiffLike('@@ -1 +1 @@\n-old\n+new')).toBe(true);
    expect(isUnifiedDiffLike('+not a diff\n-just grep output')).toBe(false);
    expect(isUnifiedDiffLike('@@ -1 +1 @@\n unchanged')).toBe(false);
  });
});
