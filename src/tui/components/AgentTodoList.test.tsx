import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import type { Todo } from '../../tools/todo.js';
import { displayWidth } from './word-wrap.js';
import {
  AgentTodoList,
  planMeterFill,
  shouldShowAgentPlan,
  visibleAgentTodos,
} from './AgentTodoList.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

afterEach(cleanup);

describe('AgentTodoList', () => {
  it('hides a completed plan until the task panel is revealed', () => {
    const completed: Todo[] = [{ content: 'Done', status: 'completed' }];
    expect(shouldShowAgentPlan(completed, false)).toBe(false);
    expect(shouldShowAgentPlan(completed, true)).toBe(true);
    expect(shouldShowAgentPlan([{ content: 'Next', status: 'pending' }], false)).toBe(true);
  });

  it('shows at most five items while retaining the active item', () => {
    const todos: Todo[] = Array.from({ length: 7 }, (_, index) => ({
      content: `Item ${index + 1}`,
      status: index === 6 ? 'in_progress' : 'completed',
      activeForm: index === 6 ? 'Working on item 7' : undefined,
    }));

    expect(visibleAgentTodos(todos)).toHaveLength(5);
    expect(visibleAgentTodos(todos).map((todo) => todo.content)).toEqual([
      'Item 1',
      'Item 2',
      'Item 3',
      'Item 4',
      'Item 7',
    ]);

    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <AgentTodoList todos={todos} />
      </ThemeContext.Provider>,
    );
    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('Working on item 7');
    expect(output).not.toContain('Item 5');
    expect(output).toContain('+2 more');
  });

  it('meters progress one cell per step and never fills an unfinished plan', () => {
    expect(planMeterFill(0, 5, 5)).toBe(0);
    expect(planMeterFill(2, 5, 5)).toBe(2);
    expect(planMeterFill(5, 5, 5)).toBe(5);
    // 9 of 10 rounds to 10 cells; a plan with work left never shows a full bar.
    expect(planMeterFill(9, 10, 10)).toBe(9);
    expect(planMeterFill(0, 0, 5)).toBe(0);

    const todos: Todo[] = [
      { content: 'One', status: 'completed' },
      { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
      { content: 'Three', status: 'pending' },
    ];
    const output = stripAnsi(
      render(
        <ThemeContext.Provider value={DEFAULT_THEME}>
          <AgentTodoList todos={todos} terminalWidth={80} />
        </ThemeContext.Provider>,
      ).lastFrame(),
    );

    expect(output).toContain('Plan  █░░  1/3');
    expect(output).toContain('✓ One');
    expect(output).toContain('› Doing two');
    expect(output).toContain('· Three');
  });

  it('drops the meter but keeps the count on a narrow terminal', () => {
    const todos: Todo[] = [{ content: 'Only step', status: 'pending' }];
    const output = stripAnsi(
      render(
        <ThemeContext.Provider value={DEFAULT_THEME}>
          <AgentTodoList todos={todos} terminalWidth={36} />
        </ThemeContext.Provider>,
      ).lastFrame(),
    );

    expect(output).toContain('Plan  0/1');
    expect(output).not.toContain('░');
  });

  it('keeps a long step on one row, aligned with the transcript column', () => {
    // `[marker][text]` is 2 + grid.content wide, and grid.content is already
    // measured *from* CONTENT_COLUMN — so a full-measure row lands on
    // `width - 1` and leaves the trailing column the grid reserves. Writing
    // that last cell makes some terminals emit a spurious wrap.
    const step =
      'A step whose wording runs a very long way past the measure of any terminal window';

    for (const width of [20, 24, 32, 40, 60, 80]) {
      const todos: Todo[] = [
        { content: step, status: 'pending' },
        { content: step, status: 'in_progress', activeForm: step },
        { content: step, status: 'completed' },
      ];
      const output = stripAnsi(
        render(
          <ThemeContext.Provider value={DEFAULT_THEME}>
            <AgentTodoList todos={todos} terminalWidth={width} />
          </ThemeContext.Provider>,
        ).lastFrame(),
      );

      const rows = output.split('\n').filter((row) => row.trim());
      // Header plus one row per step: nothing wrapped.
      expect(rows).toHaveLength(4);
      expect(Math.max(...rows.map((row) => displayWidth(row)))).toBe(width - 1);
      // Marker in the gutter, wording on the shared content column.
      expect(rows[1].startsWith('· ')).toBe(true);
      expect(rows[0].indexOf('Plan')).toBe(rows[1].indexOf('A step'));
    }
  });
});
