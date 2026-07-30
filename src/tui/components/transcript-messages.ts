import type { Message } from '../../types/messages.js';

export function isBlankAssistantContent(content: string | undefined | null): boolean {
  return !content || content.trim().length === 0;
}

/** Merge completed tool-only assistant messages into the preceding assistant turn for display. */
export function mergeAssistantMessages(
  messages: Message[],
  streamingMessageId?: string | null,
): Message[] {
  if (messages.length <= 1) return messages;

  const merged: Message[] = [];
  let index = 0;
  while (index < messages.length) {
    const current = messages[index];
    if (current.role !== 'assistant') {
      merged.push(current);
      index++;
      continue;
    }

    let mergedMessage: Message = { ...current };
    let nextIndex = index + 1;
    while (nextIndex < messages.length) {
      const next = messages[nextIndex];
      if (next.role !== 'assistant') break;
      if (!isBlankAssistantContent(next.content)) break;
      if (next.id === streamingMessageId) break;
      mergedMessage = {
        ...mergedMessage,
        reasoningContent:
          [mergedMessage.reasoningContent, next.reasoningContent]
            .filter((value): value is string => Boolean(value))
            .join('\n\n') || undefined,
        toolCalls: [...(mergedMessage.toolCalls ?? []), ...(next.toolCalls ?? [])],
        toolResults: [...(mergedMessage.toolResults ?? []), ...(next.toolResults ?? [])],
        nestedToolInvocations: [
          ...(mergedMessage.nestedToolInvocations ?? []),
          ...(next.nestedToolInvocations ?? []),
        ],
      };
      nextIndex++;
    }
    merged.push(mergedMessage);
    index = nextIndex;
  }

  return merged;
}
