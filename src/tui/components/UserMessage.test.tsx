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
  it('opens the turn with a labelled rule, then the prompt', () => {
    const view = render(withTheme(<UserMessage content="compact request" terminalWidth={40} />));
    const lines = frameLines(view.lastFrame());

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('── you ');
    expect(lines[1]).toBe('  compact request');
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it('puts the prompt on the transcript content column', () => {
    const view = render(withTheme(<UserMessage content="compact request" terminalWidth={80} />));
    const lines = frameLines(view.lastFrame());

    expect(lines[1].indexOf('compact request')).toBe(CONTENT_COLUMN);
  });

  it('shows the turn time at the right edge of the rule', () => {
    const at = new Date(2026, 7, 24, 14, 5).getTime();
    const view = render(
      withTheme(<UserMessage content="hello" terminalWidth={80} timestamp={at} />),
    );
    const lines = frameLines(view.lastFrame());

    expect(lines[0]).toContain('14:05');
    expect(lines[0].trimEnd().endsWith('──')).toBe(true);
  });

  it('omits the time when the turn has none', () => {
    const view = render(withTheme(<UserMessage content="hello" terminalWidth={80} />));
    const lines = frameLines(view.lastFrame());

    expect(lines[0]).toMatch(/^── you ─+ ──$/);
  });

  it('keeps file mentions in the prompt', () => {
    const view = render(withTheme(<UserMessage content="check @src/app.ts" terminalWidth={40} />));

    expect(stripAnsi(view.lastFrame())).toContain('@src/app.ts');
  });

  it('renders flat text without a rule for screen readers', () => {
    const view = render(
      withTheme(<UserMessage content="compact request" terminalWidth={40} screenReader />),
    );
    const output = stripAnsi(view.lastFrame());

    expect(output).toContain('compact request');
    expect(output).not.toContain('──');
  });
});
