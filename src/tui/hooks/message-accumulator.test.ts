import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMessageAccumulator } from './message-accumulator.js';
import type { Message } from '../../types/messages.js';
import type { ToolCall } from '../../types/tools.js';
import { toolSuccess } from '../../tools/result.js';

function makeMsg(id: string, content: string): Message {
  return { id, role: 'assistant', content, includeInContext: true, timestamp: 1 };
}

function createTestAccumulator(intervalMs = 16) {
  let messages: Message[] = [makeMsg('assistant-1', '')];
  const messagesRef = { current: messages };
  const setMessages = vi.fn((updater: (prev: Message[]) => Message[]) => {
    messages = updater(messages);
    messagesRef.current = messages;
    return messages;
  });

  const acc = createMessageAccumulator('assistant-1', setMessages, messagesRef, intervalMs);
  return { acc, setMessages, getMessages: () => messages, messagesRef };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('message-accumulator', () => {
  it('coalesces text ops into a single appendContentToMessage', () => {
    const { acc, setMessages, getMessages } = createTestAccumulator();
    acc.start();

    acc.addText('He');
    acc.addText('llo');
    acc.addText(' World');

    // Advance past the flush interval.
    vi.advanceTimersByTime(20);

    expect(setMessages).toHaveBeenCalledTimes(1);
    expect(getMessages()[0].content).toBe('Hello World');
  });

  it('does not keep a timer alive while the stream is idle', () => {
    const { acc, setMessages } = createTestAccumulator();
    acc.start();

    expect(vi.getTimerCount()).toBe(0);
    acc.addText('queued');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(20);

    expect(setMessages).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies tool ops individually in FIFO order', () => {
    const { acc, setMessages, getMessages } = createTestAccumulator();
    acc.start();

    const tc1: ToolCall = { id: 'tc1', name: 'Read', arguments: { filePath: 'a.ts' } };
    const tc2: ToolCall = { id: 'tc2', name: 'Write', arguments: { filePath: 'b.ts' } };

    acc.addToolCall(tc1);
    acc.addToolCall(tc2);

    vi.advanceTimersByTime(20);

    expect(setMessages).toHaveBeenCalledTimes(1);
    expect(getMessages()[0].toolCalls).toHaveLength(2);
    expect(getMessages()[0].toolCalls![0].id).toBe('tc1');
    expect(getMessages()[0].toolCalls![1].id).toBe('tc2');
  });

  it('preserves file mutation diff metadata through an accumulator flush', () => {
    const { acc, getMessages } = createTestAccumulator();
    const diff = '@@ -1 +1 @@\n-old\n+new';
    acc.start();
    acc.addToolResult(
      toolSuccess(diff, {
        toolCallId: 'edit',
        artifacts: {
          fileMutation: {
            kind: 'update',
            filePath: 'src/a.ts',
            addedLines: 1,
            removedLines: 1,
          },
        },
      }),
    );

    vi.advanceTimersByTime(20);

    expect(getMessages()[0].toolResults?.[0]).toMatchObject({
      content: diff,
      artifacts: {
        fileMutation: {
          kind: 'update',
          filePath: 'src/a.ts',
          addedLines: 1,
          removedLines: 1,
        },
      },
    });
  });

  it('preserves FIFO order across mixed op types', () => {
    const { acc, getMessages } = createTestAccumulator();
    acc.start();

    acc.addText('before ');
    acc.addToolCall({ id: 'tc1', name: 'Read', arguments: {} });
    acc.addText(' after');

    vi.advanceTimersByTime(20);

    const msg = getMessages()[0];
    expect(msg.content).toBe('before  after');
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls![0].id).toBe('tc1');
  });

  it('streams nested tool calls and results in FIFO order', () => {
    const { acc, getMessages } = createTestAccumulator();
    acc.start();

    acc.addNestedToolCall({
      traceId: 'task/1:read',
      parentTraceId: 'task',
      call: { id: 'read', name: 'Read', arguments: { filePath: 'a.ts' } },
    });
    acc.addNestedToolCall({
      traceId: 'task/2:grep',
      parentTraceId: 'task',
      call: { id: 'grep', name: 'Grep', arguments: { pattern: 'x' } },
    });
    acc.addNestedToolResult('task/1:read', toolSuccess('a', { toolCallId: 'read' }));

    vi.advanceTimersByTime(20);

    expect(getMessages()[0].nestedToolInvocations?.map((item) => item.traceId)).toEqual([
      'task/1:read',
      'task/2:grep',
    ]);
    expect(getMessages()[0].nestedToolInvocations?.[0].result?.content).toBe('a');
    expect(getMessages()[0].nestedToolInvocations?.[1].result).toBeUndefined();
  });

  it('stop() flushes remaining ops', () => {
    const { acc, setMessages, getMessages } = createTestAccumulator();
    acc.start();

    acc.addText('final text');

    // stop before the timer fires
    acc.stop();

    expect(setMessages).toHaveBeenCalledTimes(1);
    expect(getMessages()[0].content).toBe('final text');
  });

  it('stop() is idempotent', () => {
    const { acc, setMessages } = createTestAccumulator();
    acc.start();
    acc.addText('x');
    acc.stop();
    const callCount = setMessages.mock.calls.length;
    acc.stop();
    expect(setMessages).toHaveBeenCalledTimes(callCount);
  });

  it('discard() drops queued ops without flushing', () => {
    const { acc, setMessages, getMessages } = createTestAccumulator();
    acc.start();
    acc.addText('discard me');
    acc.discard();
    vi.advanceTimersByTime(20);
    expect(setMessages).not.toHaveBeenCalled();
    expect(getMessages()[0].content).toBe('');
  });

  it('flush() clears queue so subsequent flush is a no-op', () => {
    const { acc, setMessages } = createTestAccumulator();
    acc.start();

    acc.addText('hello');
    vi.advanceTimersByTime(20);

    const callCount = setMessages.mock.calls.length;
    // Advance again — queue is empty, no new ops
    vi.advanceTimersByTime(20);
    expect(setMessages).toHaveBeenCalledTimes(callCount);
  });

  it('no-ops produce no flush call on stop', () => {
    const { acc, setMessages } = createTestAccumulator();
    acc.start();
    acc.stop();
    // No ops were added, so flush should be a no-op (no setMessages call)
    // Actually flush IS called but drains an empty queue — setMessages only called when queue non-empty
    expect(setMessages).not.toHaveBeenCalled();
  });

  it('multiple timer ticks flush independently', () => {
    const { acc, setMessages, getMessages } = createTestAccumulator();
    acc.start();

    acc.addText('first');
    vi.advanceTimersByTime(20);
    expect(getMessages()[0].content).toBe('first');

    acc.addText(' second');
    vi.advanceTimersByTime(20);
    expect(getMessages()[0].content).toBe('first second');

    expect(setMessages.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('start() after stop() works correctly', () => {
    const { acc, setMessages, getMessages } = createTestAccumulator();
    acc.start();

    acc.addText('batch1');
    acc.stop();
    expect(getMessages()[0].content).toBe('batch1');

    acc.start();
    acc.addText(' batch2');
    vi.advanceTimersByTime(20);
    expect(getMessages()[0].content).toBe('batch1 batch2');

    // Should have been called at least twice (stop flush + timer flush)
    expect(setMessages.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('messagesRef is kept in sync after each flush', () => {
    const { acc, messagesRef } = createTestAccumulator();
    acc.start();

    acc.addText('synced');
    vi.advanceTimersByTime(20);

    expect(messagesRef.current[0].content).toBe('synced');
  });

  it('adds are ignored after stop', () => {
    const { acc, setMessages, getMessages } = createTestAccumulator();
    acc.start();
    acc.stop();
    const callCount = setMessages.mock.calls.length;

    acc.addText('ignored');
    acc.addToolCall({ id: 'tc1', name: 'Read', arguments: {} });
    acc.addToolResult(toolSuccess('ok', { toolCallId: 'tc1' }));

    vi.advanceTimersByTime(20);
    expect(setMessages).toHaveBeenCalledTimes(callCount);
    expect(getMessages()[0].content).toBe('');
  });

  it('upserts repeated tool call/result ops by stable id on flush', () => {
    const { acc, getMessages } = createTestAccumulator();
    acc.start();

    acc.addToolCall({ id: 'tc1', name: 'Read', arguments: { filePath: 'a.ts' } });
    acc.addToolCall({ id: 'tc1', name: 'Read', arguments: { filePath: 'b.ts' } });
    acc.addToolResult(toolSuccess('v1', { toolCallId: 'tc1' }));
    acc.addToolResult(toolSuccess('v2', { toolCallId: 'tc1' }));
    acc.addNestedToolCall({
      traceId: 'task/1:read',
      parentTraceId: 'task',
      call: { id: 'read', name: 'Read', arguments: { filePath: 'a.ts' } },
    });
    acc.addNestedToolCall({
      traceId: 'task/1:read',
      parentTraceId: 'task',
      call: { id: 'read', name: 'Read', arguments: { filePath: 'a.ts', offset: 2 } },
    });
    acc.addNestedToolResult('task/1:read', toolSuccess('nested-v1', { toolCallId: 'read' }));
    acc.addNestedToolResult('task/1:read', toolSuccess('nested-v2', { toolCallId: 'read' }));

    vi.advanceTimersByTime(20);

    const msg = getMessages()[0];
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls?.[0].arguments).toEqual({ filePath: 'b.ts' });
    expect(msg.toolResults).toHaveLength(1);
    expect(msg.toolResults?.[0].content).toBe('v2');
    expect(msg.nestedToolInvocations).toHaveLength(1);
    expect(msg.nestedToolInvocations?.[0].call.arguments).toEqual({
      filePath: 'a.ts',
      offset: 2,
    });
    expect(msg.nestedToolInvocations?.[0].result?.content).toBe('nested-v2');
  });
});
