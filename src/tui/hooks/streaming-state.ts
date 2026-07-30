import type { Message } from '../../types/messages.js';
import type { NestedToolInvocation, ToolCall, ToolResult } from '../../types/tools.js';

export function makeMessage(
  role: 'user' | 'assistant',
  content: string,
  contextContent?: string,
  includeInContext = false,
): Message {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    contextContent,
    includeInContext,
    timestamp: Date.now(),
  };
}

function findMessageIndex(messages: Message[], id: string): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].id === id) return i;
  }
  return -1;
}

/** True when an assistant message has no text and no tool activity. */
export function isTotallyEmptyAssistant(message: Message): boolean {
  if (message.role !== 'assistant') return false;
  if (message.content !== '') return false;
  if (message.reasoningContent) return false;
  if ((message.toolCalls?.length ?? 0) > 0) return false;
  if ((message.toolResults?.length ?? 0) > 0) return false;
  if ((message.nestedToolInvocations?.length ?? 0) > 0) return false;
  return true;
}

/**
 * Drop only a trailing totally-empty assistant placeholder.
 * Partial content, tools, or non-trailing empties are left untouched.
 */
export function removeTrailingEmptyAssistantPlaceholder(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  if (!isTotallyEmptyAssistant(last)) return messages;
  return messages.slice(0, -1);
}

export function appendContentToMessage(
  messages: Message[],
  id: string,
  content: string,
): Message[] {
  if (content === '') return messages;
  const index = findMessageIndex(messages, id);
  if (index === -1) return messages;
  const next = messages.slice();
  const message = messages[index];
  next[index] = { ...message, content: message.content + content };
  return next;
}

export function appendReasoningToMessage(
  messages: Message[],
  id: string,
  reasoning: string,
): Message[] {
  if (reasoning === '') return messages;
  const index = findMessageIndex(messages, id);
  if (index === -1) return messages;
  const next = messages.slice();
  const message = messages[index];
  next[index] = {
    ...message,
    reasoningContent: (message.reasoningContent ?? '') + reasoning,
  };
  return next;
}

/** Upsert a top-level tool call by stable `call.id` (append-only for new ids). */
export function appendToolCallToMessage(
  messages: Message[],
  id: string,
  call: ToolCall,
): Message[] {
  const index = findMessageIndex(messages, id);
  if (index === -1) return messages;
  const message = messages[index];
  const existing = message.toolCalls ?? [];
  const existingIndex = existing.findIndex((item) => item.id === call.id);
  let toolCalls: ToolCall[];
  if (existingIndex === -1) {
    toolCalls = [...existing, call];
  } else if (existing[existingIndex] === call) {
    return messages;
  } else {
    toolCalls = existing.slice();
    toolCalls[existingIndex] = call;
  }
  const next = messages.slice();
  next[index] = { ...message, toolCalls };
  return next;
}

/** Upsert a top-level tool result by stable `toolCallId`. */
export function appendToolResultToMessage(
  messages: Message[],
  id: string,
  result: ToolResult,
): Message[] {
  const index = findMessageIndex(messages, id);
  if (index === -1) return messages;
  const message = messages[index];
  const existing = message.toolResults ?? [];
  const existingIndex = existing.findIndex((item) => item.toolCallId === result.toolCallId);
  let toolResults: ToolResult[];
  if (existingIndex === -1) {
    toolResults = [...existing, result];
  } else if (existing[existingIndex] === result) {
    return messages;
  } else {
    toolResults = existing.slice();
    toolResults[existingIndex] = result;
  }
  const next = messages.slice();
  next[index] = { ...message, toolResults };
  return next;
}

/** Upsert a nested tool invocation by stable `traceId`. */
export function appendNestedToolInvocationToMessage(
  messages: Message[],
  id: string,
  invocation: NestedToolInvocation,
): Message[] {
  const index = findMessageIndex(messages, id);
  if (index === -1) return messages;
  const message = messages[index];
  const existing = message.nestedToolInvocations ?? [];
  const existingIndex = existing.findIndex((item) => item.traceId === invocation.traceId);
  let nestedToolInvocations: NestedToolInvocation[];
  if (existingIndex === -1) {
    nestedToolInvocations = [...existing, invocation];
  } else {
    const prev = existing[existingIndex];
    // Preserve an already-attached result unless the upsert carries a newer one.
    const merged: NestedToolInvocation = {
      ...prev,
      ...invocation,
      result: invocation.result ?? prev.result,
    };
    if (
      prev.traceId === merged.traceId &&
      prev.parentTraceId === merged.parentTraceId &&
      prev.call === merged.call &&
      prev.result === merged.result
    ) {
      return messages;
    }
    nestedToolInvocations = existing.slice();
    nestedToolInvocations[existingIndex] = merged;
  }
  const next = messages.slice();
  next[index] = { ...message, nestedToolInvocations };
  return next;
}

/** Attach/replace a nested tool result by stable `traceId`. */
export function appendNestedToolResultToMessage(
  messages: Message[],
  id: string,
  traceId: string,
  result: ToolResult,
): Message[] {
  const index = findMessageIndex(messages, id);
  if (index === -1) return messages;
  const message = messages[index];
  const invocations = message.nestedToolInvocations ?? [];
  const invocationIndex = invocations.findIndex((invocation) => invocation.traceId === traceId);
  if (invocationIndex === -1) return messages;
  if (invocations[invocationIndex].result === result) return messages;

  const nestedToolInvocations = invocations.slice();
  nestedToolInvocations[invocationIndex] = {
    ...nestedToolInvocations[invocationIndex],
    result,
  };
  const next = messages.slice();
  next[index] = { ...message, nestedToolInvocations };
  return next;
}
