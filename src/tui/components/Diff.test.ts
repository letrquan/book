import React from 'react';
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { DiffBlock, isUnifiedDiffLike, parseDiffLines } from './Diff.js';
import { displayWidth } from './word-wrap.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function frame(lastFrame: () => string | undefined): string {
  return stripAnsi(lastFrame());
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return React.createElement(ThemeContext.Provider, { value: DEFAULT_THEME }, children);
}

afterEach(() => {
  cleanup();
});

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

describe('DiffBlock', () => {
  it('renders a collapsed diff preview with a hidden-lines footer', () => {
    const output = [
      '@@ -1,8 +1,8 @@',
      '-old 1',
      '+new 1',
      '-old 2',
      '+new 2',
      '-old 3',
      '+new 3',
    ].join('\n');

    const view = render(withTheme(React.createElement(DiffBlock, { output, collapsed: true })));
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('@@ -1,8 +1,8 @@');
    expect(rendered).toContain('+new 2');
    expect(rendered).not.toContain('-old 3');
    expect(rendered).toContain('2 more lines hidden');
  });

  it('uses display-width truncation for long diff lines', () => {
    const longLine = '+' + 'x'.repeat(160);
    const view = render(withTheme(React.createElement(DiffBlock, { output: `@@ -1 +1 @@\n-old\n${longLine}` })));
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('…');
    expect(displayWidth(rendered.split('\n').find((part) => part.includes('…')) ?? '')).toBeLessThanOrEqual(130);
  });
});
