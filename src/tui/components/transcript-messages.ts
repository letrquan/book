import type { Message } from '../../types/messages.js';
import { splitReasoningParts } from '../../reasoning-tags.js';

/**
 * Whether assistant content draws nothing.
 *
 * An empty reasoning block counts as blank. Routers that inline thinking emit
 * `<think></think>` ahead of every tool call, and treating that as content kept
 * each of those turns as a separate transcript entry with its own spacing: two
 * blank rows between every tool row of a run. A block with reasoning in it is
 * not blank, since it renders as a thought row.
 */
export function isBlankAssistantContent(content: string | undefined | null): boolean {
  if (!content || content.trim().length === 0) return true;
  return splitReasoningParts(content).every((part) => part.text.trim().length === 0);
}

/**
 * Whether a message delegates. AgentMessage hides a delegating message's
 * narration (the spawn has its own activity row), so a delegating turn must
 * never merge into one that carries narration, or that narration vanishes.
 */
export function delegatesWork(message: Message): boolean {
  return Boolean(message.toolCalls?.some((call) => call.name === 'AgentSpawn'));
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
      if (delegatesWork(next)) break;
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
