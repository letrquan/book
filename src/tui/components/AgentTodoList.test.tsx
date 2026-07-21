import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import type { Todo } from '../../tools/todo.js';
import { AgentTodoList, shouldShowAgentPlan, visibleAgentTodos } from './AgentTodoList.js';

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
    expect(output).toContain('and 2 more');
  });
});
