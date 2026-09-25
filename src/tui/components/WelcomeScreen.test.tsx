import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { TranscriptViewportContext } from '../transcript-layout.js';
import {
  composeWelcomeHints,
  dotLeader,
  DROP_CAP,
  fitTitlePage,
  WELCOME_HINTS,
  WelcomeScreen,
} from './WelcomeScreen.js';
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
  const NOW = new Date(2026, 8, 25, 12, 0).getTime();
  const HOUR = 3_600_000;
  const chapters = [
    { id: 's1', name: 'Fix the timeout fallback', updatedAt: NOW - 2 * HOUR, messageCount: 14 },
    { id: 's2', name: 'Add retry backoff', updatedAt: NOW - 26 * HOUR, messageCount: 38 },
    { id: 's3', updatedAt: NOW - 72 * HOUR, messageCount: 3 },
  ];
  const titlePage = (props: Partial<React.ComponentProps<typeof WelcomeScreen>> = {}) => {
    const view = render(
      withTheme(
        <WelcomeScreen
          terminalWidth={100}
          terminalHeight={32}
          workspace="/tmp/book"
          model="claude-sonnet-5"
          reducedMotion
          now={NOW}
          {...props}
        />,
      ),
    );
    return stripAnsi(view.lastFrame()).split('\n');
  };
  const capAt = (rows: string[]) => rows.findIndex((row) => row.includes(DROP_CAP[0].trimEnd()));
  const beside = (row: string) => row.slice(2 + displayWidth(DROP_CAP[0]) + 3);

  it('sets a first session as a title page with getting-started contents', () => {
    const rows = titlePage();
    const top = capAt(rows);
    expect(top).toBeGreaterThanOrEqual(0);
    DROP_CAP.forEach((cap, index) => {
      expect(rows[top + index]!.startsWith(`  ${cap.trimEnd()}`)).toBe(true);
    });
    // "B" + "O O K", with the running head at the right edge of the page.
    expect(beside(rows[top]!)).toMatch(/^O O K\s+book · claude-sonnet-5$/);
    expect(beside(rows[top + 1]!)).toMatch(/^─+$/);
    expect(beside(rows[top + 2]!)).toBe('Your first chapter begins below.');
    expect(beside(rows[top + 4]!)).toBe('C O N T E N T S');
    const contents = rows.slice(top + DROP_CAP.length).filter((row) => row.trim());
    expect(contents[0]).toMatch(/i\.\s+Ask for a change in your own words(\s+\.)+\s+¶$/);
    expect(contents.some((row) => /iv\.\s+Use a skill.*\/skills$/.test(row))).toBe(true);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(100);
  });

  it('lists recent sessions as chapters, aged where a book prints the page', () => {
    const rows = titlePage({ recentSessions: chapters });
    const top = capAt(rows);
    expect(beside(rows[top + 2]!)).toBe(
      'Pick up a chapter with /resume, or begin a new one below.',
    );
    const text = rows.join('\n');
    expect(text).toMatch(/i\.\s+Fix the timeout fallback(\s+\.)+\s+2h ago/);
    expect(text).toMatch(/ii\.\s+Add retry backoff(\s+\.)+\s+1d ago/);
    // An unnamed session reads as one, not as an id.
    expect(text).toMatch(/iii\.\s+Untitled session(\s+\.)+\s+3d ago/);
    expect(text).toContain('/resume open a chapter');
  });

  it('lines the leader dots up down the page', () => {
    const rows = titlePage({ recentSessions: chapters }).filter((row) => /\.\s+\S+ ago$/.test(row));
    const dotColumns = rows.map(
      (row) =>
        new Set(
          [...row].flatMap((char, column) => (char === '.' && column > 20 ? [column % 2] : [])),
        ),
    );
    for (const columns of dotColumns) expect([...columns]).toEqual([0]);
  });

  it('draws the whole page, the cap alone, or nothing, as the viewport allows', () => {
    const viewport = (viewportRows: number) => ({
      subscribe: () => () => {},
      getRevision: () => viewportRows,
      getSnapshot: () => ({ scrollTop: 0, viewportRows, followBottom: true }),
    });
    const shown = (viewportRows: number) => {
      const view = render(
        withTheme(
          <TranscriptViewportContext.Provider value={viewport(viewportRows)}>
            <WelcomeScreen
              terminalWidth={100}
              terminalHeight={24}
              reducedMotion
              now={NOW}
              recentSessions={chapters}
            />
          </TranscriptViewportContext.Provider>,
        ),
      );
      const rows = lines(stripAnsi(view.lastFrame()));
      cleanup();
      return rows;
    };

    // An open menu leaves room for the cap: the cap block, whole, no contents.
    const cap = shown(8);
    expect(cap).toHaveLength(DROP_CAP.length);
    expect(cap.join('\n')).not.toContain('C O N T E N T S');
    // Too little even for that: nothing, rather than a sliced glyph.
    expect(shown(DROP_CAP.length)).toEqual([]);
    // Room for the page: all of it.
    expect(shown(20).join('\n')).toContain('/resume open a chapter');
  });

  it('keeps every drop cap row the same width', () => {
    expect(new Set(DROP_CAP.map(displayWidth)).size).toBe(1);
  });

  it('fits the page, then the cap, then nothing', () => {
    expect(fitTitlePage(30, 5, true)).toMatchObject({ show: true, entries: 5, index: true });
    expect(fitTitlePage(8, 5, true)).toEqual({
      topPadding: 0,
      entries: 0,
      index: false,
      show: true,
    });
    expect(fitTitlePage(DROP_CAP.length, 5, true).show).toBe(false);
  });

  it('leaves the dots of a leader on even columns with air at both ends', () => {
    expect(dotLeader(10, 9)).toBe('  . . .  ');
    expect(dotLeader(11, 9)).toBe(' . . . . ');
    expect(dotLeader(0, 2)).toBe('  ');
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
