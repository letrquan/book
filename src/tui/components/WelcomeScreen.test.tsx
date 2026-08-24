import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { composeWelcomeHints, WELCOME_HINTS, WelcomeScreen } from './WelcomeScreen.js';
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
    expect(output).toContain('╭ BOOK');
    expect(output).toContain('Ask anything, or type / for a command.');
    expect(output).toContain('/help');
    expect(output).toContain('/skills');
    expect(output).toContain('Ctrl+/ shortcuts');
    expect(lines(output)).toHaveLength(4);
  });

  it('keeps the compact welcome to three rows', () => {
    const view = render(
      withTheme(
        <WelcomeScreen
          terminalWidth={60}
          terminalHeight={16}
          workspace="/tmp/book"
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(lines(output)).toHaveLength(3);
    expect(output).toContain('BOOK');
    expect(output).toContain('/skills');
  });

  it('uses compact copy on narrow terminals', () => {
    const view = render(
      withTheme(<WelcomeScreen terminalWidth={36} terminalHeight={10} reducedMotion />),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('BOOK');
    expect(output).toContain('Ask anything.');
    expect(lines(output)).toHaveLength(2);
    for (const line of lines(output)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(36);
    }
  });

  it('renders plain useful text for screen readers', () => {
    const view = render(
      withTheme(
        <WelcomeScreen
          terminalWidth={80}
          terminalHeight={24}
          screenReader
          model="model-x"
          mode="plan"
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('BOOK');
    expect(output).toContain('Type /help for commands');
    expect(output).toContain('Mode plan');
  });
});

describe('composeWelcomeHints', () => {
  it('never renders a partial command', () => {
    // The old screen truncated per segment and advertised `/hel`.
    for (let width = 0; width <= 120; width++) {
      for (const hint of composeWelcomeHints(WELCOME_HINTS, width)) {
        expect(WELCOME_HINTS).toContainEqual(hint);
      }
    }
  });

  it('stays inside the width it is given', () => {
    for (let width = 0; width <= 120; width++) {
      const chosen = composeWelcomeHints(WELCOME_HINTS, width);
      const rendered = chosen.map((hint) => `${hint.key} ${hint.label}`).join('    ');
      expect(displayWidth(rendered)).toBeLessThanOrEqual(width);
    }
  });

  it('drops the least important hint first', () => {
    const wide = composeWelcomeHints(WELCOME_HINTS, 120);
    const narrow = composeWelcomeHints(WELCOME_HINTS, 30);
    expect(wide).toEqual([...WELCOME_HINTS]);
    expect(narrow).toEqual(wide.slice(0, narrow.length));
    expect(narrow[0]).toEqual(WELCOME_HINTS[0]);
  });

  it('returns nothing rather than something broken at zero width', () => {
    expect(composeWelcomeHints(WELCOME_HINTS, 0)).toEqual([]);
    expect(composeWelcomeHints(WELCOME_HINTS, 3)).toEqual([]);
  });
});
