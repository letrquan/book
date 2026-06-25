import type { AgentConfig, Message, ToolCall, ToolResult, ToolContext, AgentLoopCallbacks } from '../types.js';
import { chatCompletionStream } from '../provider/openai-compatible.js';
import { buildMessages } from './context.js';
import type { ToolRegistry } from '../tools/registry.js';

const PERMISSION_TOOLS = new Set(['bash', 'write_file', 'edit_file', 'git_commit']);

function needsPermission(toolName: string, mode: string): boolean {
  if (mode === 'auto') return false;
  if (mode === 'plan') return true;
  if (mode === 'accept-edits') {
    return toolName !== 'edit_file' && toolName !== 'write_file';
  }
  return PERMISSION_TOOLS.has(toolName);
}

export async function runAgentLoop(
  config: AgentConfig,
  registry: ToolRegistry,
  userMessage: string,
  history: Message[],
  callbacks: AgentLoopCallbacks,
  mode: string = 'default',
): Promise<Message[]> {
  const newHistory = [...history];

  newHistory.push({
    id: crypto.randomUUID(),
    role: 'user',
    content: userMessage,
    timestamp: Date.now(),
  });

  const toolContext: ToolContext = {
    workspaceRoot: config.workspace,
    env: process.env as Record<string, string>,
  };

  let turn = 0;
  let approveAll: string[] = [];

  while (turn < config.maxTurns) {
    turn++;
    callbacks.onTurnStart(turn);

    const messages = buildMessages(config, newHistory, registry.getDefinitions());
    let assistantContent = '';
    const toolCalls: ToolCall[] = [];

    const stream = chatCompletionStream(config, messages, registry.getDefinitions());

    for await (const event of stream) {
      if (event.type === 'text' && event.content) {
        assistantContent += event.content;
        callbacks.onText(event.content);
      } else if (event.type === 'tool_call' && event.toolCall) {
        toolCalls.push(event.toolCall);
        callbacks.onToolCall(event.toolCall);
      } else if (event.type === 'error' && event.error) {
        callbacks.onError(event.error);
        return newHistory;
      }
    }

    const estimatedTokens = assistantContent.length > 0
      ? Math.ceil(assistantContent.length / 4)
      : 0;
    callbacks.onTokenCount(estimatedTokens);

    const toolResults: ToolResult[] = [];
    for (const call of toolCalls) {
      if (needsPermission(call.name, mode) && !approveAll.includes(call.name)) {
        const permission = await callbacks.onPermissionRequired(call);
        if (permission === 'deny') {
          toolResults.push({
            toolCallId: call.id,
            success: false,
            output: '',
            error: 'SKIPPED: Permission denied',
          });
          continue;
        }
        if (permission === 'always') {
          approveAll.push(call.name);
        }
      }

      const result = await registry.execute(call, toolContext);
      result.toolCallId = call.id;
      toolResults.push(result);
      callbacks.onToolResult(result);
    }

    newHistory.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: assistantContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      timestamp: Date.now(),
    });

    if (toolCalls.length === 0) {
      break;
    }
  }

  if (turn >= config.maxTurns) {
    callbacks.onError(`Reached max turns (${config.maxTurns}). Refine your prompt or increase BOOK_MAX_TURNS.`);
  }

  callbacks.onDone();
  return newHistory;
}

export { PERMISSION_TOOLS, needsPermission };
