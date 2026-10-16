import { describe, expect, it } from 'vitest';
import { formatToolOutputFooter, prepareToolOutputDisplay } from './tool-output.js';
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

  it('says what the hidden lines are lines of, with the same plural and the same hint', () => {
    const footer = (hiddenLines: number, hint?: string) =>
      formatToolOutputFooter({ hiddenLines, truncatedLines: 0, hint, of: 'output' });
    expect(footer(7, 'Ctrl+E')).toBe('… +7 lines of output (Ctrl+E)');
    expect(footer(1, 'Ctrl+E')).toBe('… +1 line of output (Ctrl+E)');
    expect(footer(1, '')).toBe('… +1 line of output');
    expect(footer(2)).toBe('… +2 lines of output');
  });

  it('names no subject when no lines are hidden', () => {
    expect(
      formatToolOutputFooter({ hiddenLines: 0, truncatedLines: 2, hint: 'Ctrl+E', of: 'output' }),
    ).toBe('… 2 long lines shortened (Ctrl+E)');
  });
});
