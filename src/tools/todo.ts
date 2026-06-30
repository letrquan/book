import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface Todo {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

function isTodoList(value: unknown): value is Todo[] {
  return Array.isArray(value);
}

async function todoWrite(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const todos = args.todos;
  if (!isTodoList(todos)) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: 'todos must be an array',
    };
  }

  const validStatuses = new Set(['pending', 'in_progress', 'completed']);
  const parsed: Todo[] = [];
  for (let i = 0; i < todos.length; i++) {
    const t = todos[i] as unknown as Record<string, unknown>;
    if (typeof t.content !== 'string' || t.content.length === 0) {
      return {
        toolCallId: '',
        success: false,
        output: '',
        error: `Todo ${i + 1}: missing or empty 'content'`,
      };
    }
    const status = t.status as string;
    if (!validStatuses.has(status)) {
      return {
        toolCallId: '',
        success: false,
        output: '',
        error: `Todo ${i + 1}: invalid status '${status}' (must be pending, in_progress, or completed)`,
      };
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
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `Only one todo may be in_progress at a time (got ${inProgress.length}). Mark the others pending or completed first.`,
    };
  }

  // Write todos into ToolContext (eliminates module-level mutable state).
  ctx.todos = parsed;

  const summary = parsed.length
    ? parsed
        .map((t) => {
          const mark =
            t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○';
          return `  ${mark} ${t.content}`;
        })
        .join('\n')
    : '  (no todos)';

  return {
    toolCallId: '',
    success: true,
    output: `Todos updated (${parsed.length}).\n${summary}`,
  };
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
