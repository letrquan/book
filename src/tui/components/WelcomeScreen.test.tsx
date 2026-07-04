import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { displayWidth } from './word-wrap.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

function lines(output: string): string[] {
  return output.split('\n').filter(Boolean);
}

afterEach(() => cleanup());

describe('WelcomeScreen', () => {
  it('renders the wide animated welcome final state when reduced motion is enabled', () => {
    const view = render(
      withTheme(
        <WelcomeScreen
          terminalWidth={100}
          terminalHeight={32}
          workspace="/tmp/book"
          model="claude-sonnet-5"
          mode="default"
          commandCount={20}
          skillCount={4}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('BOOK');
    expect(output).toContain('Your coding workspace, indexed.');
    expect(output).toContain('/init');
    expect(output).toContain('/skills');
    expect(output).toContain('Ctrl+/ shortcuts');
  });

  it('uses compact copy on narrow terminals', () => {
    const view = render(
      withTheme(
        <WelcomeScreen terminalWidth={36} terminalHeight={10} reducedMotion />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('BOOK');
    expect(output).toContain('Ask anything, or type /help');
    for (const line of lines(output)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(36);
    }
  });

  it('renders plain useful text for screen readers', () => {
    const view = render(
      withTheme(
        <WelcomeScreen terminalWidth={80} terminalHeight={24} screenReader model="model-x" mode="plan" />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('BOOK');
    expect(output).toContain('Type /help for commands');
    expect(output).toContain('Mode plan');
  });
});
