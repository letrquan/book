import { describe, expect, it, vi } from 'vitest';
import { toolOutputContentWidth, toolOutputDisplay } from '../tool-presentation.js';
import {
  countOutputLines,
  expandTabs,
  formatToolOutputFooter,
  prepareToolOutputDisplay,
  type ToolOutputDisplay,
} from './tool-output.js';
import { displayWidth } from './word-wrap.js';

describe('expandTabs', () => {
  it('moves to the next 8-column stop', () => {
    expect(expandTabs('a\tb')).toBe(`a${' '.repeat(7)}b`);
  });

  it('takes a whole stop for a tab already at a stop', () => {
    expect(expandTabs('12345678\tx')).toBe(`12345678${' '.repeat(8)}x`);
    expect(expandTabs('\tx')).toBe(`${' '.repeat(8)}x`);
    expect(expandTabs('a\t\tb')).toBe(`a${' '.repeat(15)}b`);
  });

  it('counts display columns: a wide character takes two, an ANSI escape none', () => {
    expect(expandTabs('中\tx')).toBe(`中${' '.repeat(6)}x`);
    expect(expandTabs('\u001b[31mab\u001b[39m\tc')).toBe(`\u001b[31mab\u001b[39m${' '.repeat(6)}c`);
  });

  it('returns a line without a tab unchanged', () => {
    const line = 'no tabs here';
    expect(expandTabs(line)).toBe(line);
  });
});

/** A tab-separated table a Bash call printed (#537): 86 columns once its tabs reach their stops. */
const TAB_TABLE_ROWS = [
  ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda'],
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'],
];
const TAB_TABLE = TAB_TABLE_ROWS.map((cells) => `${cells.join('\t')}\n`).join('');
/** The same table as a terminal shows it: every cell but the last padded to its 8-column stop. */
const TAB_TABLE_EXPANDED = TAB_TABLE_ROWS.map(
  (cells) => `${cells.map((cell, i) => (i < cells.length - 1 ? cell.padEnd(8) : cell)).join('')}\n`,
).join('');

describe('tool output with tabs (#537)', () => {
  it.each([true, false])(
    'lays a tab table out as its pre-expanded twin, inside the content width (showAll %s)',
    (showAllToolOutput) => {
      const input = { success: true, showAllToolOutput, terminalWidth: 73 };
      const display = toolOutputDisplay(TAB_TABLE, input);
      const width = toolOutputContentWidth(73);
      // Shown in full, a 86-column row continues on a second row instead of being cut (#550).
      expect(display.lines).toHaveLength(showAllToolOutput ? 4 : 2);
      for (const line of display.lines) {
        expect(line).not.toContain('\t');
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
      }
      expect(display.lines).toEqual(toolOutputDisplay(TAB_TABLE_EXPANDED, input).lines);
      if (showAllToolOutput) {
        expect(display.lines.join('').replace(/ /g, '')).toBe(
          TAB_TABLE_EXPANDED.replace(/[ \n]/g, ''),
        );
        expect(display.truncatedLines).toBe(0);
      } else {
        // Collapsed, the rows are cut where the view cuts any long row, and say so.
        expect(display.lines[0]!.endsWith('…')).toBe(true);
        expect(display.truncatedLines).toBe(2);
      }
    },
  );

  it.each([true, false])(
    'gives the whole display of the pre-expanded twin, hidden rows and footer too (showAll %s)',
    (showAllToolOutput) => {
      // Ten rows: more than a collapsed preview shows, so its head-tail split hides some.
      const input = { success: true, showAllToolOutput, terminalWidth: 73 };
      const pick = ({ totalChars: _totalChars, ...rest }: ToolOutputDisplay) => rest;
      const display = toolOutputDisplay(TAB_TABLE.repeat(5), input);
      // Everything but `totalChars`, which counts the output as the tool returned it.
      expect(pick(display)).toEqual(pick(toolOutputDisplay(TAB_TABLE_EXPANDED.repeat(5), input)));
      expect(display.totalChars).toBe(TAB_TABLE.length * 5);
      expect(display.hiddenLines).toBe(showAllToolOutput ? 0 : 4);
      expect(display.truncatedLines).toBe(showAllToolOutput ? 0 : 6);
    },
  );

  it('counts no tab line as shortened when its expanded width fits', () => {
    const display = prepareToolOutputDisplay('a\tb\nname\tvalue\n', {
      maxLines: 10,
      maxLineWidth: 40,
    });
    expect(display.lines).toEqual([`a${' '.repeat(7)}b`, `name${' '.repeat(4)}value`]);
    expect(display.truncatedLines).toBe(0);
    expect(display.truncated).toBe(false);
    expect(display.footer).toBeUndefined();
    const collapsed = toolOutputDisplay('a\tb\n', {
      success: true,
      showAllToolOutput: false,
      terminalWidth: 73,
    });
    expect(collapsed.truncatedLines).toBe(0);
    expect(collapsed.footer).toBeUndefined();
  });

  it('keeps every cell, on its 8-column stop, where nothing cuts the rows', () => {
    const display = prepareToolOutputDisplay(TAB_TABLE, {
      maxLines: 10,
      maxLineWidth: Number.MAX_SAFE_INTEGER,
    });
    expect(display.lines).toEqual(TAB_TABLE_EXPANDED.trimEnd().split('\n'));
    for (const [row, cells] of TAB_TABLE_ROWS.entries()) {
      let from = 0;
      for (const [column, cell] of cells.entries()) {
        const at = display.lines[row]!.indexOf(cell, from);
        expect(at, `${cell} in row ${row}`).toBe(column * 8);
        from = at + cell.length;
      }
    }
    expect(display.lines[0]).toContain('lambda');
    expect(display.lines[1]).toContain('11');
    expect(display.truncated).toBe(false);
  });

  it('indents a make recipe to the first stop and keeps its line count', () => {
    const output = 'all:\n\tgcc -o foo foo.c\n\tstrip foo\n';
    const display = prepareToolOutputDisplay(output, { maxLines: 10, maxLineWidth: 120 });
    expect(display.lines).toEqual(['all:', '        gcc -o foo foo.c', '        strip foo']);
    expect(display.totalLines).toBe(3);
    expect(countOutputLines(output)).toBe(3);
  });
});

describe('an expanded row keeps a long line whole (#550)', () => {
  const WIDTH = 70;
  const LONG = `start-${'0'.repeat(150)}-END`;
  const output = `${LONG}\nshort\n`;

  it('wraps a 160-column line onto the rows below it when shown in full', () => {
    const display = toolOutputDisplay(output, {
      success: true,
      showAllToolOutput: true,
      terminalWidth: WIDTH,
    });
    expect(display.lines.join('')).toBe(`${LONG}short`);
    expect(display.lines.at(-1)).toBe('short');
    for (const row of display.lines) expect(displayWidth(row)).toBeLessThanOrEqual(WIDTH);
    expect(display.truncatedLines).toBe(0);
    expect(display.hiddenLines).toBe(0);
    expect(display.footer).toBeUndefined();
  });

  it('still shortens the same line in a collapsed row, naming the key', () => {
    const display = toolOutputDisplay(output, {
      success: true,
      showAllToolOutput: false,
      terminalWidth: WIDTH,
    });
    expect(display.lines[0]).not.toContain('END');
    expect(display.truncatedLines).toBe(1);
    expect(display.footer).toContain('1 long line shortened (Ctrl+E)');
  });

  it('leaves the line whole for a caller that wraps it itself', () => {
    const display = toolOutputDisplay(output, {
      success: true,
      showAllToolOutput: true,
      terminalWidth: WIDTH,
      longLines: 'whole',
    });
    expect(display.lines[0]).toBe(LONG);
  });

  it('keeps an ANSI colour sequence whole and free of width when it wraps', () => {
    const line = `\u001b[31m${'x'.repeat(20)}\u001b[0m`;
    const display = prepareToolOutputDisplay(line, {
      maxLines: 10,
      maxLineWidth: 8,
      longLines: 'wrap',
    });
    expect(display.lines.map((row) => displayWidth(row))).toEqual([8, 8, 4]);
    expect(display.lines.join('').replace(/\u001b\[[0-9;]*m/g, '')).toBe('x'.repeat(20));
    expect(display.lines.join('')).toBe(line);
  });

  it('bounds the wrapped rows and counts a line the bound cuts into as shown, not hidden (#578)', () => {
    const display = prepareToolOutputDisplay(`${LONG}\n${LONG}\n${LONG}`, {
      maxLines: 5,
      maxLineWidth: WIDTH,
      longLines: 'wrap',
    });
    expect(display.lines).toHaveLength(5);
    // The second line is on screen for two of its three rows: only the third is fully hidden.
    expect(display.hiddenLines).toBe(1);
    expect(display.truncatedLines).toBe(1);
    expect(display.footer).toBe('… +1 line, 1 long line shortened');
  });

  it('names nothing as hidden when the bound cuts into the last line only (#578)', () => {
    const display = prepareToolOutputDisplay(`short\n${LONG}`, {
      maxLines: 3,
      maxLineWidth: WIDTH,
      longLines: 'wrap',
    });
    expect(display.hiddenLines).toBe(0);
    expect(display.truncatedLines).toBe(1);
    expect(display.footer).toBe('… 1 long line shortened');
  });

  it('records where each wrapped row came from, tabs expanded', () => {
    const display = prepareToolOutputDisplay('a\tbcdefghij\nz', {
      maxLines: 10,
      maxLineWidth: 10,
      longLines: 'wrap',
    });
    expect(display.sourceLines).toEqual([`a${' '.repeat(7)}bcdefghij`, 'z']);
    expect(display.rowSources).toEqual([
      { line: 0, start: 0, end: 10 },
      { line: 0, start: 10, end: 17 },
      { line: 1, start: 0, end: 1 },
    ]);
    for (const [i, row] of (display.rowSources ?? []).entries()) {
      expect(display.sourceLines?.[row.line]?.slice(row.start, row.end)).toBe(display.lines[i]);
    }
  });
});

describe('prepareToolOutputDisplay', () => {
  it('returns a collapsed preview with summary metadata', () => {
    const output = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');

    const display = prepareToolOutputDisplay(output, { maxLines: 5, maxLineWidth: 120 });

    expect(display.lines).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
    expect(display.totalLines).toBe(8);
    expect(display.hiddenLines).toBe(3);
    expect(display.truncated).toBe(true);
    expect(display.footer).toBe('… +3 lines');
  });

  it('does not mark short output as truncated', () => {
    const display = prepareToolOutputDisplay('alpha\nbeta', { maxLines: 5, maxLineWidth: 120 });

    expect(display.lines).toEqual(['alpha', 'beta']);
    expect(display.truncated).toBe(false);
    expect(display.footer).toBeUndefined();
  });

  it('does not truncate output exactly at the line threshold', () => {
    const output = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n');

    const display = prepareToolOutputDisplay(output, { maxLines: 5, maxLineWidth: 120 });

    expect(display.lines).toHaveLength(5);
    expect(display.hiddenLines).toBe(0);
    expect(display.truncated).toBe(false);
  });

  it('shortens long lines by display width with an ellipsis', () => {
    const display = prepareToolOutputDisplay('🙂🙂🙂🙂🙂🙂', { maxLines: 5, maxLineWidth: 7 });

    expect(display.lines[0]).toBe('🙂🙂🙂…');
    expect(displayWidth(display.lines[0])).toBeLessThanOrEqual(7);
    expect(display.truncated).toBe(true);
    expect(display.footer).toBe('… 1 long line shortened');
  });

  it('leaves out every empty line the output ends in, and keeps the ones inside it', () => {
    const display = prepareToolOutputDisplay('S1\n\nS2\n', { maxLines: 10, maxLineWidth: 120 });
    expect(display.lines).toEqual(['S1', '', 'S2']);
    expect(display.totalLines).toBe(3);
    expect(display.hiddenLines).toBe(0);
    expect(display.truncated).toBe(false);
    expect(display.footer).toBeUndefined();

    const trailing = prepareToolOutputDisplay('A\n\nB\n\n\n', { maxLines: 10, maxLineWidth: 120 });
    expect(trailing.lines).toEqual(['A', '', 'B']);
    expect(trailing.totalLines).toBe(3);
    expect(trailing.footer).toBeUndefined();
  });

  it('keeps a line of whitespace, which is not empty', () => {
    const display = prepareToolOutputDisplay('A\n  \n\n', { maxLines: 10, maxLineWidth: 120 });
    expect(display.lines).toEqual(['A', '  ']);
    expect(display.totalLines).toBe(2);
  });

  it('shows no line for an output that is only newlines', () => {
    for (const output of ['', '\n', '\n\n\n']) {
      const display = prepareToolOutputDisplay(output, { maxLines: 10, maxLineWidth: 120 });
      expect([output, display.lines, display.totalLines]).toEqual([output, [], 0]);
    }
  });

  it('measures what a preview cuts against the lines it can draw', () => {
    const display = prepareToolOutputDisplay('a\n\nb\n\nc\n', {
      maxLines: 3,
      maxLineWidth: 120,
    });

    expect(display.lines).toEqual(['a', '', 'b']);
    expect(display.hiddenLines).toBe(2);
    expect(display.footer).toBe('… +2 lines');
  });

  it('previews the last real lines of an output that ends in blank lines', () => {
    const tail = prepareToolOutputDisplay('one\ntwo\nFAIL x\n\n\n', {
      maxLines: 2,
      maxLineWidth: 120,
      strategy: 'tail',
    });
    expect(tail.lines).toEqual(['two', 'FAIL x']);
    expect(tail.hiddenLines).toBe(1);

    const headTail = prepareToolOutputDisplay('a\nb\nc\nd\ne\nf\ng\nh\n\n\n', {
      maxLines: 4,
      maxLineWidth: 120,
      strategy: 'head-tail',
    });
    expect(headTail.lines).toEqual(['a', 'b', 'g', 'h']);
    expect(headTail.hiddenLines).toBe(4);
  });

  it('reports total character counts', () => {
    const output = 'abc\ndef';

    const display = prepareToolOutputDisplay(output, { maxLines: 1, maxLineWidth: 120 });

    expect(display.totalChars).toBe(output.length);
    expect(display.footer).toBe('… +1 line');
  });

  it('uses head-and-tail previews for successful noisy output', () => {
    const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n');
    const display = prepareToolOutputDisplay(output, {
      maxLines: 4,
      maxLineWidth: 120,
      strategy: 'head-tail',
    });

    expect(display.lines).toEqual(['line 1', 'line 2', 'line 9', 'line 10']);
    expect(display.hiddenLines).toBe(6);
  });

  it('prioritizes final error lines with a tail preview', () => {
    const output = ['setup', 'running', 'warning', 'fatal: failed'].join('\n');
    const display = prepareToolOutputDisplay(output, {
      maxLines: 2,
      maxLineWidth: 120,
      strategy: 'tail',
    });

    expect(display.lines).toEqual(['warning', 'fatal: failed']);
    expect(display.hiddenLines).toBe(2);
  });
});

describe('formatToolOutputFooter', () => {
  it('summarises hidden lines with the hint', () => {
    expect(formatToolOutputFooter({ hiddenLines: 97, truncatedLines: 0, hint: 'Ctrl+E' })).toBe(
      '… +97 lines (Ctrl+E)',
    );
  });

  it('adds shortened lines before the hint', () => {
    expect(formatToolOutputFooter({ hiddenLines: 97, truncatedLines: 3, hint: 'Ctrl+E' })).toBe(
      '… +97 lines, 3 long lines shortened (Ctrl+E)',
    );
  });

  it('reports only shortened lines when none are hidden', () => {
    expect(formatToolOutputFooter({ hiddenLines: 0, truncatedLines: 2, hint: 'Ctrl+E' })).toBe(
      '… 2 long lines shortened (Ctrl+E)',
    );
  });

  it('drops the parentheses without a hint', () => {
    expect(formatToolOutputFooter({ hiddenLines: 5, truncatedLines: 0 })).toBe('… +5 lines');
    expect(formatToolOutputFooter({ hiddenLines: 0, truncatedLines: 1, hint: '' })).toBe(
      '… 1 long line shortened',
    );
  });

  it('uses singular forms', () => {
    expect(formatToolOutputFooter({ hiddenLines: 1, truncatedLines: 1, hint: 'Ctrl+E' })).toBe(
      '… +1 line, 1 long line shortened (Ctrl+E)',
    );
  });

  it('counts the lines of a command’s output apart, with the same plural and the same hint', () => {
    const footer = (outputLines: number, hint?: string) =>
      formatToolOutputFooter({ hiddenLines: 0, truncatedLines: 0, hint, outputLines });
    expect(footer(7, 'Ctrl+E')).toBe('… +7 lines of output (Ctrl+E)');
    expect(footer(1, 'Ctrl+E')).toBe('… +1 line of output (Ctrl+E)');
    expect(footer(1, '')).toBe('… +1 line of output');
    expect(footer(2)).toBe('… +2 lines of output');
  });

  it('carries the hidden lines and the output lines in one footer, with the key once at its end', () => {
    const footer = (hiddenLines: number, outputLines: number, hint?: string) =>
      formatToolOutputFooter({ hiddenLines, truncatedLines: 0, hint, outputLines });
    expect(footer(2, 1, 'Ctrl+E')).toBe('… +2 lines, +1 line of output (Ctrl+E)');
    expect(footer(1, 3, 'Ctrl+E')).toBe('… +1 line, +3 lines of output (Ctrl+E)');
    expect(footer(2, 1, '')).toBe('… +2 lines, +1 line of output');
    expect(footer(36, 1)).toBe('… +36 lines, +1 line of output');
  });

  it('keeps the shortened lines with the hidden ones, ahead of the output', () => {
    expect(
      formatToolOutputFooter({
        hiddenLines: 2,
        truncatedLines: 1,
        hint: 'Ctrl+E',
        outputLines: 3,
      }),
    ).toBe('… +2 lines, 1 long line shortened, +3 lines of output (Ctrl+E)');
  });

  it('names no output when none of its lines are counted', () => {
    expect(
      formatToolOutputFooter({
        hiddenLines: 0,
        truncatedLines: 2,
        hint: 'Ctrl+E',
        outputLines: 0,
      }),
    ).toBe('… 2 long lines shortened (Ctrl+E)');
  });
});

describe('countOutputLines', () => {
  it('counts the lines of an output: every one but the empty ones it ends in', () => {
    expect(countOutputLines('')).toBe(0);
    expect(countOutputLines('a')).toBe(1);
    expect(countOutputLines('a\nb')).toBe(2);
    expect(countOutputLines('a\n')).toBe(1);
    expect(countOutputLines('a\nb\n')).toBe(2);
    expect(countOutputLines('\n')).toBe(0);
    expect(countOutputLines('\n\n')).toBe(0);
    expect(countOutputLines('\nX')).toBe(2);
    expect(countOutputLines('a\n\n\nb')).toBe(4);
    expect(countOutputLines('A\n\nB\n\n\n')).toBe(3);
    expect(countOutputLines('\nFAIL a\n\n\nexpected 1\n')).toBe(5);
  });

  it('counts a line of whitespace like any other', () => {
    expect(countOutputLines(' ')).toBe(1);
    expect(countOutputLines(' \n')).toBe(1);
    expect(countOutputLines('\t\n\n \n')).toBe(3);
    expect(countOutputLines('A\n\nB\n   \nC\n')).toBe(5);
  });

  it('splits on a newline only: the \\r of a CRLF stays on its line', () => {
    expect(countOutputLines('X\r\n')).toBe(1);
    expect(countOutputLines('one\r\ntwo\r\n')).toBe(2);
    expect(countOutputLines('\r\n')).toBe(1);
    expect(countOutputLines('A\r\n\r\nB\r\n')).toBe(3);
  });

  it('counts what prepareToolOutputDisplay shows, whatever the preview cuts', () => {
    const outputs = [
      '',
      'a',
      'a\n',
      '\n',
      '\n\n\n',
      'a\nb',
      'a\n\nb',
      'A\n\nB\n\n\n',
      ' \n\t\n',
      'A\n\nB\n   \nC\n',
      '\nFAIL a\n\n\nexpected 1\n',
      'one\r\ntwo\r\n',
      '\r\n',
      'A\r\n\r\nB\r\n',
      '\u001b[31mred\u001b[0m\n\u200e\n',
      '🙂\n🙂\n',
      'x'.repeat(5000),
      Array.from({ length: 900 }, (_, i) => `line ${i}\n\n`).join(''),
      Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n'),
    ];
    for (const output of outputs) {
      const label = JSON.stringify(output.slice(0, 20));
      const everything = prepareToolOutputDisplay(output, {
        maxLines: 5000,
        maxLineWidth: 120,
        strategy: 'head',
      });
      expect([label, countOutputLines(output), everything.lines.length]).toEqual([
        label,
        everything.totalLines,
        everything.totalLines,
      ]);
      const preview = prepareToolOutputDisplay(output, {
        maxLines: 10,
        maxLineWidth: 120,
        strategy: 'tail',
      });
      expect([label, countOutputLines(output)]).toEqual([label, preview.totalLines]);
      expect(preview.hiddenLines).toBe(preview.totalLines - preview.lines.length);
    }
  });

  it('counts a large output: a million empty lines, and ten megabytes of short ones', () => {
    expect(countOutputLines('\n'.repeat(1_000_000))).toBe(0);
    expect(countOutputLines('x\n'.repeat(5_000_000))).toBe(5_000_000);
    expect(countOutputLines('\nx'.repeat(5_000_000))).toBe(5_000_001);
    expect(countOutputLines(`x${'\n'.repeat(1_000_000)}`)).toBe(1);
  });

  it('makes no line of the output to count it', () => {
    const big = 'x\n'.repeat(1_000_000);
    const split = vi.spyOn(String.prototype, 'split');
    try {
      expect(countOutputLines(big)).toBe(1_000_000);
      const widest = Math.max(0, ...split.mock.contexts.map((text) => String(text).length));
      expect(widest).toBeLessThan(1000);
    } finally {
      split.mockRestore();
    }
  });
});
