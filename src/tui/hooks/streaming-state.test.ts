import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  appendContentToMessage,
  appendNestedToolInvocationToMessage,
  appendNestedToolResultToMessage,
  appendToolCallToMessage,
  appendToolResultToMessage,
  makeMessage,
} from './streaming-state.js';
import type { Message } from '../../types.js';

beforeEach(() => {
  vi.spyOn(crypto, 'randomUUID')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
    .mockReturnValueOnce('00000000-0000-4000-8000-000000000003');
});

afterEach(() => {
  vi.restoreAllMocks();
});

function msg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: 1 };
}

describe('streaming TUI message state helpers', () => {
  it('creates a user message and assistant placeholder without replacing history', () => {
    const history = [msg('old-user', 'user', 'old'), msg('old-assistant', 'assistant', 'answer')];
    const user = makeMessage('user', 'new prompt');
    const assistant = makeMessage('assistant', '');
    const next = [...history, user, assistant];

    expect(next.map((m) => [m.id, m.role, m.content])).toEqual([
      ['old-user', 'user', 'old'],
      ['old-assistant', 'assistant', 'answer'],
      ['00000000-0000-4000-8000-000000000001', 'user', 'new prompt'],
      ['00000000-0000-4000-8000-000000000002', 'assistant', ''],
    ]);
  });

  it('appends streamed text only to the targeted assistant message', () => {
    const messages = [msg('assistant-0', 'assistant', 'old'), msg('assistant-1', 'assistant', '')];
    const next = appendContentToMessage(
      appendContentToMessage(messages, 'assistant-1', 'Hel'),
      'assistant-1',
      'lo',
    );

    expect(next.map((m) => m.content)).toEqual(['old', 'Hello']);
    expect(messages.map((m) => m.content)).toEqual(['old', '']);
  });

  it('keeps multi-turn tool calls and results on their originating assistant turn', () => {
    let messages = [
      msg('assistant-1', 'assistant', 'turn 1'),
      msg('assistant-2', 'assistant', 'turn 2'),
    ];
    messages = appendToolCallToMessage(messages, 'assistant-1', {
      id: 'call-1',
      name: 'Read',
      arguments: { filePath: 'a.ts' },
    });
    messages = appendToolResultToMessage(messages, 'assistant-1', {
      toolCallId: 'call-1',
      success: true,
      output: 'contents',
    });
    messages = appendContentToMessage(messages, 'assistant-2', ' final');

    expect(messages[0].toolCalls?.map((tc) => tc.id)).toEqual(['call-1']);
    expect(messages[0].toolResults?.map((tr) => tr.toolCallId)).toEqual(['call-1']);
    expect(messages[1]).not.toHaveProperty('toolCalls');
    expect(messages[1].content).toBe('turn 2 final');
  });

  it('attaches nested results by trace id without confusing duplicate provider ids', () => {
    let messages = [msg('assistant-1', 'assistant', '')];
    messages = appendNestedToolInvocationToMessage(messages, 'assistant-1', {
      traceId: 'task-a/1:duplicate',
      parentTraceId: 'task-a',
      call: { id: 'duplicate', name: 'Read', arguments: { filePath: 'a.ts' } },
    });
    messages = appendNestedToolInvocationToMessage(messages, 'assistant-1', {
      traceId: 'task-b/1:duplicate',
      parentTraceId: 'task-b',
      call: { id: 'duplicate', name: 'Read', arguments: { filePath: 'b.ts' } },
    });
    const before = messages[0].nestedToolInvocations;
    messages = appendNestedToolResultToMessage(messages, 'assistant-1', 'task-b/1:duplicate', {
      toolCallId: 'duplicate',
      success: true,
      output: 'b',
    });

    expect(messages[0].nestedToolInvocations).not.toBe(before);
    expect(messages[0].nestedToolInvocations?.[0].result).toBeUndefined();
    expect(messages[0].nestedToolInvocations?.[1].result?.output).toBe('b');
  });
});
