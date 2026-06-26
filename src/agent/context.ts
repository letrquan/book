import { platform, release, hostname } from 'os';
import type { AgentConfig, Message, ToolDefinition } from '../types.js';
import { getTodos } from '../tools/todo.js';

function buildSystemPrompt(config: AgentConfig): string {
  const todos = getTodos();
  const todoSection =
    todos.length > 0
      ? '\n\n## Current task list\n' +
        todos
          .map((t) => {
            const mark =
              t.status === 'completed'
                ? '[x]'
                : t.status === 'in_progress'
                  ? '[>]'
                  : '[ ]';
            return `${mark} ${t.content}${
              t.status === 'in_progress' && t.activeForm ? ` (now: ${t.activeForm})` : ''
            }`;
          })
          .join('\n') +
        '\n\nKeep this list current via the TodoWrite tool.'
      : '';

  return `You are Book, an AI coding agent. You help users write, fix, and understand code.

You are running on: ${platform()} ${release()} (${hostname()})
Workspace: ${config.workspace}
Current date: ${new Date().toISOString().split('T')[0]}

You have access to tools for reading/writing files, running shell commands,
searching code, and interacting with git. Use them to help the user.

Be concise and direct. Write code when asked. Explain only when asked.${todoSection}`;
}

type ProviderMessage = {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export function buildMessages(
  config: AgentConfig,
  history: Message[],
  tools: ToolDefinition[],
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];

  messages.push({ role: 'system', content: buildSystemPrompt(config) });

  for (const msg of history) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const assistant: ProviderMessage = {
        role: 'assistant',
        // OpenAI rejects null content when tool_calls is absent, so coerce to ''.
        content:
          msg.content && msg.content.length > 0
            ? msg.content
            : msg.toolCalls?.length
              ? null
              : '',
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        assistant.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          },
        }));
      }
      messages.push(assistant);

      // Tool results MUST follow the assistant message that produced them,
      // in the same order as the tool_calls array.
      if (msg.toolResults) {
        const byId = new Map(msg.toolCalls?.map((tc) => [tc.id, tc]));
        for (const result of msg.toolResults) {
          // Only emit results for tool calls present on this assistant message.
          if (byId.has(result.toolCallId)) {
            messages.push({
              role: 'tool',
              tool_call_id: result.toolCallId,
              content: result.success
                ? result.output
                : `ERROR: ${result.error ?? 'tool failed'}\n${result.output ?? ''}`,
            });
          }
        }
      }
    }
  }

  return messages;
}
