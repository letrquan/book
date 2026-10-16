import { describe, expect, it, vi } from 'vitest';
import {
  countOutputLines,
  formatToolOutputFooter,
  prepareToolOutputDisplay,
} from './tool-output.js';
import { displayWidth } from './word-wrap.js';

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
