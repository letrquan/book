import { describe, expect, it } from 'vitest';
import type { Message, NestedToolInvocation } from '../types.js';
import { indexNestedToolInvocations, selectActiveToolId } from './tool-traces.js';

function assistant(overrides: Partial<Message>): Message {
  return { id: 'assistant', role: 'assistant', content: '', timestamp: 1, ...overrides };
}

function nested(traceId: string, parentTraceId: string, done = false): NestedToolInvocation {
  return {
    traceId,
    parentTraceId,
    call: { id: traceId, name: 'Read', arguments: {} },
    result: done ? { toolCallId: traceId, success: true, output: '' } : undefined,
  };
}

describe('tool traces', () => {
  it('indexes children by parent while preserving event order', () => {
    const index = indexNestedToolInvocations([
      nested('a', 'root'),
      nested('b', 'other'),
      nested('c', 'root'),
    ]);

    expect(index.get('root')?.map((item) => item.traceId)).toEqual(['a', 'c']);
    expect(index.get('other')?.map((item) => item.traceId)).toEqual(['b']);
  });

  it('prefers the latest unfinished nested invocation', () => {
    expect(
      selectActiveToolId(
        assistant({
          toolCalls: [{ id: 'root', name: 'Task', arguments: {} }],
          nestedToolInvocations: [nested('first', 'root'), nested('latest', 'root')],
        }),
      ),
    ).toBe('latest');
  });

  it('falls back to the latest unfinished top-level tool', () => {
    expect(
      selectActiveToolId(
        assistant({
          toolCalls: [
            { id: 'done', name: 'Read', arguments: {} },
            { id: 'running', name: 'Bash', arguments: {} },
          ],
          toolResults: [{ toolCallId: 'done', success: true, output: '' }],
          nestedToolInvocations: [nested('nested-done', 'done', true)],
        }),
      ),
    ).toBe('running');
  });

  it('returns null when all tools are complete', () => {
    expect(
      selectActiveToolId(
        assistant({
          toolCalls: [{ id: 'done', name: 'Read', arguments: {} }],
          toolResults: [{ toolCallId: 'done', success: true, output: '' }],
          nestedToolInvocations: [nested('nested-done', 'done', true)],
        }),
      ),
    ).toBeNull();
  });
});
