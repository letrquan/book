import chalk from 'chalk';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import type { Task } from '../hooks/useTasks.js';
import { TaskList } from './TaskList.js';

afterEach(cleanup);

/** The truecolor escape chalk writes for a `#RRGGBB` token. */
function ink(token: string): string {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(token.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
  return `\u001b[38;2;${r};${g};${b}m`;
}

function tasks(...statuses: Task['status'][]): Task[] {
  return statuses.map((status, index) => ({
    id: `task-${index + 1}`,
    subject: `Task ${index + 1}`,
    status,
    createdAt: index,
  }));
}

// Ink styles through chalk, which emits nothing off a TTY; force truecolor so
// the ink a check is drawn in is visible in the frame.
function colourFrame(list: Task[]): string {
  const level = chalk.level;
  chalk.level = 3;
  try {
    return (
      render(
        <ThemeContext.Provider value={DEFAULT_THEME}>
          <TaskList tasks={list} onUpdateStatus={() => {}} onRemove={() => {}} width={80} />
        </ThemeContext.Provider>,
      ).lastFrame() ?? ''
    );
  } finally {
    chalk.level = level;
  }
}

/**
 * The `/task` sheet shares the steps' status table, so a finished task wears
 * the same grey check a finished tool row wears; only the step in hand takes
 * the rubric.
 */
describe('TaskList', () => {
  it('greys the check on a finished task', () => {
    const frame = colourFrame(tasks('completed', 'in_progress', 'pending'));

    expect(frame).toContain(`${ink(DEFAULT_THEME.inactive)}✓`);
    expect(frame).not.toContain(ink(DEFAULT_THEME.success));
    expect(frame).toContain(`${ink(DEFAULT_THEME.brand)}◔`);
  });
});
