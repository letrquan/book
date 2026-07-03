import type { ToolCall, ToolResult } from '../../types.js';
import {
  appendContentToMessage,
  appendToolCallToMessage,
  appendToolResultToMessage,
} from './streaming-state.js';
import type { Message } from '../../types.js';

/**
 * A single queued streaming operation.
 *
 * Text ops are coalesced during flush; tool call/result ops are applied
 * individually to preserve identity.
 */
export type AccumulatorOp =
  | { type: 'text'; content: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'toolResult'; result: ToolResult };

/**
 * Batched message accumulator for streaming events.
 *
 * Collects text deltas, tool calls, and tool results in a queue and flushes
 * them at a fixed interval (~16ms = 60fps). Consecutive text ops are
 * coalesced into a single appendContentToMessage call.
 *
 * The flush callback is a `setMessages`-style state updater so React can
 * batch the update with other state changes.
 */
export interface MessageAccumulator {
  /** Queue a text delta (appended to the streaming message). */
  addText: (content: string) => void;
  /** Queue a tool call. */
  addToolCall: (call: ToolCall) => void;
  /** Queue a tool result. */
  addToolResult: (result: ToolResult) => void;
  /** Flush all queued ops immediately (called by timer and stop). */
  flush: () => void;
  /** Start the periodic flush timer. */
  start: () => void;
  /** Stop the timer, flush remaining ops. Idempotent. */
  stop: () => void;
}

interface AccumulatorState {
  queue: AccumulatorOp[];
  timerId: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

/**
 * Create a message accumulator for the given message ID.
 *
 * @param messageId      - ID of the assistant message being streamed into.
 * @param setMessages    - React state setter (updater form).
 * @param messagesRef    - Mutable ref mirror of the messages array, kept in sync.
 * @param flushIntervalMs - Flush cadence in milliseconds (default 16 ≈ 60fps).
 */
export function createMessageAccumulator(
  messageId: string,
  setMessages: (updater: (prev: Message[]) => Message[]) => void,
  messagesRef: { current: Message[] },
  flushIntervalMs = 16,
): MessageAccumulator {
  const state: AccumulatorState = { queue: [], timerId: null, stopped: false };

  function scheduleNext(): void {
    if (state.stopped) return;
    state.timerId = setTimeout(() => {
      flush();
      scheduleNext();
    }, flushIntervalMs);
  }

  function flush(): void {
    if (state.queue.length === 0) return;

    // Drain the queue so new ops added during setMessages are captured
    // in the next flush.
    const ops = state.queue;
    state.queue = [];

    // Coalesce consecutive text ops into a single appendContentToMessage call.
    // Tool calls and results are applied individually.
    const coalesced: AccumulatorOp[] = [];
    for (const op of ops) {
      if (
        op.type === 'text' &&
        coalesced.length > 0 &&
        coalesced[coalesced.length - 1].type === 'text'
      ) {
        (coalesced[coalesced.length - 1] as { type: 'text'; content: string }).content +=
          op.content;
      } else {
        coalesced.push(op);
      }
    }

    if (coalesced.length === 0) return;

    setMessages((prev: Message[]) => {
      let next = prev;
      for (const op of coalesced) {
        if (op.type === 'text') {
          next = appendContentToMessage(next, messageId, op.content);
        } else if (op.type === 'toolCall') {
          next = appendToolCallToMessage(next, messageId, op.call);
        } else {
          next = appendToolResultToMessage(next, messageId, op.result);
        }
      }
      messagesRef.current = next;
      return next;
    });
  }

  function addText(content: string): void {
    if (state.stopped) return;
    state.queue.push({ type: 'text', content });
  }

  function addToolCall(call: ToolCall): void {
    if (state.stopped) return;
    state.queue.push({ type: 'toolCall', call });
  }

  function addToolResult(result: ToolResult): void {
    if (state.stopped) return;
    state.queue.push({ type: 'toolResult', result });
  }

  function start(): void {
    state.stopped = false;
    scheduleNext();
  }

  function stop(): void {
    if (state.stopped) return;
    state.stopped = true;
    if (state.timerId !== null) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    // Final flush of any remaining ops and pending text.
    flush();
  }

  return { addText, addToolCall, addToolResult, flush, start, stop };
}
