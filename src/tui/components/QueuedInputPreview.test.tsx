import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import chalk from 'chalk';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { QueuedInputPreview } from './QueuedInputPreview.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function frame(element: React.ReactElement): string {
  const level = chalk.level;
  chalk.level = 3;
  try {
    return (
      render(
        <ThemeContext.Provider value={DEFAULT_THEME}>{element}</ThemeContext.Provider>,
      ).lastFrame() ?? ''
    );
  } finally {
    chalk.level = level;
  }
}

/** The SGR parameters a truecolor foreground of `hex` prints as. */
function truecolor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `38;2;${r};${g};${b}m`;
}

afterEach(() => cleanup());

describe('QueuedInputPreview notes', () => {
  it('confirms a finished change with a green check and quiet text', () => {
    const raw = frame(
      <QueuedInputPreview
        items={[]}
        terminalWidth={80}
        notice="Compact model: gemini-3.8-flash"
        noticeTone="done"
      />,
    );
    expect(stripAnsi(raw)).toContain('✓ Compact model: gemini-3.8-flash');
    // The warning amber is kept for a state that needs you.
    expect(raw).not.toContain(truecolor(DEFAULT_THEME.warning));
  });

  it('keeps the amber for a warning', () => {
    const raw = frame(<QueuedInputPreview items={[]} terminalWidth={80} notice="Queue is full." />);
    expect(stripAnsi(raw)).toContain('Queue is full.');
    expect(stripAnsi(raw)).not.toContain('✓');
    expect(raw).toContain(truecolor(DEFAULT_THEME.warning));
  });

  it('draws nothing when there is neither a queue nor a note', () => {
    expect(stripAnsi(frame(<QueuedInputPreview items={[]} terminalWidth={80} />))).toBe('');
  });
});
