import React from 'react';
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import {
  DiffBlock,
  EDIT_CONTEXT_ROWS,
  EDIT_PREVIEW_ROWS,
  NEW_FILE_PREVIEW_ROWS,
  diffPreviewOmittedRows,
  inferDiffLanguage,
  isUnifiedDiffLike,
  mutationDiffPreview,
  parseDiffLines,
  type DiffPreviewKind,
} from './Diff.js';
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

  it('parses the second file header of a multi-file creation diff as a header', () => {
    const output = [
      '--- a.js',
      '+++ a.js',
      '@@ -0,0 +1,2 @@',
      '+a1',
      '+a2',
      '--- b.js',
      '+++ b.js',
      '@@ -0,0 +1,1 @@',
      '+b1',
    ].join('\n');
    const lines = parseDiffLines(output);

    expect(lines.map((line) => line.kind)).toEqual([
      'meta',
      'meta',
      'hunk',
      'add',
      'add',
      'meta',
      'meta',
      'hunk',
      'add',
    ]);
    // The second file's numbering restarts at its own hunk header.
    expect(lines[8]).toMatchObject({ newLineNumber: 1 });
  });

  it('keeps a deleted line that starts with two dashes as a deletion without a following +++', () => {
    const lines = parseDiffLines('@@ -1,2 +1,1 @@\n--- not a header\n keep');
    expect(lines[1]).toMatchObject({ kind: 'del', content: '-- not a header' });

    const withAdd = parseDiffLines('@@ -1,2 +1,2 @@\n--- not a header\n+replacement\n keep');
    expect(withAdd[1]).toMatchObject({ kind: 'del' });
    expect(withAdd[2]).toMatchObject({ kind: 'add' });
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

    // One hunk: the gutter's line numbers already locate it, so no header row is drawn.
    expect(rendered).not.toContain('@@');
    expect(rendered).toContain('+ new 2');
    expect(rendered).toContain('- old 4');
    expect(rendered).not.toContain('lines omitted');
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
    // Each gap counts content lines (the unit the footer uses), never hunk headers.
    expect(rendered).toMatch(/⋮ \d+ lines omitted/);
    expect(rendered).not.toContain('rows omitted');
    // The gap rows already report what the preview hides, so the footer is the total.
    expect(rendered).toMatch(/… \d+ lines hidden \(Ctrl\+E\)/);
    expect(rendered).not.toMatch(/… \+\d+ lines/);
    expect(rendered).not.toContain('B omitted');
  });

  it('previews the head of a new file without a hunk header and counts hidden lines', () => {
    const output = [
      '@@ -0,0 +1,150 @@',
      ...Array.from({ length: 150 }, (_, index) => `+line ${index + 1}`),
    ].join('\n');
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output,
          collapsed: true,
          preview: 'head',
          maxRows: NEW_FILE_PREVIEW_ROWS,
        }),
      ),
    );
    const rendered = frame(view.lastFrame);
    const contentRows = rendered.split('\n').filter((row) => /\+ line \d+/.test(row));

    expect(NEW_FILE_PREVIEW_ROWS).toBe(5);
    expect(contentRows).toHaveLength(5);
    expect(rendered).toContain('+ line 1');
    expect(rendered).toContain('+ line 5');
    expect(rendered).not.toContain('+ line 6');
    expect(rendered).not.toContain('@@');
    expect(rendered).not.toContain('omitted');
    expect(rendered).toContain('… +145 lines (Ctrl+E)');
  });

  it('shows a whole new file in head mode when it is not collapsed', () => {
    const output = [
      '@@ -0,0 +1,150 @@',
      ...Array.from({ length: 150 }, (_, index) => `+line ${index + 1}`),
    ].join('\n');
    const view = render(
      withTheme(React.createElement(DiffBlock, { output, preview: 'head', maxRows: 10 })),
    );
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('+ line 150');
    expect(rendered).not.toContain('… +');
  });

  it('keeps each head-preview line on one terminal row, however long', () => {
    const output = [
      '@@ -0,0 +1,3 @@',
      ...Array.from({ length: 3 }, (_, index) => `+${String(index + 1).repeat(5000)}`),
    ].join('\n');
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output,
          collapsed: true,
          preview: 'head',
          maxRows: NEW_FILE_PREVIEW_ROWS,
          terminalWidth: 60,
        }),
      ),
    );
    const rows = frame(view.lastFrame)
      .split('\n')
      .filter((row) => row.trim().length > 0);

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toContain('…');
      expect(displayWidth(row)).toBeLessThanOrEqual(60);
    }
  });

  it('shows a long new-file line whole when show-all leaves the preview off', () => {
    const output = ['@@ -0,0 +1,1 @@', `+${'x'.repeat(300)}`].join('\n');
    const view = render(
      withTheme(React.createElement(DiffBlock, { output, preview: 'head', terminalWidth: 60 })),
    );
    const rows = frame(view.lastFrame)
      .split('\n')
      .filter((row) => row.trim().length > 0);

    expect(rows.length).toBeGreaterThan(1);
    expect(rows.join('').match(/x/g)).toHaveLength(300);
  });

  it('renders a 200,000-row pure-addition diff collapsed in head mode', () => {
    const output = [
      '@@ -0,0 +1,200000 @@',
      ...Array.from({ length: 200000 }, (_, index) => `+line ${index + 1}`),
    ].join('\n');
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output,
          collapsed: true,
          preview: 'head',
          maxRows: NEW_FILE_PREVIEW_ROWS,
        }),
      ),
    );
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('+ line 5');
    expect(rendered).toContain('… +199995 lines (Ctrl+E)');
  });

  it('caps an edit diff longer than 80 rows with a line-count footer', () => {
    const output = [
      '@@ -1,200 +1,200 @@',
      ...Array.from({ length: 100 }, (_, index) => `-old ${index + 1}`),
      ...Array.from({ length: 100 }, (_, index) => `+new ${index + 1}`),
    ].join('\n');
    const view = render(withTheme(React.createElement(DiffBlock, { output, collapsed: true })));
    const lines = frame(view.lastFrame).split('\n');
    const footer = lines.filter(isFooter);

    // One hunk draws no header, so the 80 rows are 79 content lines and one gap row.
    expect(footer).toHaveLength(1);
    expect(footer[0]).toContain('… 121 lines hidden (Ctrl+E)');
    expect(lines.some((row) => row.includes('⋮ 121 lines omitted'))).toBe(true);
    expect(lines.filter((row) => /[-+] (old|new) \d+/.test(row))).toHaveLength(79);
  });

  it('keeps an edit diff of 80 rows or fewer complete with no footer', () => {
    const output = [
      '@@ -1,40 +1,39 @@',
      ...Array.from({ length: 40 }, (_, index) => `-old ${index + 1}`),
      ...Array.from({ length: 39 }, (_, index) => `+new ${index + 1}`),
    ].join('\n');
    const view = render(withTheme(React.createElement(DiffBlock, { output, collapsed: true })));
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('- old 40');
    expect(rendered).toContain('+ new 39');
    expect(rendered).not.toContain('… +');
    expect(rendered).not.toContain('lines hidden');
  });

  it('uses the singular for one hidden line and drops the parentheses without a hint', () => {
    const output = ['@@ -0,0 +1,4 @@', '+a', '+b', '+c', '+d'].join('\n');
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output,
          collapsed: true,
          preview: 'head',
          maxRows: 3,
          expandHint: '',
        }),
      ),
    );
    const rendered = frame(view.lastFrame);

    expect(rendered).toContain('… +1 line');
    expect(rendered).not.toContain('… +1 line (');
    expect(rendered).not.toContain('lines');
  });

  it('numbers each row once: a removed line by its old number, any other by its new one', () => {
    const output = '@@ -98 +103 @@\n ctx\n-old\n+new';
    const rows = frame(
      render(withTheme(React.createElement(DiffBlock, { output }))).lastFrame,
    ).split('\n');

    expect(rows.find((row) => row.includes('ctx'))?.trim()).toMatch(/^103\s+ctx$/);
    expect(rows.find((row) => row.includes('old'))?.trim()).toMatch(/^99 - old$/);
    expect(rows.find((row) => row.includes('new'))?.trim()).toMatch(/^104 \+ new$/);
    expect(rows.join('\n')).not.toContain('│');
  });

  it('renders word-level markers on one content row', () => {
    const output = '@@ -1 +1 @@\n-old\n+new {+value+}';
    const view = render(withTheme(React.createElement(DiffBlock, { output })));
    const rows = frame(view.lastFrame)
      .split('\n')
      .filter((row) => row.trim().length > 0);

    // The sole hunk draws no header, so the two changed lines are the only rows.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('+ new value');
  });

  it('keeps the configured background-token palette for added and removed lines', () => {
    expect(DEFAULT_THEME.diffRemoved).toBe('#3A1E22');
    expect(DEFAULT_THEME.diffAdded).toBe('#173A28');
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

  it('renders tabs and Unicode within the width budget while keeping each line number', () => {
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

  // Only two things are under test: that a diff past the old 200 KB byte cap
  // still reaches the screen, and that the last row survives. The fixture is
  // the smallest one that clears the cap for that reason, and rendering it costs
  // about half a second on an idle box and 16s on a heavily loaded one — so the
  // budget is four times the loaded measurement, not five: loose enough not to
  // redden a runner that is busy, tight enough that a render that gets an order
  // of magnitude more expensive still fails here.
  it('does not truncate expanded diffs by byte size', () => {
    const changedRows = Array.from(
      { length: 22 },
      (_, index) => `+row-${index + 1}-${'x'.repeat(9320)}`,
    );
    const output = ['@@ -0,0 +1,22 @@', ...changedRows].join('\n');
    const view = render(
      withTheme(React.createElement(DiffBlock, { output, terminalWidth: 10_000 })),
    );
    const rendered = frame(view.lastFrame);

    expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(200 * 1024);
    expect(rendered).toContain('+ row-22-');
    expect(rendered).not.toContain('omitted');
  }, 30_000);
});

const isFooter = (row: string): boolean => /^\s*… (\+|\d)/.test(row);

/** The non-empty rows of a rendered frame; the omission footer is the row starting `…`. */
function diffRows(rendered: string): { body: string[]; footer: string[] } {
  const rows = rendered.split('\n').filter((row) => row.trim().length > 0);
  return {
    body: rows.filter((row) => !isFooter(row)),
    footer: rows.filter((row) => isFooter(row)),
  };
}

/** A 39-line hunk of one file: 12 renamed lines (a 12-line `replace_all`) among 15 context. */
function renameDiff(): string {
  return [
    '@@ -1 +1 @@',
    ...Array.from({ length: 6 }, (_, index) => ` before ${index + 1}`),
    ...Array.from({ length: 12 }, (_, index) => `-const oldName${index} = 1;`),
    ...Array.from({ length: 12 }, (_, index) => `+const newName${index} = 1;`),
    ...Array.from({ length: 9 }, (_, index) => ` after ${index + 1}`),
  ].join('\n');
}

/** `pairs` long del/add pairs: each line wraps to three rows at a width of 40. */
function longLineDiff(pairs: number): string {
  const pad = (index: number) => String(index).padStart(2, '0');
  return [
    `@@ -1 +1 @@`,
    ...Array.from({ length: pairs }, (_, index) => `-${'a'.repeat(70)}${pad(index)}`),
    ...Array.from({ length: pairs }, (_, index) => `+${'b'.repeat(70)}${pad(index)}`),
  ].join('\n');
}

describe('edit diff preview', () => {
  it('exports the compact edit budget and context beside the new-file one', () => {
    expect(EDIT_PREVIEW_ROWS).toBe(12);
    expect(EDIT_CONTEXT_ROWS).toBe(1);
  });

  it('keeps one line of context around a compact edit, and no gap row or footer for the rest', () => {
    const output = [
      '@@ -1 +1 @@',
      ...Array.from({ length: 6 }, (_, index) => ` before ${index + 1}`),
      '-  enabled: false,',
      '+  enabled: true,',
      ...Array.from({ length: 3 }, (_, index) => ` after ${index + 1}`),
    ].join('\n');
    const options = {
      preview: 'changes' as const,
      maxRows: EDIT_PREVIEW_ROWS,
      contextRows: EDIT_CONTEXT_ROWS,
    };
    const rendered = frame(
      render(withTheme(React.createElement(DiffBlock, { output, collapsed: true, ...options })))
        .lastFrame,
    );
    const { body, footer } = diffRows(rendered);

    // The file around the change is left out on purpose: it is not reported as hidden.
    expect(body).toHaveLength(4);
    expect(body[0]).toContain('before 6');
    expect(body[1]).toContain('-   enabled: false,');
    expect(body[2]).toContain('+   enabled: true,');
    expect(body[3]).toContain('after 1');
    expect(rendered).not.toContain('omitted');
    expect(footer).toHaveLength(0);
    // Ctrl+E still has the rest of the file's lines to show.
    expect(diffPreviewOmittedRows(output, { terminalWidth: 80, ...options })).toBe(7);
  });

  it('reports the changes a compact edit had no room for', () => {
    const output = renameDiff();
    const options = {
      preview: 'changes' as const,
      maxRows: EDIT_PREVIEW_ROWS,
      contextRows: EDIT_CONTEXT_ROWS,
    };
    const { body, footer } = diffRows(
      frame(
        render(withTheme(React.createElement(DiffBlock, { output, collapsed: true, ...options })))
          .lastFrame,
      ),
    );

    expect(body.length).toBeLessThanOrEqual(EDIT_PREVIEW_ROWS);
    expect(footer).toHaveLength(1);
    expect(footer[0]).toMatch(/… \d+ lines hidden \(Ctrl\+E\)/);
  });

  it('previews the first 20 rows of a one-hunk rename in head-wrap mode, with a footer', () => {
    const output = renameDiff();
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output,
          collapsed: true,
          preview: 'head-wrap',
          maxRows: 20,
        }),
      ),
    );
    const { body, footer } = diffRows(frame(view.lastFrame));

    expect(body).toHaveLength(20);
    expect(body[0]).toContain('before 1');
    expect(body[19]).toContain('+ const newName1 = 1;');
    expect(frame(view.lastFrame)).not.toContain('@@');
    expect(footer).toHaveLength(1);
    expect(footer[0]).toContain('… +19 lines (Ctrl+E)');
    expect(
      diffPreviewOmittedRows(output, { terminalWidth: 80, preview: 'head-wrap', maxRows: 20 }),
    ).toBe(19);
  });

  it('shows every line and no footer when the same diff is not collapsed', () => {
    const view = render(withTheme(React.createElement(DiffBlock, { output: renameDiff() })));
    const rendered = frame(view.lastFrame);
    const { body, footer } = diffRows(rendered);

    expect(body).toHaveLength(39);
    expect(footer).toHaveLength(0);
    expect(rendered).not.toContain('@@');
    expect(rendered).toContain('after 9');
  });

  it('counts rendered rows against the 20-row head budget when lines wrap', () => {
    const output = longLineDiff(13);
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output,
          collapsed: true,
          preview: 'head-wrap',
          maxRows: 20,
          terminalWidth: 40,
        }),
      ),
    );
    const { body, footer } = diffRows(frame(view.lastFrame));

    // Three rows per line: six lines fit, and a seventh would overflow, so it is not cut in half.
    expect(body).toHaveLength(18);
    expect(body.join('').match(/a/g)).toHaveLength(6 * 70);
    for (const row of body) expect(displayWidth(row)).toBeLessThanOrEqual(40);
    expect(footer).toHaveLength(1);
    expect(footer[0]).toContain('… +20 lines (Ctrl+E)');
    expect(
      diffPreviewOmittedRows(output, { terminalWidth: 40, preview: 'head-wrap', maxRows: 20 }),
    ).toBe(20);
  });

  it('draws only the first wrapped rows of a first line that overflows the budget', () => {
    const output = ['@@ -1 +1 @@', `-${'a'.repeat(800)}`, '+short'].join('\n');
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output,
          collapsed: true,
          preview: 'head-wrap',
          maxRows: 20,
          terminalWidth: 40,
        }),
      ),
    );
    const { body, footer } = diffRows(frame(view.lastFrame));

    expect(body).toHaveLength(20);
    for (const row of body) expect(displayWidth(row)).toBeLessThanOrEqual(40);
    // The last drawn row is cut with the ellipsis; the rows above it are whole.
    expect(body[19]).toContain('…');
    expect(body[18]).not.toContain('…');
    expect(body.join('')).not.toContain('short');
    expect(footer[0]).toContain('… +1 line (Ctrl+E)');
    expect(
      diffPreviewOmittedRows(output, { terminalWidth: 40, preview: 'head-wrap', maxRows: 20 }),
    ).toBe(1);
  });

  it('keeps a 5000-character first line within the budget at width 60', () => {
    const output = ['@@ -1 +1 @@', `-${'m'.repeat(5000)}`, `+${'n'.repeat(5000)}`].join('\n');
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output,
          collapsed: true,
          preview: 'head-wrap',
          maxRows: 20,
          terminalWidth: 60,
        }),
      ),
    );
    const { body, footer } = diffRows(frame(view.lastFrame));

    expect(body.length).toBeLessThanOrEqual(20);
    expect(body.join('')).toContain('…');
    expect(footer).toHaveLength(1);
    // The first line is cut to the whole budget; the second line is not drawn at all.
    expect(footer[0]).toContain('… +1 line (Ctrl+E)');
  });

  it('cuts a first change that overflows the change preview budget', () => {
    const output = [
      '@@ -1 +1 @@',
      ...Array.from({ length: 30 }, (_, index) => ` ctx ${index}`),
      `-${'a'.repeat(5000)}`,
      '+short',
      ...Array.from({ length: 200 }, (_, index) => `+tail ${index}`),
    ].join('\n');
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output,
          collapsed: true,
          preview: 'changes',
          maxRows: 20,
          terminalWidth: 60,
        }),
      ),
    );
    const { body } = diffRows(frame(view.lastFrame));

    expect(body.length).toBeLessThanOrEqual(20);
    expect(body.join('')).toContain('…');
  });

  it('words the footer per preview kind', () => {
    const hunk = (start: number) => [
      `@@ -${start} +${start} @@`,
      ...Array.from({ length: 30 }, (_, index) => ` ctx ${start}-${index}`),
      `-old ${start}`,
      `+new ${start}`,
    ];
    const output = [...hunk(1), ...hunk(200)].join('\n');
    const footerOf = (preview: DiffPreviewKind, expandHint?: string) =>
      diffRows(
        frame(
          render(
            withTheme(
              React.createElement(DiffBlock, {
                output,
                collapsed: true,
                preview,
                maxRows: 20,
                expandHint,
              }),
            ),
          ).lastFrame,
        ),
      ).footer;

    expect(footerOf('changes')[0]).toMatch(/… \d+ lines hidden \(Ctrl\+E\)/);
    expect(footerOf('changes', '')[0]).toMatch(/… \d+ lines hidden$/);
    expect(footerOf('head-wrap')[0]).toMatch(/… \+\d+ lines \(Ctrl\+E\)/);
    expect(footerOf('head')[0]).toMatch(/… \+\d+ lines \(Ctrl\+E\)/);
  });

  it('counts rendered rows against the 80-row change budget when lines wrap', () => {
    const output = longLineDiff(60);
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output,
          collapsed: true,
          preview: 'changes',
          maxRows: 80,
          terminalWidth: 40,
        }),
      ),
    );
    const { body, footer } = diffRows(frame(view.lastFrame));
    const omitted = diffPreviewOmittedRows(output, {
      terminalWidth: 40,
      preview: 'changes',
      maxRows: 80,
    });

    // Gap rows count against the budget too.
    expect(body.length).toBeLessThanOrEqual(80);
    expect(body.length).toBeGreaterThan(70);
    expect(body.some((row) => /⋮ \d+ lines omitted/.test(row))).toBe(true);
    expect(footer).toHaveLength(1);
    expect(footer[0]).toContain(`… ${omitted} lines hidden (Ctrl+E)`);
    expect(omitted).toBeGreaterThan(0);
  });

  it('counts hunk-header and gap rows in the change preview budget', () => {
    const hunk = (start: number) => [
      `@@ -${start} +${start} @@`,
      ...Array.from({ length: 30 }, (_, index) => ` ctx ${start}-${index}`),
      `-old ${start}`,
      `+new ${start}`,
      ...Array.from({ length: 30 }, (_, index) => ` tail ${start}-${index}`),
    ];
    const output = [...hunk(1), ...hunk(200), ...hunk(400)].join('\n');
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output,
          collapsed: true,
          preview: 'changes',
          maxRows: 80,
        }),
      ),
    );
    const { body, footer } = diffRows(frame(view.lastFrame));

    expect(body.length).toBeLessThanOrEqual(80);
    expect(footer).toHaveLength(1);
    expect(body.filter((row) => row.includes('@@'))).toHaveLength(3);
  });

  it('renders each header with counts when the diff has several hunks', () => {
    const output = [
      '@@ -2 +2 @@',
      ' a1',
      ' a2',
      ' a3',
      '-gone',
      '+here',
      ' a4',
      ' a5',
      ' a6',
      '@@ -30 +30 @@',
      ' b1',
      ' b2',
      ' b3',
      '-gone 1',
      '-gone 2',
      '+here',
      ' b4',
      ' b5',
      ' b6',
    ].join('\n');
    const view = render(withTheme(React.createElement(DiffBlock, { output })));
    const rendered = frame(view.lastFrame);

    // Hunk one: 6 context + 1 removed = 7 old, 6 context + 1 added = 7 new.
    expect(rendered).toContain('@@ -2,7 +2,7 @@');
    // Hunk two: 6 context + 2 removed = 8 old, 6 context + 1 added = 7 new.
    expect(rendered).toContain('@@ -30,8 +30,7 @@');
    expect(rendered).not.toContain('@@ -2 +2 @@');
    expect(rendered).not.toContain('@@ -30 +30 @@');
  });

  it('keeps a hunk header the source already gave counts for, recomputed from its lines', () => {
    const output = ['@@ -1,99 +1,99 @@', ' x', '-y', '+z', '@@ -9 +9 @@', '-p', '+q'].join('\n');
    const rendered = frame(render(withTheme(React.createElement(DiffBlock, { output }))).lastFrame);

    expect(rendered).toContain('@@ -1,2 +1,2 @@');
    expect(rendered).toContain('@@ -9,1 +9,1 @@');
  });

  it('draws no hunk header for a file with one hunk, in a multi-file diff too', () => {
    const output = [
      '--- a.ts',
      '+++ a.ts',
      '@@ -3 +3 @@',
      '-one',
      '+uno',
      '--- b.ts',
      '+++ b.ts',
      '@@ -9 +9 @@',
      '-two',
      '+dos',
    ].join('\n');
    const rendered = frame(render(withTheme(React.createElement(DiffBlock, { output }))).lastFrame);

    expect(rendered).not.toContain('@@');
    expect(rendered).toContain('--- a.ts');
    expect(rendered).toContain('+++ b.ts');
    expect(rendered).toContain('+ dos');
  });

  it('draws every header of a file with several hunks, each with counts', () => {
    const output = [
      '--- a.ts',
      '+++ a.ts',
      '@@ -3 +3 @@',
      '-one',
      '+uno',
      '@@ -20 +20 @@',
      ' same',
      '-two',
      '+dos',
      '--- b.ts',
      '+++ b.ts',
      '@@ -9 +9 @@',
      '-three',
      '+tres',
    ].join('\n');
    const rendered = frame(render(withTheme(React.createElement(DiffBlock, { output }))).lastFrame);

    expect(rendered).toContain('@@ -3,1 +3,1 @@');
    expect(rendered).toContain('@@ -20,2 +20,2 @@');
    // The second file has one hunk of its own, however many the first has.
    expect(rendered).not.toContain('@@ -9');
  });

  it('counts a hunk only up to the end of the diff body', () => {
    const output = [
      '@@ -1 +1 @@',
      ' a',
      '-b',
      '+c',
      '\\ No newline at end of file',
      '@@ -9 +9 @@',
      ' d',
      '-e',
      '+f',
      '',
      'Warning: x',
    ].join('\n');
    const rendered = frame(render(withTheme(React.createElement(DiffBlock, { output }))).lastFrame);

    // The marker row is skipped, and the blank line and warning are not context.
    expect(rendered).toContain('@@ -1,2 +1,2 @@');
    expect(rendered).toContain('@@ -9,2 +9,2 @@');
  });

  it('skips the file metadata rows of a single-file head-wrap preview, not a multi-file one', () => {
    const file = (name: string) => [`--- ${name}`, `+++ ${name}`, '@@ -1 +1 @@', '-old', '+new'];
    const preview = (output: string) =>
      frame(
        render(
          withTheme(
            React.createElement(DiffBlock, {
              output,
              collapsed: true,
              preview: 'head-wrap',
              maxRows: 20,
            }),
          ),
        ).lastFrame,
      );

    const single = preview(file('a.ts').join('\n'));
    expect(single).not.toContain('--- a.ts');
    expect(single).not.toContain('+++ a.ts');
    expect(single).toContain('- old');

    const several = preview([...file('a.ts'), ...file('b.ts')].join('\n'));
    expect(several).toContain('--- a.ts');
    expect(several).toContain('+++ b.ts');
    // The same single-file diff is whole when it is not a head-wrap preview.
    const whole = frame(
      render(withTheme(React.createElement(DiffBlock, { output: file('a.ts').join('\n') })))
        .lastFrame,
    );
    expect(whole).toContain('--- a.ts');
  });

  it('prints no parenthesised key when expandHint is empty', () => {
    const view = render(
      withTheme(
        React.createElement(DiffBlock, {
          output: renameDiff(),
          collapsed: true,
          preview: 'head-wrap',
          maxRows: 20,
          expandHint: '',
        }),
      ),
    );
    const { footer } = diffRows(frame(view.lastFrame));

    expect(footer).toHaveLength(1);
    expect(footer[0]).toContain('… +19 lines');
    expect(footer[0]).not.toContain('(');
  });

  it('reports no omitted rows when the collapsed preview draws no footer', () => {
    const output = '@@ -1 +1 @@\n-old\n+new';

    expect(
      diffPreviewOmittedRows(output, { terminalWidth: 80, preview: 'head-wrap', maxRows: 20 }),
    ).toBe(0);
    expect(
      diffPreviewOmittedRows(output, { terminalWidth: 80, preview: 'changes', maxRows: 80 }),
    ).toBe(0);
    expect(
      diffPreviewOmittedRows('', { terminalWidth: 80, preview: 'head-wrap', maxRows: 20 }),
    ).toBe(0);
  });

  it('agrees with the footer of a new-file head preview', () => {
    const output = [
      '@@ -0,0 +1,150 @@',
      ...Array.from({ length: 150 }, (_, index) => `+line ${index + 1}`),
    ].join('\n');

    expect(
      diffPreviewOmittedRows(output, {
        terminalWidth: 80,
        preview: 'head',
        maxRows: NEW_FILE_PREVIEW_ROWS,
      }),
    ).toBe(145);
  });
});

describe('mutationDiffPreview', () => {
  it('previews a single new file as its first 5 lines in every mode', () => {
    for (const transcriptMode of ['compact', 'detailed'] as const) {
      for (const screenReader of [false, true]) {
        expect(
          mutationDiffPreview({ createsSingleNewFile: true, transcriptMode, screenReader }),
        ).toEqual({ preview: 'head', maxRows: 5 });
      }
    }
  });

  it('previews an edit as its changes and one line of context in the compact transcript', () => {
    expect(
      mutationDiffPreview({
        createsSingleNewFile: false,
        transcriptMode: 'compact',
        screenReader: false,
      }),
    ).toEqual({ preview: 'changes', maxRows: 12, contextRows: 1 });
  });

  it('keeps the change-focused 80-row preview for the detailed transcript and screen readers', () => {
    expect(
      mutationDiffPreview({
        createsSingleNewFile: false,
        transcriptMode: 'detailed',
        screenReader: false,
      }),
    ).toEqual({ preview: 'changes', maxRows: 80 });
    expect(
      mutationDiffPreview({
        createsSingleNewFile: false,
        transcriptMode: 'compact',
        screenReader: true,
      }),
    ).toEqual({ preview: 'changes', maxRows: 80 });
  });
});

describe('inferDiffLanguage', () => {
  it('infers common source languages and ignores unknown extensions', () => {
    expect(inferDiffLanguage('src/app.tsx')).toBe('typescript');
    expect(inferDiffLanguage('scripts/run.sh')).toBe('bash');
    expect(inferDiffLanguage('README.custom')).toBeUndefined();
  });
});
