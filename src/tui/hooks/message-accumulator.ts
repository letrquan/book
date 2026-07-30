import type { NestedToolInvocation, ToolCall, ToolResult } from '../../types/tools.js';
import {
  appendContentToMessage,
  appendReasoningToMessage,
  appendNestedToolInvocationToMessage,
  appendNestedToolResultToMessage,
  appendToolCallToMessage,
  appendToolResultToMessage,
} from './streaming-state.js';
import type { Message } from '../../types/messages.js';

/**
 * A single queued streaming operation.
 *
 * Text ops are coalesced during flush; tool call/result ops are applied
 * individually to preserve identity.
 */
export type AccumulatorOp =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'toolResult'; result: ToolResult }
  | { type: 'nestedToolCall'; invocation: NestedToolInvocation }
  | { type: 'nestedToolResult'; traceId: string; result: ToolResult };

/**
 * Batched message accumulator for streaming events.
 *
 * Collects text deltas, tool calls, and tool results in a queue and flushes
 * them on a bounded cadence. Consecutive text ops are coalesced into a single
 * appendContentToMessage call, and no timer stays active while the queue is idle.
 *
 * The flush callback is a `setMessages`-style state updater so React can
 * batch the update with other state changes.
 */
export interface MessageAccumulator {
  /** Queue a text delta (appended to the streaming message). */
  addText: (content: string) => void;
  /** Queue a provider-native reasoning delta. */
  addReasoning: (content: string) => void;
  /** Queue a tool call. */
  addToolCall: (call: ToolCall) => void;
  /** Queue a tool result. */
  addToolResult: (result: ToolResult) => void;
  /** Queue a display-only tool call from a Task subagent. */
  addNestedToolCall: (invocation: NestedToolInvocation) => void;
  /** Queue a result for a display-only subagent tool call. */
  addNestedToolResult: (traceId: string, result: ToolResult) => void;
  /** Flush all queued ops immediately (called by timer and stop). */
  flush: () => void;
  /** Enable scheduled flushing. Queued work starts the timer on demand. */
  start: () => void;
  /** Stop the timer, flush remaining ops. Idempotent. */
  stop: () => void;
  /** Stop the timer and drop queued ops without flushing. Idempotent. */
  discard: () => void;
}

interface AccumulatorState {
  queue: AccumulatorOp[];
  timerId: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  intervalMs: number;
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
  const state: AccumulatorState = {
    queue: [],
    timerId: null,
    stopped: false,
    intervalMs: flushIntervalMs,
  };

  function scheduleNext(): void {
    if (state.stopped || state.timerId !== null || state.queue.length === 0) return;
    state.timerId = setTimeout(() => {
      state.timerId = null;
      flush();
      scheduleNext();
    }, state.intervalMs);
  }

  function flush(): void {
    if (state.queue.length === 0) return;

    // Drain the queue so new ops added during setMessages are captured
    // in the next flush.
    const ops = state.queue;
    state.queue = [];

    // Coalesce consecutive text/reasoning ops into a single append operation.
    // Tool calls and results are applied individually.
    const coalesced: AccumulatorOp[] = [];
    for (const op of ops) {
      if (
        (op.type === 'text' || op.type === 'reasoning') &&
        coalesced.length > 0 &&
        coalesced[coalesced.length - 1].type === op.type
      ) {
        (
          coalesced[coalesced.length - 1] as { type: 'text' | 'reasoning'; content: string }
        ).content += op.content;
      } else {
        coalesced.push(op);
      }
    }

    if (coalesced.length === 0) return;

    const startedAt = performance.now();
    setMessages((prev: Message[]) => {
      let messageIndex = -1;
      for (let index = prev.length - 1; index >= 0; index--) {
        if (prev[index].id === messageId) {
          messageIndex = index;
          break;
        }
      }
      if (messageIndex < 0) return prev;

      let active = [prev[messageIndex]];
      for (const op of coalesced) {
        if (op.type === 'text') {
          active = appendContentToMessage(active, messageId, op.content);
        } else if (op.type === 'reasoning') {
          active = appendReasoningToMessage(active, messageId, op.content);
        } else if (op.type === 'toolCall') {
          active = appendToolCallToMessage(active, messageId, op.call);
        } else if (op.type === 'toolResult') {
          active = appendToolResultToMessage(active, messageId, op.result);
        } else if (op.type === 'nestedToolCall') {
          active = appendNestedToolInvocationToMessage(active, messageId, op.invocation);
        } else {
          active = appendNestedToolResultToMessage(active, messageId, op.traceId, op.result);
        }
      }
      if (active[0] === prev[messageIndex]) return prev;
      const next = prev.slice();
      next[messageIndex] = active[0];
      messagesRef.current = next;
      return next;
    });
    const transcriptPressure = Math.floor(messagesRef.current.length / 250) * 8;
    // React/Ink commits after the state setter returns. Sample on the next
    // macrotask so the cadence reflects actual render pressure, not just the
    // time spent constructing the next message array.
    setImmediate(() => {
      if (state.stopped) return;
      const renderPressure = performance.now() - startedAt;
      state.intervalMs = Math.min(
        48,
        Math.max(
          flushIntervalMs,
          Math.ceil(renderPressure * 1.5),
          flushIntervalMs + transcriptPressure,
        ),
      );
    });
  }

  function addText(content: string): void {
    if (state.stopped) return;
    state.queue.push({ type: 'text', content });
    scheduleNext();
  }

  function addReasoning(content: string): void {
    if (state.stopped) return;
    state.queue.push({ type: 'reasoning', content });
    scheduleNext();
  }

  function addToolCall(call: ToolCall): void {
    if (state.stopped) return;
    state.queue.push({ type: 'toolCall', call });
    scheduleNext();
  }

  function addToolResult(result: ToolResult): void {
    if (state.stopped) return;
    state.queue.push({ type: 'toolResult', result });
    scheduleNext();
  }

  function addNestedToolCall(invocation: NestedToolInvocation): void {
    if (state.stopped) return;
    state.queue.push({ type: 'nestedToolCall', invocation });
    scheduleNext();
  }

  function addNestedToolResult(traceId: string, result: ToolResult): void {
    if (state.stopped) return;
    state.queue.push({ type: 'nestedToolResult', traceId, result });
    scheduleNext();
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

  function discard(): void {
    state.stopped = true;
    state.queue = [];
    if (state.timerId !== null) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
  }

  return {
    addText,
    addReasoning,
    addToolCall,
    addToolResult,
    addNestedToolCall,
    addNestedToolResult,
    flush,
    start,
    stop,
    discard,
  };
}
