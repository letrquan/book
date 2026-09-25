import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { displayWidth } from './word-wrap.js';
import { UserMessage } from './UserMessage.js';
import { CONTENT_COLUMN } from '../layout.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

function frameLines(value: string | undefined): string[] {
  return stripAnsi(value).split('\n');
}

afterEach(() => cleanup());

describe('UserMessage', () => {
  it('sets the prompt on a banded row behind a ribbon', () => {
    // Ink colours through chalk, which emits nothing off a TTY; force truecolor
    // so the band's background is visible in the frame.
    const level = chalk.level;
    chalk.level = 3;
    let frame: string;
    try {
      const view = render(withTheme(<UserMessage content="compact request" terminalWidth={40} />));
      frame = view.lastFrame() ?? '';
    } finally {
      chalk.level = level;
    }
    const lines = frameLines(frame);

    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('▌ compact request')).toBe(true);
    // The band is painted: the row carries the user background as a 24-bit SGR.
    expect(frame).toContain('48;2;32;32;34');
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it('puts the prompt on the transcript content column', () => {
    const view = render(withTheme(<UserMessage content="compact request" terminalWidth={80} />));
    const lines = frameLines(view.lastFrame());

    expect(lines[0].indexOf('compact request')).toBe(CONTENT_COLUMN);
  });

  it('runs the ribbon down every row of a wrapped prompt', () => {
    const view = render(
      withTheme(
        <UserMessage content="one two three four five six seven eight nine" terminalWidth={24} />,
      ),
    );
    const lines = frameLines(view.lastFrame());

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.startsWith('▌ ')).toBe(true);
      expect(displayWidth(line)).toBeLessThanOrEqual(24);
    }
  });

  it('shows the turn time at the right edge of the first row', () => {
    const at = new Date(2026, 7, 24, 14, 5).getTime();
    const view = render(
      withTheme(<UserMessage content="hello" terminalWidth={80} timestamp={at} />),
    );
    const lines = frameLines(view.lastFrame());

    // The band ends one column short of the terminal, with a space of air
    // after the time.
    expect(lines[0].trimEnd().endsWith('14:05')).toBe(true);
    expect(displayWidth(lines[0].trimEnd())).toBe(78);
  });

  it('omits the time when the turn has none', () => {
    const view = render(withTheme(<UserMessage content="hello" terminalWidth={80} />));
    const lines = frameLines(view.lastFrame());

    expect(lines[0].trimEnd()).toBe('▌ hello');
  });

  it('keeps file mentions in the prompt', () => {
    const view = render(withTheme(<UserMessage content="check @src/app.ts" terminalWidth={40} />));

    expect(stripAnsi(view.lastFrame())).toContain('@src/app.ts');
  });

  it('renders flat text without the ribbon for screen readers', () => {
    const view = render(
      withTheme(<UserMessage content="compact request" terminalWidth={40} screenReader />),
    );
    const output = stripAnsi(view.lastFrame());

    expect(output).toContain('compact request');
    expect(output).not.toContain('▌');
  });
});
