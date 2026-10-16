import { describe, expect, it, vi } from 'vitest';
import {
  countDrawnOutputLines,
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

  it('leaves out the empty line a final newline ends in, and counts every other', () => {
    const display = prepareToolOutputDisplay('S1\n\nS2\n', { maxLines: 10, maxLineWidth: 120 });

    expect(display.lines).toEqual(['S1', '', 'S2']);
    // The block's own count is of the lines the split makes, that one included.
    expect(display.totalLines).toBe(4);
    expect(display.hiddenLines).toBe(0);
    expect(display.truncated).toBe(false);
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
  it('finds no line in an empty output, and a line after every newline in any other', () => {
    expect(countOutputLines('')).toBe(0);
    expect(countOutputLines('a')).toBe(1);
    expect(countOutputLines('a\nb')).toBe(2);
    // A final newline ends in an empty line, as the block splits it: the block draws that one too.
    expect(countOutputLines('a\n')).toBe(2);
    expect(countOutputLines('\n')).toBe(2);
    expect(countOutputLines('\n\n')).toBe(3);
    expect(countOutputLines('\nFAIL a\n\n\nexpected 1\n')).toBe(6);
  });

  it('counts what prepareToolOutputDisplay splits the same output into', () => {
    const outputs = [
      '',
      'a',
      'a\n',
      '\n',
      '\n\n\n',
      'a\nb',
      'a\n\nb',
      ' \n\t\n',
      '\nFAIL a\n\n\nexpected 1\n',
      'one\r\ntwo\r\n',
      '\u001b[31mred\u001b[0m\n\u200e\n',
      '🙂\n🙂\n',
      'x'.repeat(5000),
      Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n'),
    ];
    for (const output of outputs) {
      const display = prepareToolOutputDisplay(output, {
        maxLines: 10,
        maxLineWidth: 120,
        strategy: 'tail',
      });
      expect([JSON.stringify(output.slice(0, 20)), countOutputLines(output)]).toEqual([
        JSON.stringify(output.slice(0, 20)),
        display.totalLines,
      ]);
    }
  });

  it('counts a large output: a million empty lines, and ten megabytes of short ones', () => {
    expect(countOutputLines('\n'.repeat(1_000_000))).toBe(1_000_001);
    expect(countOutputLines('x\n'.repeat(5_000_000))).toBe(5_000_001);
  });
});

describe('countDrawnOutputLines', () => {
  it('finds a row in every line, empty ones too, and none after the final newline', () => {
    expect(countDrawnOutputLines('')).toBe(0);
    expect(countDrawnOutputLines('X')).toBe(1);
    expect(countDrawnOutputLines('a\nb')).toBe(2);
    // The empty line after a final newline is a line of the block's own count and no row of it.
    expect(countDrawnOutputLines('X\n')).toBe(1);
    expect(countDrawnOutputLines('a\nb\n')).toBe(2);
    expect(countDrawnOutputLines('\nX')).toBe(2);
    expect(countDrawnOutputLines('\n')).toBe(1);
    expect(countDrawnOutputLines('\n\n\n')).toBe(3);
    expect(countDrawnOutputLines('a\n\n\nb')).toBe(4);
    expect(countDrawnOutputLines('\nFAIL a\n\n\nexpected 1\n')).toBe(5);
  });

  it('counts a line of whitespace as a row like any other', () => {
    expect(countDrawnOutputLines(' ')).toBe(1);
    expect(countDrawnOutputLines(' \n')).toBe(1);
    expect(countDrawnOutputLines('\t\n\n \n')).toBe(3);
    expect(countDrawnOutputLines('A\n\nB\n   \nC\n')).toBe(5);
  });

  it('splits on a newline only, as the block does: the \\r of a CRLF stays on its line', () => {
    expect(countDrawnOutputLines('X\r\n')).toBe(1);
    expect(countDrawnOutputLines('one\r\ntwo\r\n')).toBe(2);
    expect(countDrawnOutputLines('\r\n')).toBe(1);
    expect(countDrawnOutputLines('A\r\n\r\nB\r\n')).toBe(3);
  });

  it('counts the lines prepareToolOutputDisplay shows, as OutputBlock draws them', () => {
    // OutputBlock draws one row for each of `display.lines`, empty ones included.
    const outputs = [
      '',
      'a',
      'a\n',
      '\n',
      '\n\n\n',
      'a\nb',
      'a\n\nb',
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
    ];
    for (const output of outputs) {
      const display = prepareToolOutputDisplay(output, {
        maxLines: 2000,
        maxLineWidth: 120,
        strategy: 'head',
      });
      expect(display.hiddenLines).toBe(0);
      const label = JSON.stringify(output.slice(0, 20));
      expect([label, countDrawnOutputLines(output)]).toEqual([label, display.lines.length]);
    }
  });

  it('counts a large output: a million empty lines, and ten megabytes of short ones', () => {
    expect(countDrawnOutputLines('\n'.repeat(1_000_000))).toBe(1_000_000);
    expect(countDrawnOutputLines('x\n'.repeat(5_000_000))).toBe(5_000_000);
    expect(countDrawnOutputLines('\nx'.repeat(5_000_000))).toBe(5_000_001);
  });

  it('makes no line of the output to count it', () => {
    const big = 'x\n'.repeat(1_000_000);
    const split = vi.spyOn(String.prototype, 'split');
    try {
      expect(countDrawnOutputLines(big)).toBe(1_000_000);
      const widest = Math.max(0, ...split.mock.contexts.map((text) => String(text).length));
      expect(widest).toBeLessThan(1000);
    } finally {
      split.mockRestore();
    }
  });
});
