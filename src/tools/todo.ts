import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { toolFailure, toolSuccess } from './result.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

function isTodoList(value: unknown): value is Todo[] {
  return Array.isArray(value);
}

const TODO_STATUSES: ReadonlySet<string> = new Set(['pending', 'in_progress', 'completed']);

/**
 * Restore todos from a persisted plan record, dropping anything malformed.
 *
 * A record on disk is untrusted input — it may predate a status change or have
 * been hand-edited — and one bad entry must not cost the whole restored plan.
 */
export function normalizePersistedTodos(
  todos: ReadonlyArray<{ content?: unknown; status?: unknown; activeForm?: unknown }> | undefined,
): Todo[] {
  const restored: Todo[] = [];
  for (const todo of todos ?? []) {
    if (typeof todo?.content !== 'string' || todo.content.length === 0) continue;
    if (typeof todo.status !== 'string' || !TODO_STATUSES.has(todo.status)) continue;
    restored.push({
      content: todo.content,
      status: todo.status as TodoStatus,
      activeForm: typeof todo.activeForm === 'string' ? todo.activeForm : undefined,
    });
  }
  return restored;
}

async function todoWrite(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const todos = args.todos;
  if (!isTodoList(todos)) {
    return toolFailure('todos must be an array');
  }

  const parsed: Todo[] = [];
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i] as unknown as Record<string, unknown>;
    if (typeof t.content !== 'string' || t.content.length === 0) {
      return toolFailure(`Todo ${i + 1}: missing or empty 'content'`);
    }
    const status = t.status as string;
    if (!TODO_STATUSES.has(status)) {
      return toolFailure(
        `Todo ${i + 1}: invalid status '${status}' (must be pending, in_progress, or completed)`,
      );
    }
    parsed.push({
      content: t.content,
      status: status as TodoStatus,
      activeForm: typeof t.activeForm === 'string' ? t.activeForm : undefined,
    });
  }

  // Enforce at most one in_progress todo.
  const inProgress = parsed.filter((t) => t.status === 'in_progress');
  if (inProgress.length > 1) {
    return toolFailure(
      `Only one todo may be in_progress at a time (got ${inProgress.length}). Mark the others pending or completed first.`,
    );
  }

  // Write todos into ToolContext (eliminates module-level mutable state).
  //
  // Mutate in place rather than reassigning. `ctx.todos` is bound to the array
  // `SessionRuntime` owns (the loop seeds it per invocation), the same discipline
  // `tools/tasks.ts` already follows. Reassigning would detach the context from
  // the runtime's array, so every later read — the seed on the next invocation,
  // the `<session-state>` render, the persistence writer — would see a stale list
  // while this one silently diverged.
  if (ctx.todos) {
    ctx.todos.length = 0;
    ctx.todos.push(...parsed);
  } else {
    ctx.todos = parsed;
  }

  const summary = parsed.length
    ? parsed
        .map((t) => {
          const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○';
          return `  ${mark} ${t.content}`;
        })
        .join('\n')
    : '  (no todos)';

  return toolSuccess(`Todos updated (${parsed.length}).\n${summary}`, { data: parsed });
}

export const todoTools: ToolDefinition[] = [
  {
    name: 'TodoWrite',
    description:
      'Write the full agent todo list. Use this to track multi-step work: set status to in_progress for the one task you are currently doing, completed for finished steps, pending for upcoming. Only one todo may be in_progress at a time. Pass the ENTIRE updated list each call (this replaces, not appends).',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The full todo list (replaces the previous list)',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'Short description of the task',
              },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current state of the task',
              },
              activeForm: {
                type: 'string',
                description: 'Present-continuous form shown in the spinner (e.g. "Editing file")',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    execute: todoWrite,
  },
];
