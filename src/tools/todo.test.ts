import { describe, it, expect } from 'vitest';
import { todoTools } from './todo.js';
import type { ToolContext } from '../types/tools.js';

const ctx: ToolContext = { workspaceRoot: '.', env: {} };
const todoWrite = todoTools.find((t) => t.name === 'TodoWrite')!;

describe('TodoWrite', () => {
  it('accepts a full todo list and returns success', async () => {
    const r = await todoWrite.execute(
      {
        todos: [
          { content: 'Read file', status: 'completed', activeForm: 'Reading file' },
          { content: 'Edit file', status: 'in_progress', activeForm: 'Editing file' },
          { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
        ],
      },
      ctx,
    );
    expect(r.status).toBe('success');
    expect(r.content).toMatch(/Todos updated/);
  });

  it('rejects more than one in_progress todo', async () => {
    const r = await todoWrite.execute(
      {
        todos: [
          { content: 'A', status: 'in_progress', activeForm: 'Doing A' },
          { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
        ],
      },
      ctx,
    );
    expect(r.status).toBe('error');
    expect(r.structuredError?.message).toMatch(/one todo may be in_progress/i);
  });

  it('rejects an invalid status', async () => {
    const r = await todoWrite.execute(
      {
        todos: [{ content: 'A', status: 'bogus', activeForm: 'Doing A' }],
      },
      ctx,
    );
    expect(r.status).toBe('error');
    expect(r.structuredError?.message).toMatch(/status/i);
  });

  it('accepts an empty list (clears todos)', async () => {
    const r = await todoWrite.execute({ todos: [] }, ctx);
    expect(r.status).toBe('success');
  });
});
