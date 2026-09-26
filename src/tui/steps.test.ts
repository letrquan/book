import { describe, expect, it } from 'vitest';
import type { Todo, TodoStatus } from '../tools/todo.js';
import { statusStepLabel, stepProgress, stepWindow } from './steps.js';

function plan(statuses: TodoStatus[]): Todo[] {
  return statuses.map((status, index) => ({ content: `Step ${index + 1}`, status }));
}

const names = (todos: readonly Todo[]) => todos.map((todo) => todo.content);

describe('stepWindow', () => {
  it('lists every step when the plan fits', () => {
    const todos = plan(['completed', 'in_progress', 'pending']);
    expect(stepWindow(todos, 8)).toEqual({ before: [], rows: todos, after: 0 });
  });

  it('follows the step in flight with one step of context above it', () => {
    const todos = plan([
      'completed',
      'completed',
      'completed',
      'in_progress',
      ...Array<TodoStatus>(8).fill('pending'),
    ]);
    const window = stepWindow(todos, 8);
    expect(names(window.before)).toEqual(['Step 1', 'Step 2']);
    expect(names(window.rows)).toEqual([
      'Step 3',
      'Step 4',
      'Step 5',
      'Step 6',
      'Step 7',
      'Step 8',
      'Step 9',
      'Step 10',
    ]);
    expect(window.after).toBe(2);
  });

  it('never runs past the end of the plan', () => {
    const todos = plan([...Array<TodoStatus>(11).fill('completed'), 'in_progress']);
    const window = stepWindow(todos, 8);
    expect(window.before).toHaveLength(4);
    expect(names(window.rows).at(-1)).toBe('Step 12');
    expect(window.after).toBe(0);
  });

  it('lists a lone step instead of folding it', () => {
    const nine = plan(['in_progress', ...Array<TodoStatus>(8).fill('pending')]);
    expect(stepWindow(nine, 8)).toEqual({ before: [], rows: nine, after: 0 });

    const twelve = plan([
      'completed',
      'completed',
      'in_progress',
      ...Array<TodoStatus>(9).fill('pending'),
    ]);
    const window = stepWindow(twelve, 8);
    expect(window.before).toEqual([]);
    expect(names(window.rows)[0]).toBe('Step 1');
    expect(window.rows).toHaveLength(9);
    expect(window.after).toBe(3);
  });

  it('follows the first unfinished step when none is in flight', () => {
    const todos = plan([
      ...Array<TodoStatus>(5).fill('completed'),
      ...Array<TodoStatus>(7).fill('pending'),
    ]);
    const window = stepWindow(todos, 8);
    expect(names(window.rows)[0]).toBe('Step 5');
    expect(names(window.rows)[1]).toBe('Step 6');
  });
});

describe('stepProgress', () => {
  it('counts the finished steps', () => {
    expect(stepProgress(plan(['completed', 'completed', 'in_progress', 'pending']))).toBe(
      '2 of 4 done',
    );
  });
});

describe('statusStepLabel', () => {
  it('numbers the step in flight by its place in the plan', () => {
    expect(statusStepLabel(plan(['completed', 'pending', 'in_progress', 'pending']))).toBe(
      'step 3/4',
    );
  });

  it('counts finished steps when none is in flight', () => {
    expect(statusStepLabel(plan(['completed', 'completed', 'pending']))).toBe('2/3 done');
  });

  it('says nothing about a finished or absent plan', () => {
    expect(statusStepLabel(plan(['completed', 'completed']))).toBeUndefined();
    expect(statusStepLabel([])).toBeUndefined();
  });
});
