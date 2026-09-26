import type { Todo } from '../tools/todo.js';

/** Most step rows the Steps sheet lists before it folds the rest into counts. */
export const STEP_SHEET_ROWS = 8;

export interface StepWindow {
  /** Steps above the window, folded into one row. */
  before: Todo[];
  /** Steps listed row by row. */
  rows: Todo[];
  /** How many steps sit below the window. */
  after: number;
}

/**
 * The steps a sheet of `limit` rows lists.
 *
 * The window follows the step in flight, keeping one step of context above it,
 * and shifts up only when it would otherwise run past the end. The first five
 * steps used to be listed whatever the progress, with the active step swapped
 * into the last row, so a long plan spent its rows on finished work and hid the
 * steps in between.
 */
export function stepWindow(todos: readonly Todo[], limit = STEP_SHEET_ROWS): StepWindow {
  if (todos.length <= limit) return { before: [], rows: [...todos], after: 0 };
  const active = todos.findIndex((todo) => todo.status === 'in_progress');
  const unfinished = todos.findIndex((todo) => todo.status !== 'completed');
  const focus = active >= 0 ? active : unfinished >= 0 ? unfinished : todos.length - 1;
  let from = Math.max(0, Math.min(focus - 1, todos.length - limit));
  let to = from + limit;
  // A fold row takes the row its one step would have filled, so a lone step
  // is listed rather than folded.
  if (from === 1) from = 0;
  if (todos.length - to === 1) to = todos.length;
  return { before: todos.slice(0, from), rows: todos.slice(from, to), after: todos.length - to };
}

/** Where a plan stands: `2 of 7 done`. */
export function stepProgress(todos: readonly Todo[]): string {
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return `${done} of ${todos.length} done`;
}

/**
 * The status line's note on the plan: `step 3/7` while a step is in flight,
 * `2/7 done` between steps, and nothing once the plan is finished or absent.
 */
export function statusStepLabel(todos: readonly Todo[]): string | undefined {
  if (todos.length === 0) return undefined;
  const done = todos.filter((todo) => todo.status === 'completed').length;
  if (done === todos.length) return undefined;
  const active = todos.findIndex((todo) => todo.status === 'in_progress');
  return active >= 0 ? `step ${active + 1}/${todos.length}` : `${done}/${todos.length} done`;
}
