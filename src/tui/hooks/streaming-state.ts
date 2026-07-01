import type { Message, ToolCall, ToolResult } from '../../types.js';

export function makeMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    timestamp: Date.now(),
  };
}

function findMessageIndex(messages: Message[], id: string): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].id === id) return i;
  }
  return -1;
}

export function appendContentToMessage(
  messages: Message[],
  id: string,
  content: string,
): Message[] {
  const index = findMessageIndex(messages, id);
  if (index === -1) return messages;
  const next = messages.slice();
  const message = messages[index];
  next[index] = { ...message, content: message.content + content };
  return next;
}

export function appendToolCallToMessage(
  messages: Message[],
  id: string,
  call: ToolCall,
): Message[] {
  const index = findMessageIndex(messages, id);
  if (index === -1) return messages;
  const next = messages.slice();
  const message = messages[index];
  next[index] = { ...message, toolCalls: [...(message.toolCalls ?? []), call] };
  return next;
}

export function appendToolResultToMessage(
  messages: Message[],
  id: string,
  result: ToolResult,
): Message[] {
  const index = findMessageIndex(messages, id);
  if (index === -1) return messages;
  const next = messages.slice();
  const message = messages[index];
  next[index] = { ...message, toolResults: [...(message.toolResults ?? []), result] };
  return next;
}
