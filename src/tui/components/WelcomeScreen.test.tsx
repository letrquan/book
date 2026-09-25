import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { TranscriptViewportContext } from '../transcript-layout.js';
import { composeWelcomeHints, DROP_CAP, WELCOME_HINTS, WelcomeScreen } from './WelcomeScreen.js';
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
  it('opens on a drop cap with the word and the details set beside it', () => {
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

    const all = stripAnsi(view.lastFrame()).split('\n');
    // One row of top margin, then the cap on the content column.
    expect(all[0]!.trim()).toBe('');
    DROP_CAP.forEach((row, index) => {
      expect(all[index + 1]!.startsWith(`  ${row}`)).toBe(true);
    });
    const beside = (index: number) => all[index + 1]!.slice(2 + displayWidth(DROP_CAP[0])).trim();
    // "B" + "ook": the cap starts the word.
    expect(beside(0)).toBe('ook');
    expect(beside(2)).toBe('book  ·  claude-sonnet-5');
    expect(beside(3)).toContain('/help commands');
    // No tagline: the composer's placeholder already says it.
    expect(all.join('\n')).not.toContain('Ask anything');
  });

  it('never cuts the drop cap when an open menu shrinks the transcript', () => {
    const viewport = (viewportRows: number) => ({
      subscribe: () => () => {},
      getRevision: () => viewportRows,
      getSnapshot: () => ({ scrollTop: 0, viewportRows, followBottom: true }),
    });
    const shown = (viewportRows: number) => {
      const view = render(
        withTheme(
          <TranscriptViewportContext.Provider value={viewport(viewportRows)}>
            <WelcomeScreen terminalWidth={100} terminalHeight={20} reducedMotion />
          </TranscriptViewportContext.Provider>,
        ),
      );
      const rows = lines(stripAnsi(view.lastFrame()));
      cleanup();
      return rows;
    };

    // Room for the cap but not its top margin: the cap, whole, from the first row.
    const tight = shown(DROP_CAP.length);
    expect(tight).toHaveLength(DROP_CAP.length);
    expect(tight[0]!.startsWith(`  ${DROP_CAP[0]}`)).toBe(true);
    // Not even that: nothing, rather than a sliced glyph.
    expect(shown(DROP_CAP.length - 1)).toEqual([]);
  });

  it('keeps every drop cap row the same width', () => {
    expect(new Set(DROP_CAP.map(displayWidth)).size).toBe(1);
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
    expect(output).toContain('Book');
    expect(output).toContain('/skills');
  });

  it('uses compact copy on narrow terminals', () => {
    const view = render(
      withTheme(<WelcomeScreen terminalWidth={36} terminalHeight={10} reducedMotion />),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('Book');
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
    expect(output).toContain('Book');
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
