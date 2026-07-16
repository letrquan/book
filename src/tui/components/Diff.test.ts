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
  it('parses a unified diff into one row per source line', () => {
    const output = [
      '@@ -1,3 +1,4 @@',
      ' unchanged',
      '-deleted line',
      '+added line',
      ' more unchanged',
    ].join('\n');

    const lines = parseDiffLines(output);
    expect(lines.map((line) => line.kind)).toEqual(['hunk', 'ctx', 'del', 'add', 'ctx']);
    expect(lines).toHaveLength(output.split('\n').length);
  });

  it('keeps CC-style word-level markers inline on their parent row', () => {
    const output = ['@@ -1 +1 @@', '-original text', '+modified {-text-}{+content+}'].join('\n');

    const lines = parseDiffLines(output);
    const changed = lines[2];

    expect(lines).toHaveLength(3);
    expect(changed.kind).toBe('add');
    expect(changed.spans).toEqual([
      { text: '+modified ', kind: 'plain' },
      { text: 'text', kind: 'removedWord' },
      { text: 'content', kind: 'addedWord' },
    ]);
  });

  it('handles empty and context-only input', () => {
    expect(parseDiffLines('')).toEqual([]);
    expect(parseDiffLines('just\nsome\ncontext').every((line) => line.kind === 'ctx')).toBe(true);
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

  it('renders word-level markers on one content row', () => {
    const output = '@@ -1 +1 @@\n-old\n+new {+value+}';
    const view = render(withTheme(React.createElement(DiffBlock, { output })));
    const rows = frame(view.lastFrame)
      .split('\n')
      .filter((row) => row.trim().length > 0);

    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain('+new value');
  });

  it('keeps the configured background-token palette for added and removed lines', () => {
    expect(DEFAULT_THEME.diffRemoved).toBe('#3b1818');
    expect(DEFAULT_THEME.diffAdded).toBe('#12351f');
  });

  it('uses display-width truncation for long diff lines', () => {
    const longLine = '+' + 'x'.repeat(160);
    const view = render(
      withTheme(React.createElement(DiffBlock, { output: `@@ -1 +1 @@\n-old\n${longLine}` })),
    );
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('…');
    expect(
      displayWidth(rendered.split('\n').find((part) => part.includes('…')) ?? ''),
    ).toBeLessThanOrEqual(120);
  });

  it('honors a narrow terminal width including indentation and prefix', () => {
    const width = 32;
    const output = `@@ -1 +1 @@\n-${'old'.repeat(30)}\n+${'新🙂'.repeat(30)}`;
    const view = render(
      withTheme(React.createElement(DiffBlock, { output, terminalWidth: width })),
    );

    for (const line of frame(view.lastFrame).split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
