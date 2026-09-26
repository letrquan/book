import chalk from 'chalk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { displayWidth } from './word-wrap.js';
import { UserMessage, userTurnRows, wrapUserPrompt } from './UserMessage.js';
import { CONTENT_COLUMN } from '../layout.js';
import { PILCROW } from '../marks.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

function frameLines(value: string | undefined): string[] {
  return stripAnsi(value).split('\n');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('UserMessage', () => {
  it('opens the turn with a pilcrow and sets the prompt in italic', () => {
    // Ink styles through chalk, which emits nothing off a TTY; force truecolor
    // so the italic is visible in the frame.
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
    expect(lines[0].startsWith(`${PILCROW} compact request`)).toBe(true);
    expect(frame).toContain('\u001b[3m');
    // No band: the row paints no background of its own.
    expect(frame).not.toMatch(/\u001b\[48;/);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it('puts the prompt on the transcript content column', () => {
    const view = render(withTheme(<UserMessage content="compact request" terminalWidth={80} />));
    const lines = frameLines(view.lastFrame());

    expect(lines[0].indexOf('compact request')).toBe(CONTENT_COLUMN);
  });

  it('hangs the pilcrow on the first row only of a wrapped prompt', () => {
    const view = render(
      withTheme(
        <UserMessage content="one two three four five six seven eight nine" terminalWidth={24} />,
      ),
    );
    const lines = frameLines(view.lastFrame());

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].startsWith(`${PILCROW} `)).toBe(true);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('  ')).toBe(true);
      expect(line.trim().length).toBeGreaterThan(0);
    }
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(24);
  });

  it('shows the turn time at the right edge of the first row', () => {
    const at = new Date(2026, 7, 24, 14, 5).getTime();
    const view = render(
      withTheme(<UserMessage content="hello" terminalWidth={80} timestamp={at} />),
    );
    const lines = frameLines(view.lastFrame());

    // The row ends one column short of the terminal, with a column of air
    // after the time.
    expect(lines[0].trimEnd().endsWith('14:05')).toBe(true);
    expect(displayWidth(lines[0].trimEnd())).toBe(78);
  });

  it('omits the time when the turn has none', () => {
    const view = render(withTheme(<UserMessage content="hello" terminalWidth={80} />));
    const lines = frameLines(view.lastFrame());

    expect(lines[0].trimEnd()).toBe(`${PILCROW} hello`);
  });

  it('keeps file mentions in the prompt', () => {
    const view = render(withTheme(<UserMessage content="check @src/app.ts" terminalWidth={40} />));

    expect(stripAnsi(view.lastFrame())).toContain('@src/app.ts');
  });

  it('renders flat text without the pilcrow for screen readers', () => {
    const view = render(
      withTheme(<UserMessage content="compact request" terminalWidth={40} screenReader />),
    );
    const output = stripAnsi(view.lastFrame());

    expect(output).toContain('compact request');
    expect(output).not.toContain(PILCROW);
  });
});

describe('user prompt wrapping', () => {
  const text = (rows: ReturnType<typeof wrapUserPrompt>) =>
    rows.map((row) => row.map((piece) => piece.text).join(''));

  it('keeps a pasted code block indented', () => {
    // The shared word wrapper dropped leading whitespace, so `    return 1`
    // landed in the transcript flush left.
    const view = render(
      withTheme(<UserMessage content={'def foo():\n    return 1'} terminalWidth={60} />),
    );
    const lines = frameLines(view.lastFrame());
    expect(lines[1]).toBe('      return 1'.padEnd(lines[1]!.length));
  });

  it('keeps the indent on the rows a long indented line wraps onto', () => {
    const rows = text(wrapUserPrompt('    alpha beta gamma delta epsilon', 16));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.startsWith('    ')).toBe(true);
  });

  it('never sets a row wider than its measure', () => {
    const samples = [
      'aaaa bbbb  cccc',
      'one  two   three    four',
      'x'.repeat(40),
      '\tindented\twith\ttabs and words',
      '  @"a quoted path/with spaces.ts" and more words after it',
    ];
    for (const sample of samples) {
      for (const width of [8, 9, 12, 20]) {
        for (const row of text(wrapUserPrompt(sample, width))) {
          expect(displayWidth(row)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it('keeps a quoted mention whole and accented when it wraps', () => {
    const rows = wrapUserPrompt('please read @"docs/my notes.md" today', 20);
    const mention = rows.flat().find((piece) => piece.isMention);
    expect(mention?.text).toBe('@"docs/my notes.md"');
  });

  it('keeps blank lines between paragraphs', () => {
    expect(text(wrapUserPrompt('first\n\nsecond', 20))).toEqual(['first', '', 'second']);
  });

  it('keeps a locale-wide time on the first row', () => {
    // fr-CA prints `19 h 13`, seven columns; a fixed five-column reservation
    // pushed it onto a second row of every turn.
    vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('19 h 13');
    const view = render(
      withTheme(<UserMessage content="hello there" terminalWidth={40} timestamp={1} />),
    );
    const lines = frameLines(view.lastFrame()).filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.trimEnd().endsWith('19 h 13')).toBe(true);
    expect(displayWidth(lines[0]!.trimEnd())).toBeLessThanOrEqual(38);
  });

  it('estimates exactly the rows it renders', () => {
    const content = 'def foo():\n    return some_long_name + another_long_name\n\n@"x y.ts" end';
    for (const width of [30, 48, 80]) {
      const view = render(
        withTheme(<UserMessage content={content} terminalWidth={width} timestamp={1} />),
      );
      const rendered = frameLines(view.lastFrame()).length;
      expect(userTurnRows(content, width, 1)).toBe(rendered);
      cleanup();
    }
  });
});
