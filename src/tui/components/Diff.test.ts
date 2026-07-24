import React from 'react';
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { DiffBlock, inferDiffLanguage, isUnifiedDiffLike, parseDiffLines } from './Diff.js';
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
    expect(lines[1]).toMatchObject({ oldLineNumber: 1, newLineNumber: 1, marker: ' ' });
    expect(lines[2]).toMatchObject({ oldLineNumber: 2, marker: '-' });
    expect(lines[3]).toMatchObject({ newLineNumber: 2, marker: '+' });
    expect(lines[4]).toMatchObject({ oldLineNumber: 3, newLineNumber: 3 });
  });

  it('keeps CC-style word-level markers inline on their parent row', () => {
    const output = ['@@ -1 +1 @@', '-original text', '+modified {-text-}{+content+}'].join('\n');

    const lines = parseDiffLines(output);
    const changed = lines[2];

    expect(lines).toHaveLength(3);
    expect(changed.kind).toBe('add');
    expect(changed.spans).toEqual([
      { text: 'modified ', kind: 'plain' },
      { text: 'text', kind: 'removedWord' },
      { text: 'content', kind: 'addedWord' },
    ]);
  });

  it('handles empty and context-only input', () => {
    expect(parseDiffLines('')).toEqual([]);
    expect(parseDiffLines('just\nsome\ncontext').every((line) => line.kind === 'ctx')).toBe(true);
  });

  it('supports standard file headers, multiple hunks, and missing final newline markers', () => {
    const output = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -2,2 +2,2 @@',
      ' keep',
      '-old',
      '+new',
      '@@ -20 +21 @@',
      '-last',
      '+final',
      '\\ No newline at end of file',
    ].join('\n');
    const lines = parseDiffLines(output);

    expect(lines.slice(0, 2).every((line) => line.kind === 'meta')).toBe(true);
    expect(lines[3]).toMatchObject({ oldLineNumber: 2, newLineNumber: 2 });
    expect(lines[4]).toMatchObject({ oldLineNumber: 3 });
    expect(lines[5]).toMatchObject({ newLineNumber: 3 });
    expect(lines[7]).toMatchObject({ oldLineNumber: 20 });
    expect(lines[8]).toMatchObject({ newLineNumber: 21 });
    expect(lines[9]).toMatchObject({ kind: 'meta', marker: '\\' });
  });

  it('does not confuse changed content beginning with diff header punctuation', () => {
    const lines = parseDiffLines('@@ -1 +1 @@\n---old flag\n+++new flag');
    expect(lines[1]).toMatchObject({ kind: 'del', content: '--old flag' });
    expect(lines[2]).toMatchObject({ kind: 'add', content: '++new flag' });
  });

  it('calculates bounded token-level spans for adjacent replacements', () => {
    const lines = parseDiffLines(
      '@@ -1 +1 @@\n-const count = total + 1;\n+const count = subtotal + 2;',
    );

    expect(lines[1].spans).toContainEqual({ text: 'total', kind: 'removedWord' });
    expect(lines[2].spans).toContainEqual({ text: 'subtotal', kind: 'addedWord' });
    expect(lines[2].spans).toContainEqual({ text: '2', kind: 'addedWord' });
  });
});

describe('isUnifiedDiffLike', () => {
  it('requires a hunk header and changed line', () => {
    expect(isUnifiedDiffLike('@@ -1 +1 @@\n-old\n+new')).toBe(true);
    expect(isUnifiedDiffLike('@@ -1 +1 @@\n-\n+')).toBe(true);
    expect(isUnifiedDiffLike('+not a diff\n-just grep output')).toBe(false);
    expect(isUnifiedDiffLike('@@ -1 +1 @@\n unchanged')).toBe(false);
  });
});

describe('DiffBlock', () => {
  it('shows all rows for a normal-sized collapsed diff', () => {
    const output = [
      '@@ -1,8 +1,8 @@',
      '-old 1',
      '+new 1',
      '-old 2',
      '+new 2',
      '-old 3',
      '+new 3',
      '-old 4',
      '+new 4',
    ].join('\n');

    const view = render(withTheme(React.createElement(DiffBlock, { output, collapsed: true })));
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('@@ -1,8 +1,8 @@');
    expect(rendered).toContain('+ new 2');
    expect(rendered).toContain('- old 4');
    expect(rendered).not.toContain('rows omitted');
  });

  it('keeps changes from every hunk while trimming low-value context', () => {
    const hunk = (number: number) => [
      `@@ -${number * 100 + 1},51 +${number * 100 + 1},51 @@`,
      ...Array.from({ length: 25 }, (_, index) => ` context before ${number}-${index}`),
      `-old value ${number}`,
      `+new value ${number}`,
      ...Array.from({ length: 25 }, (_, index) => ` context after ${number}-${index}`),
    ];
    const output = [...hunk(1), ...hunk(2), ...hunk(3)].join('\n');
    const view = render(withTheme(React.createElement(DiffBlock, { output, collapsed: true })));
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('- old value 1');
    expect(rendered).toContain('+ new value 2');
    expect(rendered).toContain('- old value 3');
    expect(rendered).not.toContain('context before 1-10');
    expect(rendered).toContain('rows omitted');
    expect(rendered).toContain('Ctrl+E shows all');
  });

  it('renders word-level markers on one content row', () => {
    const output = '@@ -1 +1 @@\n-old\n+new {+value+}';
    const view = render(withTheme(React.createElement(DiffBlock, { output })));
    const rows = frame(view.lastFrame)
      .split('\n')
      .filter((row) => row.trim().length > 0);

    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain('+ new value');
  });

  it('keeps the configured background-token palette for added and removed lines', () => {
    expect(DEFAULT_THEME.diffRemoved).toBe('#382624');
    expect(DEFAULT_THEME.diffAdded).toBe('#243326');
  });

  it('wraps long diff lines without hiding content', () => {
    const longLine = `+start-${'x'.repeat(70)}-finish`;
    const width = 40;
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output: `@@ -1 +1 @@\n-old\n${longLine}`,
          terminalWidth: width,
        }),
      ),
    );
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('start-');
    expect(rendered).toContain('-finish');
    expect(rendered).not.toContain('…');
    for (const line of rendered.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(width);
  });

  it('honors a narrow terminal width including indentation and prefix', () => {
    const width = 32;
    const output = `@@ -1 +1 @@\n-${'old'.repeat(30)}-removed-end\n+${'新🙂'.repeat(30)}終点🙂`;
    const view = render(
      withTheme(React.createElement(DiffBlock, { output, terminalWidth: width })),
    );
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('emoved-end');
    expect(rendered).toContain('終点🙂');
    expect(rendered).not.toContain('…');
    expect([...rendered].filter((character) => character === '新')).toHaveLength(30);
    expect([...rendered].filter((character) => character === '🙂')).toHaveLength(31);
    for (const line of rendered.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it('renders tabs and Unicode within the width budget while keeping both gutters', () => {
    const width = 24;
    const output = '@@ -98 +103 @@\n-\told🙂value\n+\tnew界value';
    const view = render(
      withTheme(React.createElement(DiffBlock, { output, terminalWidth: width })),
    );
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('98');
    expect(rendered).toContain('103');
    for (const line of rendered.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(width);
  });

  it('renders every row in an expanded diff', () => {
    const changedRows = Array.from({ length: 2100 }, (_, index) => `+line ${index + 1}`);
    const output = ['@@ -0,0 +1,2100 @@', ...changedRows].join('\n');
    const view = render(withTheme(React.createElement(DiffBlock, { output, terminalWidth: 80 })));
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('+ line 1050');
    expect(rendered).toContain('+ line 2100');
    expect(rendered).not.toContain('omitted');
  });

  it('does not truncate expanded diffs by byte size', () => {
    const changedRows = Array.from(
      { length: 25 },
      (_, index) => `+row-${index + 1}-${'x'.repeat(9 * 1024)}`,
    );
    const output = ['@@ -0,0 +1,25 @@', ...changedRows].join('\n');
    const view = render(
      withTheme(React.createElement(DiffBlock, { output, terminalWidth: 10_000 })),
    );
    const rendered = frame(view.lastFrame);

    expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(200 * 1024);
    expect(rendered).toContain('+ row-25-');
    expect(rendered).not.toContain('omitted');
  }, 15_000);
});

describe('inferDiffLanguage', () => {
  it('infers common source languages and ignores unknown extensions', () => {
    expect(inferDiffLanguage('src/app.tsx')).toBe('typescript');
    expect(inferDiffLanguage('scripts/run.sh')).toBe('bash');
    expect(inferDiffLanguage('README.custom')).toBeUndefined();
  });
});
