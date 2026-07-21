import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  appendContentToMessage,
  appendNestedToolInvocationToMessage,
  appendNestedToolResultToMessage,
  appendToolCallToMessage,
  appendToolResultToMessage,
  isTotallyEmptyAssistant,
  makeMessage,
  removeTrailingEmptyAssistantPlaceholder,
} from './streaming-state.js';
import type { Message } from '../../types.js';
import { toolFailure, toolSuccess } from '../../tools/result.js';

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
  return { id, role, content, includeInContext: true, timestamp: 1 };
}

describe('streaming TUI message state helpers', () => {
  it('creates a user message and assistant placeholder without replacing history', () => {
    const history = [msg('old-user', 'user', 'old'), msg('old-assistant', 'assistant', 'answer')];
    const user = makeMessage('user', 'new prompt');
    const assistant = makeMessage('assistant', '');
    const next = [...history, user, assistant];

    expect(user.includeInContext).toBe(false);
    expect(assistant.includeInContext).toBe(false);
    expect(makeMessage('user', 'provider prompt', undefined, true).includeInContext).toBe(true);
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

  it('keeps text append-only and ignores empty deltas', () => {
    const messages = [msg('assistant-1', 'assistant', 'Hi')];
    const same = appendContentToMessage(messages, 'assistant-1', '');
    expect(same).toBe(messages);
    const next = appendContentToMessage(messages, 'assistant-1', ' there');
    expect(next[0].content).toBe('Hi there');
    expect(messages[0].content).toBe('Hi');
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
    messages = appendToolResultToMessage(
      messages,
      'assistant-1',
      toolSuccess('contents', { toolCallId: 'call-1' }),
    );
    messages = appendContentToMessage(messages, 'assistant-2', ' final');

    expect(messages[0].toolCalls?.map((tc) => tc.id)).toEqual(['call-1']);
    expect(messages[0].toolResults?.map((tr) => tr.toolCallId)).toEqual(['call-1']);
    expect(messages[1]).not.toHaveProperty('toolCalls');
    expect(messages[1].content).toBe('turn 2 final');
  });

  it('upserts top-level tool calls and results by stable id', () => {
    let messages = [msg('assistant-1', 'assistant', '')];
    messages = appendToolCallToMessage(messages, 'assistant-1', {
      id: 'call-1',
      name: 'Read',
      arguments: { filePath: 'a.ts' },
    });
    messages = appendToolCallToMessage(messages, 'assistant-1', {
      id: 'call-1',
      name: 'Read',
      arguments: { filePath: 'b.ts' },
    });
    messages = appendToolCallToMessage(messages, 'assistant-1', {
      id: 'call-2',
      name: 'Write',
      arguments: { filePath: 'c.ts' },
    });
    messages = appendToolResultToMessage(
      messages,
      'assistant-1',
      toolSuccess('first', { toolCallId: 'call-1' }),
    );
    messages = appendToolResultToMessage(
      messages,
      'assistant-1',
      toolSuccess('updated', { toolCallId: 'call-1' }),
    );
    messages = appendToolResultToMessage(
      messages,
      'assistant-1',
      toolFailure('err', { toolCallId: 'call-2' }),
    );

    expect(messages[0].toolCalls).toHaveLength(2);
    expect(messages[0].toolCalls?.[0]).toEqual({
      id: 'call-1',
      name: 'Read',
      arguments: { filePath: 'b.ts' },
    });
    expect(messages[0].toolCalls?.[1].id).toBe('call-2');
    expect(messages[0].toolResults).toHaveLength(2);
    expect(messages[0].toolResults?.[0].content).toBe('updated');
    expect(messages[0].toolResults?.[1].toolCallId).toBe('call-2');
  });

  it('preserves file mutation diff metadata while upserting tool results', () => {
    const diff = '@@ -1 +1 @@\n-old\n+new';
    let messages = [msg('assistant-1', 'assistant', '')];
    messages = appendToolResultToMessage(
      messages,
      'assistant-1',
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

    expect(messages[0].toolResults?.[0]).toMatchObject({
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
    messages = appendNestedToolResultToMessage(
      messages,
      'assistant-1',
      'task-b/1:duplicate',
      toolSuccess('b', { toolCallId: 'duplicate' }),
    );

    expect(messages[0].nestedToolInvocations).not.toBe(before);
    expect(messages[0].nestedToolInvocations?.[0].result).toBeUndefined();
    expect(messages[0].nestedToolInvocations?.[1].result?.content).toBe('b');
  });

  it('upserts nested invocations by trace id and preserves existing results', () => {
    let messages = [msg('assistant-1', 'assistant', '')];
    messages = appendNestedToolInvocationToMessage(messages, 'assistant-1', {
      traceId: 'task/1:read',
      parentTraceId: 'task',
      call: { id: 'read', name: 'Read', arguments: { filePath: 'a.ts' } },
    });
    messages = appendNestedToolResultToMessage(
      messages,
      'assistant-1',
      'task/1:read',
      toolSuccess('a', { toolCallId: 'read' }),
    );
    // Re-emit the same invocation (e.g. retry/update) without a result payload.
    messages = appendNestedToolInvocationToMessage(messages, 'assistant-1', {
      traceId: 'task/1:read',
      parentTraceId: 'task',
      call: { id: 'read', name: 'Read', arguments: { filePath: 'a.ts', offset: 10 } },
    });
    // Re-emit result with new payload — replace in place.
    messages = appendNestedToolResultToMessage(
      messages,
      'assistant-1',
      'task/1:read',
      toolSuccess('a-updated', { toolCallId: 'read' }),
    );

    expect(messages[0].nestedToolInvocations).toHaveLength(1);
    expect(messages[0].nestedToolInvocations?.[0].call.arguments).toEqual({
      filePath: 'a.ts',
      offset: 10,
    });
    expect(messages[0].nestedToolInvocations?.[0].result?.content).toBe('a-updated');
  });

  it('detects totally-empty assistant placeholders and removes only a trailing one', () => {
    const empty = msg('a-empty', 'assistant', '');
    const partial = msg('a-partial', 'assistant', 'hi');
    const withTools: Message = {
      ...msg('a-tools', 'assistant', ''),
      toolCalls: [{ id: 'c1', name: 'Read', arguments: {} }],
    };
    const withNested: Message = {
      ...msg('a-nested', 'assistant', ''),
      nestedToolInvocations: [
        {
          traceId: 't/1',
          parentTraceId: 't',
          call: { id: 'c1', name: 'Read', arguments: {} },
        },
      ],
    };

    expect(isTotallyEmptyAssistant(empty)).toBe(true);
    expect(isTotallyEmptyAssistant(partial)).toBe(false);
    expect(isTotallyEmptyAssistant(withTools)).toBe(false);
    expect(isTotallyEmptyAssistant(withNested)).toBe(false);
    expect(isTotallyEmptyAssistant(msg('u', 'user', ''))).toBe(false);

    const history = [msg('u1', 'user', 'q'), empty];
    expect(removeTrailingEmptyAssistantPlaceholder(history).map((m) => m.id)).toEqual(['u1']);

    const keepPartial = [msg('u1', 'user', 'q'), partial];
    expect(removeTrailingEmptyAssistantPlaceholder(keepPartial)).toBe(keepPartial);

    const keepTools = [msg('u1', 'user', 'q'), withTools];
    expect(removeTrailingEmptyAssistantPlaceholder(keepTools)).toBe(keepTools);

    // Non-trailing empty must stay (only trailing is safe to drop).
    const nonTrailing = [empty, msg('u2', 'user', 'later')];
    expect(removeTrailingEmptyAssistantPlaceholder(nonTrailing)).toBe(nonTrailing);
  });
});
