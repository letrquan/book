import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import type { Todo, TodoStatus } from '../../tools/todo.js';
import { displayWidth } from './word-wrap.js';
import { StepsSheet } from './StepsSheet.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function renderSheet(todos: Todo[], width = 80) {
  return stripAnsi(
    render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <StepsSheet todos={todos} width={width} />
      </ThemeContext.Provider>,
    ).lastFrame(),
  );
}

/** The truecolor escape chalk writes for a `#RRGGBB` token. */
function ink(token: string): string {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(token.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
  return `\u001b[38;2;${r};${g};${b}m`;
}

/** True when every `glyph` in the frame carries `escape` immediately before it. */
function inkedIn(frame: string, glyph: string, escape: string): boolean {
  const found = [...frame.matchAll(new RegExp(glyph, 'g'))];
  return found.length > 0 && found.every((match) => frame.slice(0, match.index).endsWith(escape));
}

// Ink styles through chalk, which emits nothing off a TTY; force truecolor so
// the ink a check is drawn in is visible in the frame.
function colourFrame(todos: Todo[], width = 80): string {
  const level = chalk.level;
  chalk.level = 3;
  try {
    return (
      render(
        <ThemeContext.Provider value={DEFAULT_THEME}>
          <StepsSheet todos={todos} width={width} />
        </ThemeContext.Provider>,
      ).lastFrame() ?? ''
    );
  } finally {
    chalk.level = level;
  }
}

afterEach(cleanup);

describe('StepsSheet', () => {
  it('sets the steps under a ruled head with the plan’s progress', () => {
    const output = renderSheet([
      { content: 'Read the loader', status: 'completed' },
      { content: 'Fix the parser', status: 'in_progress', activeForm: 'Fixing the parser' },
      { content: 'Run the suite', status: 'pending' },
    ]);
    expect(output).toMatch(/─ § Steps ─+ 1 of 3 done · Ctrl\+T to close ─/);
    expect(output).toContain('✓ Read the loader');
    expect(output).toContain('◔ Fix the parser');
    expect(output).toContain('◌ Run the suite');
    expect(output).not.toContain('Fixing the parser');
  });

  it('puts the markers on the tool rows’ column', () => {
    const output = renderSheet([{ content: 'Fix the parser', status: 'in_progress' }]);
    const row = output.split('\n').find((line) => line.includes('Fix the parser'));
    expect(row?.indexOf('◔')).toBe(2);
  });

  it('folds finished steps above the window and counts the ones below', () => {
    const statuses: TodoStatus[] = [
      'completed',
      'completed',
      'completed',
      'in_progress',
      ...Array<TodoStatus>(8).fill('pending'),
    ];
    const output = renderSheet(statuses.map((status, i) => ({ content: `Step ${i + 1}`, status })));
    expect(output).toContain('✓ 2 done');
    expect(output).toContain('+2 more');
    expect(output).not.toContain('Step 1\n');
  });

  it('says so when there is no plan', () => {
    expect(renderSheet([])).toContain('No steps yet.');
  });

  it('keeps a long step on one row', () => {
    const output = renderSheet([{ content: 'word '.repeat(40).trim(), status: 'pending' }], 50);
    for (const row of output.split('\n')) expect(displayWidth(row)).toBeLessThanOrEqual(50);
    expect(output.split('\n').filter((row) => row.includes('word'))).toHaveLength(1);
  });

  /**
   * A finished check is grey everywhere else on screen.
   *
   * `statusColor` gives a tool row's `✓` the `inactive` ink, and the guide says
   * so; a step's `✓` in the rubric green left the sheet as the one place a
   * completed thing shouted, on the folded count as well as on the listed rows.
   */
  it('greys every finished check, like a finished tool row', () => {
    const statuses: TodoStatus[] = [
      ...Array<TodoStatus>(4).fill('completed'),
      'in_progress',
      ...Array<TodoStatus>(7).fill('pending'),
    ];
    const frame = colourFrame(statuses.map((status, i) => ({ content: `Step ${i + 1}`, status })));
    const rows = frame.split('\n');
    const foldRow = rows.find(
      (row) => stripAnsi(row).includes('✓') && stripAnsi(row).includes('done'),
    );
    const listedRow = rows.find((row) => stripAnsi(row).includes('Step 4'));

    expect(foldRow).toContain(`${ink(DEFAULT_THEME.inactive)}✓`);
    expect(listedRow).toContain(`${ink(DEFAULT_THEME.inactive)}✓`);
    expect(inkedIn(frame, '✓', ink(DEFAULT_THEME.inactive))).toBe(true);
    expect(frame).not.toContain(ink(DEFAULT_THEME.success));
    // The step in hand is the only one that takes the rubric.
    expect(inkedIn(frame, '◔', ink(DEFAULT_THEME.brand))).toBe(true);
  });
});
