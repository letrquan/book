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
});
