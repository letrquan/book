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

/**
 * Clear the text and reasoning streamed into a message, keeping the message.
 *
 * Used when the loop abandons an attempt and retries the same turn: the deltas
 * are already on screen and cannot be unsent, so the host drops them and lets the
 * replacement stream into the same row. Tool activity is left alone — a retry
 * only happens when the attempt produced none.
 */
export function resetStreamedContent(messages: Message[], id: string): Message[] {
  const index = findMessageIndex(messages, id);
  if (index === -1) return messages;
  const message = messages[index];
  if (message.content === '' && !message.reasoningContent) return messages;
  const next = messages.slice();
  next[index] = { ...message, content: '', reasoningContent: undefined };
  return next;
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

/** What the streaming message holds, tracked as events arrive: the accumulator applies them a flush later. */
export interface StreamOutput {
  /** Text, reasoning or tool activity since the message was created. */
  any: boolean;
  /** Tool calls or results, which a discarded attempt leaves in place. */
  tools: boolean;
  /** A compaction committed behind this message's output: the turn's next output opens a new message. */
  closed: boolean;
}

export function freshStreamOutput(): StreamOutput {
  return { any: false, tools: false, closed: false };
}

/**
 * Where a compaction's transcript row goes, and whether that is after the streaming message. While
 * the message has streamed nothing (a compaction at its turn's preflight gate, or an overflow
 * recovery that retries the turn) the row goes before it, because the turn's reply streams into it.
 * Once it has output the row goes after it, and the turn's next output opens a message of its own.
 * A streaming message not in `messages` yet is still being appended, and lands at `messages.length`.
 */
export function compactionPlacement(
  messages: readonly Message[],
  streamingId: string | null | undefined,
  hasOutput: boolean,
): { ordinal: number; afterStreaming: boolean } {
  if (!streamingId) return { ordinal: messages.length, afterStreaming: false };
  const index = messages.findIndex((message) => message.id === streamingId);
  if (!hasOutput) return { ordinal: index >= 0 ? index : messages.length, afterStreaming: false };
  return { ordinal: index >= 0 ? messages.length : messages.length + 1, afterStreaming: true };
}
