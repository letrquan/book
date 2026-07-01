import type { Message, ToolCall, ToolResult } from '../../types.js';

export function makeMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
  };
}

export function appendContentToMessage(messages: Message[], id: string, content: string): Message[] {
  return messages.map((message) =>
    message.id === id ? { ...message, content: message.content + content } : message,
  );
}

export function appendToolCallToMessage(messages: Message[], id: string, call: ToolCall): Message[] {
  return messages.map((message) =>
    message.id === id
      ? { ...message, toolCalls: [...(message.toolCalls ?? []), call] }
      : message,
  );
}

export function appendToolResultToMessage(messages: Message[], id: string, result: ToolResult): Message[] {
  return messages.map((message) =>
    message.id === id
      ? { ...message, toolResults: [...(message.toolResults ?? []), result] }
      : message,
  );
}
