import { useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '../../types.js';

/**
 * Ink's <Static> permanently writes newly appended items. Completed streaming
 * messages must leave the dynamic tree for one ownership-gap frame before they
 * enter Static, otherwise wrapped suffixes can duplicate in scrollback.
 *
 * Ownership is commit/effect-driven (no render-time ref mutation, no 50ms timer):
 * - streaming id changes enqueue the previous id immediately (render-time state sync)
 * - that committed frame is the ownership gap (id is neither active nor static)
 * - a passive effect then releases the queue head (FIFO)
 * - active / withheld / static zones stay disjoint
 */

export type StaticHandoffState = {
  /** Last streaming id observed by the handoff machine. */
  observedStreamingId: string | null | undefined;
  /** FIFO of message ids withheld from Static (and not active). */
  withheldQueue: string[];
};

export type MessageZones = {
  activeId: string | null;
  withheldIds: ReadonlySet<string>;
  staticIds: ReadonlySet<string>;
};

export function createStaticHandoffState(
  streamingMessageId: string | null | undefined = null,
): StaticHandoffState {
  return {
    observedStreamingId: streamingMessageId ?? null,
    withheldQueue: [],
  };
}

export function handoffStatesEqual(a: StaticHandoffState, b: StaticHandoffState): boolean {
  return (
    a.observedStreamingId === b.observedStreamingId &&
    a.withheldQueue.length === b.withheldQueue.length &&
    a.withheldQueue.every((id, index) => id === b.withheldQueue[index])
  );
}

/** Whitespace-only assistant text is treated as empty for tool-only merging. */
export function isBlankAssistantContent(content: string | undefined | null): boolean {
  return !content || content.trim().length === 0;
}

/**
 * Merge adjacent assistant messages where the later message has no visible
 * content but has tool calls/results. Display-only — does not mutate inputs.
 * Never merges the active streaming id or withheld handoff ids.
 */
export function mergeAssistantMessages(
  messages: Message[],
  streamingMessageId?: string | null,
  handoffMessageIds: ReadonlySet<string> = new Set(),
): Message[] {
  if (messages.length <= 1) return messages;
  const merged: Message[] = [];
  let i = 0;
  while (i < messages.length) {
    const current = messages[i];
    if (current.role !== 'assistant') {
      merged.push(current);
      i++;
      continue;
    }
    // Look ahead: merge any following assistant messages that have no content
    // but have tool calls/results. Never merge the active streaming message:
    // it must keep its identity so it stays in the dynamic render area and can
    // show permission prompts outside Ink's <Static> scrollback.
    let mergedMsg: Message = { ...current };
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (next.role !== 'assistant') break;
      if (!isBlankAssistantContent(next.content)) break;
      if (next.id === streamingMessageId || handoffMessageIds.has(next.id)) break;
      mergedMsg = {
        ...mergedMsg,
        toolCalls: [...(mergedMsg.toolCalls ?? []), ...(next.toolCalls ?? [])],
        toolResults: [...(mergedMsg.toolResults ?? []), ...(next.toolResults ?? [])],
        nestedToolInvocations: [
          ...(mergedMsg.nestedToolInvocations ?? []),
          ...(next.nestedToolInvocations ?? []),
        ],
      };
      j++;
    }
    merged.push(mergedMsg);
    i = j;
  }
  return merged;
}

/**
 * Apply streaming-id changes and prune queue entries that no longer exist.
 * Pure — safe to run during render for React's "adjust state when props change" pattern.
 */
export function syncStaticHandoff(
  state: StaticHandoffState,
  streamingMessageId: string | null | undefined,
  messageIds: ReadonlySet<string>,
): StaticHandoffState {
  const normalizedStreaming = streamingMessageId ?? null;
  let withheldQueue = state.withheldQueue.filter((id) => messageIds.has(id));
  let observedStreamingId = state.observedStreamingId;

  if (normalizedStreaming !== observedStreamingId) {
    const previousId = observedStreamingId ?? null;
    if (
      previousId &&
      messageIds.has(previousId) &&
      previousId !== normalizedStreaming &&
      !withheldQueue.includes(previousId)
    ) {
      withheldQueue = [...withheldQueue, previousId];
    }
    observedStreamingId = normalizedStreaming;
  }

  // Drop the active streaming id from the queue if it was re-activated.
  if (normalizedStreaming) {
    withheldQueue = withheldQueue.filter((id) => id !== normalizedStreaming);
  }

  const next: StaticHandoffState = {
    observedStreamingId,
    withheldQueue,
  };
  return handoffStatesEqual(state, next) ? state : next;
}

/**
 * Release the queue head after its ownership-gap frame has committed.
 * One call → one FIFO release.
 */
export function advanceStaticHandoff(state: StaticHandoffState): StaticHandoffState {
  if (state.withheldQueue.length === 0) return state;
  return {
    ...state,
    withheldQueue: state.withheldQueue.slice(1),
  };
}

/** Partition message ids into disjoint active / withheld / static zones. */
export function partitionMessageZones(
  messageIds: readonly string[],
  streamingMessageId: string | null | undefined,
  withheldQueue: readonly string[],
): MessageZones {
  const activeId = streamingMessageId ?? null;
  const withheldIds = new Set(withheldQueue.filter((id) => id !== activeId));
  const staticIds = new Set<string>();
  for (const id of messageIds) {
    if (id === activeId) continue;
    if (withheldIds.has(id)) continue;
    staticIds.add(id);
  }
  return { activeId, withheldIds, staticIds };
}

export function assertDisjointZones(zones: MessageZones): boolean {
  if (zones.activeId && zones.withheldIds.has(zones.activeId)) return false;
  if (zones.activeId && zones.staticIds.has(zones.activeId)) return false;
  for (const id of zones.withheldIds) {
    if (zones.staticIds.has(id)) return false;
  }
  return true;
}

/**
 * Commit/effect-driven Static handoff ownership.
 * Returns the FIFO withheld id set for the current render.
 */
export function useStaticHandoff(
  streamingMessageId: string | null | undefined,
  messages: readonly { id: string }[],
): {
  withheldQueue: readonly string[];
  withheldIds: ReadonlySet<string>;
} {
  // Stabilize id-set identity on id list changes only (not content streaming).
  const messageIdKey = messages.map((message) => message.id).join('\0');
  const messageIds = useMemo(
    () => new Set(messageIdKey.length === 0 ? [] : messageIdKey.split('\0')),
    [messageIdKey],
  );

  const [state, setState] = useState(() => createStaticHandoffState(streamingMessageId));
  const streamingRef = useRef(streamingMessageId);
  const messageIdsRef = useRef(messageIds);
  streamingRef.current = streamingMessageId;
  messageIdsRef.current = messageIds;

  // React "adjusting state when props change" — enqueue previous streaming id
  // before paint so the first committed frame already withholds it (ownership gap).
  const synced = syncStaticHandoff(state, streamingMessageId, messageIds);
  if (synced !== state) {
    setState(synced);
  }

  const queueKey = synced.withheldQueue.join('\0');
  const queueLength = synced.withheldQueue.length;

  useEffect(() => {
    if (queueLength === 0) return;

    // Yield one task after the gap frame commits, then release the head into Static.
    // Deps are queue identity only so streaming content updates cannot cancel release.
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setState((current) => {
        const base = syncStaticHandoff(current, streamingRef.current, messageIdsRef.current);
        const next = advanceStaticHandoff(base);
        return handoffStatesEqual(next, current) ? current : next;
      });
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [queueKey, queueLength]);

  const withheldQueue = synced.withheldQueue;
  const withheldIds = useMemo(() => new Set(withheldQueue), [queueKey]);

  return { withheldQueue, withheldIds };
}
