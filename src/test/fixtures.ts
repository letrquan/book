import type { Message, ToolCall, ToolResult } from '../types.js';

export function userMsg(content: string): Message {
  return { id: 'u1', role: 'user', content, timestamp: 0 };
}

export function assistantMsg(
  content: string,
  toolCalls?: ToolCall[],
  toolResults?: ToolResult[],
): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content,
    toolCalls,
    toolResults,
    timestamp: 0,
  };
}

export function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): ToolCall {
  return { id, name, arguments: args };
}

export function toolResult(toolCallId: string, output: string, success = true): ToolResult {
  return { toolCallId, success, output, error: success ? undefined : 'err' };
}
