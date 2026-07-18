import type { Message } from '../../types.js';

/** Structural view of the persisted CompactBoundary type. */
export interface TranscriptCompactBoundary {
  id: string;
  timestamp: number;
  trigger: 'manual' | 'auto';
  afterTranscriptOrdinal: number;
  preContextMessages: number;
  retainedContextMessages: number;
  preContextTokens?: number;
  estimatedPostTokens?: number;
  checkpointVersion: number;
  generation: number;
}

export type TranscriptItem =
  | { type: 'message'; id: string; message: Message }
  | { type: 'compact_boundary'; id: string; boundary: TranscriptCompactBoundary };

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

/**
 * Interleave durable compact boundaries with the append-only transcript.
 * `afterTranscriptOrdinal` is a message count, so a value of N places the
 * boundary after the first N transcript messages and before message N + 1.
 */
export function buildTranscriptItems(
  messages: Message[],
  compactBoundaries: TranscriptCompactBoundary[],
  streamingMessageId?: string | null,
): TranscriptItem[] {
  const orderedBoundaries = compactBoundaries
    .map((boundary, order) => ({ boundary, order }))
    .sort(
      (a, b) =>
        a.boundary.afterTranscriptOrdinal - b.boundary.afterTranscriptOrdinal ||
        a.boundary.timestamp - b.boundary.timestamp ||
        a.boundary.generation - b.boundary.generation ||
        a.order - b.order,
    );

  const items: TranscriptItem[] = [];
  let boundaryIndex = 0;
  let segment: Message[] = [];

  const flushMessages = () => {
    for (const message of mergeAssistantMessages(segment, streamingMessageId)) {
      items.push({ type: 'message', id: message.id, message });
    }
    segment = [];
  };

  for (let ordinal = 0; ordinal <= messages.length; ordinal++) {
    while (
      boundaryIndex < orderedBoundaries.length &&
      orderedBoundaries[boundaryIndex].boundary.afterTranscriptOrdinal <= ordinal
    ) {
      flushMessages();
      const boundary = orderedBoundaries[boundaryIndex].boundary;
      items.push({ type: 'compact_boundary', id: boundary.id, boundary });
      boundaryIndex++;
    }
    if (ordinal < messages.length) segment.push(messages[ordinal]);
  }

  flushMessages();
  while (boundaryIndex < orderedBoundaries.length) {
    const boundary = orderedBoundaries[boundaryIndex].boundary;
    items.push({ type: 'compact_boundary', id: boundary.id, boundary });
    boundaryIndex++;
  }

  return items;
}
